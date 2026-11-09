import { spawn, type ChildProcess } from "node:child_process";
import {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  decodeFrames,
  encodeMessage,
  parseMessage,
  type EventMessage,
  type Message,
  type ReadyMessage,
  type Request,
  type InvokeMessage,
} from "./protocol.ts";
import type { RemoteRuntimeHandshake } from "./runtime-contract.ts";
import type { RemoteExecutionSettings } from "./omp/execution-settings.ts";
import type { JobCapturePayload } from "./omp/job-capture.ts";

/** The host-visible message reconstructed from a serialized worker error. */
export function remoteErrorMessage(error: { name: string; message: string }): string {
  return `${error.name}: ${error.message}`;
}

export type SpawnSpec = {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** @internal Only owner IPC callbacks return transport delivery acknowledgements. */
  delivery?: "acknowledged";
};

export interface RemoteInitializeOptions {
  sessionId?: string;
  settings?: RemoteExecutionSettings;
  outReplies?: boolean;
  taskDepth?: number;
  signal?: AbortSignal;
  resourceBinding?: string;
}

export interface RemoteExecuteOptions {
  toolNames?: readonly string[];
  steeringSignal?: AbortSignal;
  bashScope?: "job" | "session";
  onCapture?: (capture: JobCapturePayload) => void;
  onInvoke?: HostToolInvoker;
}

export interface RemoteRuntimeClientApi {
  initialize(cwd: string, handshake: RemoteRuntimeHandshake, timeoutMs?: number, options?: RemoteInitializeOptions): Promise<ReadyMessage>;
  execute(tool: string, toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void, options?: RemoteExecuteOptions): Promise<unknown>;
  stopService(name: string, instanceId: string): Promise<unknown>;
  close(timeoutMs?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<number | null>;
  onEvent(listener: (event: EventMessage) => void | Promise<void>): () => void;
  onClose(listener: (error: Error) => void): () => void;
  readonly isClosed: boolean;
  activateEvents?(): void;
}

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onUpdate?: (update: unknown) => unknown;
  onCapture?: (capture: JobCapturePayload) => unknown;
  tool?: string;
  signal?: AbortSignal;
  onInvoke?: HostToolInvoker;
  invocationIds?: Set<string>;
};

export type HostToolInvoker = (
  invocation: InvokeMessage,
  signal: AbortSignal,
  onUpdate: (value: unknown) => void,
) => Promise<unknown>;
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A signal after output EOF is usually the client's own stop of a worker that lost its channel. */
function exitError(code: number | null, signal: NodeJS.Signals | null, outputEnded: boolean): Error {
  if (code !== null || !signal) return new Error(`Remote runtime exited with code ${code}`);
  return new Error(outputEnded
    ? `Remote runtime output stream ended; worker stopped by ${signal}`
    : `Remote runtime exited on signal ${signal}`);
}

export class RemoteRuntimeClient implements RemoteRuntimeClientApi {
  readonly #process: ChildProcess;
  readonly #acknowledgedDelivery: boolean;
  readonly #pending = new Map<string, PendingCall>();
  readonly #ready: Promise<ReadyMessage>;
  #resolveReady?: (message: ReadyMessage) => void;
  #rejectReady?: (error: Error) => void;
  #closed = false;
  #exited = false;
  #killSent = false;
  #outputEnded = false;
  #closePromise?: Promise<void>;
  #nextId = 1;
  readonly #exitPromise: Promise<number | null>;
  readonly #stdoutRead: Promise<void>;
  #finishStdout?: () => void;
  #exitDrain?: Promise<void>;
  readonly #eventListeners = new Set<(event: EventMessage) => void | Promise<void>>();
  readonly #closeListeners = new Set<(error: Error) => void>();
  readonly #invocations = new Map<string, { parentId: string; controller: AbortController }>();

  onClose(listener: (error: Error) => void): () => void {
    if (this.#closed) listener(new Error("Remote transport is closed"));
    else this.#closeListeners.add(listener);
    return () => { this.#closeListeners.delete(listener); };
  }

  /** Subscribe to unsolicited worker events; returns an unsubscribe. */
  onEvent(listener: (event: EventMessage) => void | Promise<void>): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  constructor(spec: SpawnSpec) {
    this.#acknowledgedDelivery = spec.delivery === "acknowledged";
    const [file, ...args] = spec.command;
    this.#process = spawn(file, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#ready = new Promise<ReadyMessage>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // Client may be killed before initialize() attaches a consumer; keep the
    // ready rejection from becoming an unhandled fatal session error.
    void this.#ready.catch(() => {});
    const exit = Promise.withResolvers<number | null>();
    this.#exitPromise = exit.promise;
    this.#process.once("exit", (code, signal) => {
      this.#exited = true;
      exit.resolve(code);
      this.#settleAfterOutputDrain(code, signal);
    });
    // Failed spawns have no process and do not emit an exit event.
    this.#process.once("error", (error) => {
      if (this.#process.pid === undefined) {
        this.#exited = true;
        exit.resolve(null);
      }
      this.#terminate(error);
    });
    this.#process.once("close", (code, signal) => {
      this.#settleAfterOutputDrain(code, signal);
    });
    this.#process.stdin?.on("error", (error) => this.#terminate(error));
    this.#stdoutRead = this.#readStdout();
    void this.#stdoutRead.catch((error) => this.#terminate(error));
    void this.#readStderr().catch((error) => this.#terminate(error));
  }

  /** Resolves on process exit, independently of protocol/stream closure. */
  waitForExit(): Promise<number | null> {
    return this.#exitPromise;
  }

  async initialize(
    cwd: string,
    handshake: RemoteRuntimeHandshake,
    timeoutMs = 15_000,
    options: RemoteInitializeOptions = {},
  ): Promise<ReadyMessage> {
    const abort = () => {
      const error = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("Remote runtime initialization aborted");
      this.#terminate(error);
      return error;
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) throw abort();
      this.#send({
        type: "initialize",
        protocolVersion: PROTOCOL_VERSION,
        host: handshake.host,
        ...(handshake.host === "omp"
          ? { ompVersion: handshake.hostVersion }
          : {}),
        hostVersion: handshake.hostVersion,
        runtimeVersion: handshake.runtimeVersion,
        ...(handshake.editMode ? { editMode: handshake.editMode } : {}),
        ...(handshake.bashServices !== undefined ? { bashServices: handshake.bashServices } : {}),
        cwd,
        tools: [...handshake.requestedTools],
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.resourceBinding !== undefined ? { resourceBinding: options.resourceBinding } : {}),
        ...(options.outReplies !== undefined ? { outReplies: options.outReplies } : {}),
        ...(options.taskDepth !== undefined ? { taskDepth: options.taskDepth } : {}),
        ...(options.settings && Object.keys(options.settings).length > 0
          ? { settings: options.settings }
          : {}),
      });
      const ready = await withTimeout(
        this.#ready,
        timeoutMs,
        `Remote runtime initialization timed out after ${timeoutMs}ms`,
      );
      if (ready.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `Remote runtime protocol mismatch: protocol=${ready.protocolVersion}`,
        );
      }
      if (options.resourceBinding !== undefined && ready.resourceBinding !== options.resourceBinding) {
        throw new Error("Remote runtime resource binding mismatch");
      }
      await handshake.validateReady(ready);
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("Remote runtime initialization aborted");
      }
      if (this.#closed) throw new Error("Remote runtime closed");
      return ready;
    } catch (error) {
      // close() intentionally rejects ready while graceful shutdown is pending.
      // Fatal/abort paths already terminate themselves; do not turn a normal
      // shutdown into SIGTERM merely because initialize observes its closure.
      if (!this.#closed) this.#terminate(error);
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async execute(
    tool: string,
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    options: RemoteExecuteOptions = {},
  ): Promise<unknown> {
    if (this.#closed) throw new Error("Remote runtime is disconnected");
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error("Operation aborted");
    }
    const id = `req_${this.#nextId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onUpdate, onCapture: options.onCapture, tool, signal, onInvoke: options.onInvoke });
    });
    const abortHandler = () => {
      for (const call of this.#invocations.values()) {
        if (call.parentId === id) call.controller.abort(signal?.reason ?? new Error("Remote Eval cancelled"));
      }
      if (this.#pending.has(id)) {
        try {
          this.#send({ type: "cancel", id });
        } catch {}
      }
    };
    const steerHandler = () => {
      if (this.#pending.has(id)) {
        try { this.#send({ type: "steer", id }); } catch {}
      }
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      this.#send({
        type: "execute",
        id,
        toolCallId,
        tool,
        args,
        ...(options.toolNames ? { toolNames: [...options.toolNames] } : {}),
        ...(options.steeringSignal ? { steering: true } : {}),
        ...(options.bashScope ? { bashScope: options.bashScope } : {}),
      });
      options.steeringSignal?.addEventListener("abort", steerHandler, { once: true });
      if (options.steeringSignal?.aborted) steerHandler();
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      options.steeringSignal?.removeEventListener("abort", steerHandler);
      this.#pending.delete(id);
      for (const call of this.#invocations.values()) {
        if (call.parentId === id) call.controller.abort(new Error("Remote Eval parent call settled"));
      }
    }
  }

  /** Stop only the acknowledged broker instance, never a later same-name service. */
  async stopService(name: string, instanceId: string): Promise<unknown> {
    if (this.#closed) throw new Error("Remote runtime is disconnected");
    const id = `req_${this.#nextId++}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    try {
      this.#send({ type: "service-stop", id, name, instanceId });
      return await withTimeout(promise, 15_000, `Remote service ${name} cleanup timed out`);
    } finally {
      this.#pending.delete(id);
    }
  }

  close(timeoutMs = 10_000): Promise<void> {
    return this.#closePromise ??= this.#shutdown(timeoutMs);
  }

  async #shutdown(timeoutMs: number): Promise<void> {
    const graceful = !this.#closed;
    try {
      if (graceful) {
        this.#send({ type: "shutdown" });
        this.#process.stdin?.end();
        this.#close(new Error("Remote runtime closed"));
      }
      const code = await withTimeout(
        this.#exitPromise,
        timeoutMs,
        `Remote runtime shutdown timed out after ${timeoutMs}ms`,
      );
      if (graceful && code !== 0) throw new Error(`Remote runtime cleanup failed (exit ${code})`);
    } catch (error) {
      this.#terminate(error);
      throw error;
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.#terminate(new Error("Remote runtime killed"), signal);
  }

  #send(message: Request): void {
    if (this.#closed) throw new Error("Remote runtime is disconnected");
    this.#process.stdin?.write(encodeMessage(message));
  }

  async #readStdout(): Promise<void> {
    const stdout = this.#process.stdout;
    if (!stdout) return;
    // Read the pipe independently of delivery ACKs. Otherwise a withheld capture
    // callback can stop the worker flushing its final result before process exit.
    let chunks: Uint8Array[] = [];
    let queuedBytes = 0;
    let snapshotBytes = 0;
    let ended = false;
    let failure: Error | undefined;
    let changed = Promise.withResolvers<void>();
    const finish = () => {
      ended = true;
      changed.resolve();
    };
    this.#finishStdout = () => {
      // Freeze a finite readable snapshot after exit. Later descendant writes
      // cannot extend this boundary, even if they keep the descriptor active.
      stdout.pause();
      snapshotBytes = stdout.readableLength;
      finish();
    };
    const onData = (chunk: Buffer) => {
      if (ended) return;
      chunks.push(chunk);
      queuedBytes += chunk.byteLength;
      if (queuedBytes >= MAX_FRAME_BYTES) stdout.pause();
      changed.resolve();
    };
    const onEnd = () => {
      this.#outputEnded = true;
      finish();
    };
    const onError = (error: Error) => {
      failure = error;
      finish();
    };
    stdout.on("data", onData);
    stdout.once("end", onEnd);
    stdout.once("error", onError);
    async function* input(source: NonNullable<ChildProcess["stdout"]>): AsyncGenerator<Uint8Array> {
      while (chunks.length > 0 || snapshotBytes > 0 || !ended) {
        if (chunks.length > 0) {
          const chunk = chunks.shift()!;
          yield chunk;
          queuedBytes -= chunk.byteLength;
          if (!ended && queuedBytes <= MAX_FRAME_BYTES / 2) source.resume();
        } else if (snapshotBytes > 0) {
          // Data events from this explicit read are ignored after finish().
          // Never read beyond the byte count frozen at the exit boundary.
          const chunk = source.read(snapshotBytes) as Buffer | null;
          if (!chunk) throw new Error("Remote runtime stdout snapshot became unavailable");
          snapshotBytes -= chunk.byteLength;
          yield chunk;
        } else if (!ended) {
          await changed.promise;
          changed = Promise.withResolvers<void>();
        }
      }
      if (failure) throw failure;
    }
    try {
      for await (const line of decodeFrames(input(stdout))) {
        if (line.trim()) await this.#handle(parseMessage(line));
      }
      // Real EOF makes further results impossible even if the worker ignores
      // SIGTERM. Settle the protocol now; waitForExit still tracks actual exit.
      // Synthetic exit snapshots retain the shared process-exit drain fence.
      if (this.#outputEnded && !this.#closed && !this.#exited) {
        this.#terminate(new Error("Remote runtime output stream ended"));
      }
    } finally {
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      stdout.off("error", onError);
      this.#finishStdout = undefined;
    }
  }

  #settleAfterOutputDrain(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exitDrain) return;
    this.#exitDrain = (async () => {
      // One read turn admits already-written pipe data without waiting for EOF.
      // Then freeze the readable backlog: an inherited writer cannot prolong
      // acquisition indefinitely, and parser delivery ACKs remain independent.
      await new Promise<void>(resolve => setImmediate(resolve));
      this.#finishStdout?.();
      // Both child 'exit' and 'close' share this parser fence. Await delivery
      // ACKs and buffered final frames, never unsolicited listeners or invokes.
      try {
        await this.#stdoutRead;
        this.#close(exitError(code, signal, this.#outputEnded));
      } catch (error) {
        this.#terminate(error);
      } finally {
        // The child has been reaped and protocol delivery has settled. Release
        // our pipe endpoints without waiting for inherited descendant handles.
        // Close first so stderr's premature-close rejection cannot win the cause.
        this.#process.stdin?.destroy();
        this.#process.stdout?.destroy();
        this.#process.stderr?.destroy();
      }
    })();
    void this.#exitDrain.catch(error => this.#terminate(error));
  }

  async #readStderr(): Promise<void> {
    if (!this.#process.stderr) return;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let bytes = 0;
    for await (const chunk of this.#process.stderr) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.byteLength;
      if (bytes > 1024 * 1024)
        throw new Error("Remote runtime stderr exceeded 1 MiB");
      text += decoder.decode(buf, { stream: true });
    }
    text += decoder.decode();
    if (text.trim()) process.stderr.write(`[omp-remote-worker] ${text}`);
  }


  async #handle(message: Message): Promise<void> {
    if (message.type === "invoke") {
      // Never await Eval invocation completion in the frame reader: it may run
      // another native worker tool while the originating Eval awaits its reply.
      void this.#invoke(message);
      return;
    }
    if (message.type === "invoke-cancel") {
      this.#invocations.get(message.id)?.controller.abort(new Error("Remote Eval invocation cancelled"));
      return;
    }
    if (message.type === "ready") {
      this.#resolveReady?.(message);
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
      return;
    }
    if (message.type === "event") {
      if (this.#eventListeners.size > 0) {
        void Promise.all([...this.#eventListeners].map((listener) => listener(message))).then(() => {
          const id = message.payload.completionId;
          if (!this.#closed && typeof id === "string") this.#send({ type: "event-ack", id });
        }).catch((error) => this.#terminate(error));
      }
      return;
    }
    if (message.type === "capture" || message.type === "update") {
      const pending = this.#pending.get(message.id);
      const delivery: unknown = message.type === "capture"
        ? pending?.onCapture?.(message.capture)
        : pending?.onUpdate?.(message.result);
      // Only the owner's IPC seam supplies delivery ACKs. Direct observers may
      // await another request on this client and must never fence its reader.
      if (this.#acknowledgedDelivery) await Promise.resolve(delivery);
      else if (delivery !== null && (typeof delivery === "object" || typeof delivery === "function")) {
        // Assimilation safely consumes PromiseLike rejections and throwing
        // `then` getters; ordinary observer return values have no effect.
        void Promise.resolve(delivery).catch(() => {});
      }
      return;
    }
    if (message.type === "result") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      this.#abortInvocations(message.id, new Error("Remote Eval parent call settled"));
      pending.resolve(message.result);
      return;
    }
    const error = new Error(remoteErrorMessage(message.error));
    if (message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      this.#abortInvocations(message.id, error);
      pending.reject(error);
    } else {
      this.#terminate(error);
    }
  }

  #abortInvocations(parentId: string, reason: Error): void {
    for (const invocation of this.#invocations.values()) {
      if (invocation.parentId === parentId) invocation.controller.abort(reason);
    }
  }

  async #invoke(message: InvokeMessage): Promise<void> {
    const parent = this.#pending.get(message.parentId);
    const controller = new AbortController();
    const current = () => !this.#closed && this.#pending.get(message.parentId) === parent;
    const token = { parentId: message.parentId, controller };
    try {
      if (this.#closed || !parent || parent.tool !== "eval" || !parent.onInvoke) throw new Error("Remote Eval invocation has no authorized active host parent");
      // Replays are a transport violation, not a second result for the same
      // correlation id. Never replace/delete the original cancellation token.
      const seen = parent.invocationIds ??= new Set<string>();
      if (seen.has(message.id) || this.#invocations.has(message.id)) {
        this.#terminate(new Error("Duplicate remote Eval invocation id"));
        return;
      }
      seen.add(message.id);
      this.#invocations.set(message.id, token);
      if (parent.signal?.aborted) controller.abort(parent.signal.reason);
      controller.signal.throwIfAborted();
      const result = await parent.onInvoke(message, controller.signal, value => {
        if (current() && !controller.signal.aborted) this.#send({ type: "invoke-update", id: message.id, result: value });
      });
      controller.signal.throwIfAborted();
      if (current()) this.#send({ type: "invoke-result", id: message.id, result });
    } catch (error) {
      if (!this.#closed) {
        const failure = error instanceof Error ? error : new Error(String(error));
        try { this.#send({ type: "invoke-error", id: message.id, error: { name: failure.name, message: failure.message } }); }
        catch (sendError) { this.#terminate(sendError); }
      }
    } finally {
      if (this.#invocations.get(message.id) === token) this.#invocations.delete(message.id);
    }
  }

  #terminate(error: unknown, signal: NodeJS.Signals = "SIGTERM"): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!this.#exited && (!this.#killSent || signal === "SIGKILL")) {
      this.#killSent = true;
      this.#process.kill(signal);
    }
    this.#close(failure);
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const invocation of this.#invocations.values()) invocation.controller.abort(error);
    this.#invocations.clear();
    this.#rejectReady?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#eventListeners.clear();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
  }
}
