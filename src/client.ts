import { spawn, type ChildProcess } from "node:child_process";
import {
  PROTOCOL_VERSION,
  decodeFrames,
  encodeMessage,
  parseMessage,
  type EventMessage,
  type Message,
  type ReadyMessage,
  type Request,
  type InvokeMessage,
  type ImageQuestionMessage,
  type ImageQuestionModel,
  imageQuestionModelMetadata,
  type ImageQuestionBegin,
  type ImageQuestionTransfer,
  IMAGE_QUESTION_CHUNK_CHARS,
  MAX_IMAGE_QUESTION_BASE64,
  MAX_IMAGE_QUESTION_BYTES,
} from "./protocol.ts";
import type { RemoteRuntimeHandshake } from "./runtime-contract.ts";
import type { RemoteExecutionSettings } from "./omp/execution-settings.ts";
import type { JobCapturePayload } from "./omp/job-capture.ts";

export type SpawnSpec = {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onUpdate?: (update: unknown) => void;
  onCapture?: (capture: JobCapturePayload) => void;
  tool?: string;
  signal?: AbortSignal;
  onInvoke?: HostToolInvoker;
  onImageQuestion?: HostImageQuestionHandler;
  resourceBinding?: string;
  invocationIds?: Set<string>;
};

export type HostToolInvoker = (
  invocation: InvokeMessage,
  signal: AbortSignal,
  onUpdate: (value: unknown) => void,
) => Promise<unknown>;
export type HostImageQuestionHandler = (question: ImageQuestionMessage, signal: AbortSignal) => Promise<string>;
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

export class RemoteRuntimeClient {
  readonly #process: ChildProcess;
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
  readonly #eventListeners = new Set<(event: EventMessage) => void | Promise<void>>();
  readonly #closeListeners = new Set<(error: Error) => void>();
  readonly #invocations = new Map<string, { parentId: string; controller: AbortController }>();
  readonly #imageTransfers = new Map<string, {
    begin: ImageQuestionBegin; chunks: string[]; size: number; controller: AbortController;
  }>();
  #resourceBinding?: string;

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
      // Descendants that inherited stdio (an SSH mux master, a detached child) can
      // delay 'close' indefinitely. A worker writes nothing after exit, and what it
      // wrote earlier but the host has not read is bounded by the pipe's capacity,
      // which one read pass drains: after one turn, fail what is still pending.
      setImmediate(() => this.#close(exitError(code, signal, this.#outputEnded)));
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
      this.#close(exitError(code, signal, this.#outputEnded));
    });
    this.#process.stdin?.on("error", (error) => this.#terminate(error));
    void this.#readStdout().catch((error) => this.#terminate(error));
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
    options: { sessionId?: string; settings?: RemoteExecutionSettings; outReplies?: boolean; taskDepth?: number; signal?: AbortSignal; resourceBinding?: string } = {},
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
      handshake.validateReady(ready);
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
    options: { toolNames?: readonly string[]; steeringSignal?: AbortSignal; bashScope?: "job" | "session"; onCapture?: (capture: JobCapturePayload) => void; onInvoke?: HostToolInvoker; imageQuestionModel?: ImageQuestionModel; onImageQuestion?: HostImageQuestionHandler } = {},
  ): Promise<unknown> {
    if (this.#closed) throw new Error("Remote runtime is disconnected");
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error("Operation aborted");
    }
    const id = `req_${this.#nextId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onUpdate, onCapture: options.onCapture, tool, signal, onInvoke: options.onInvoke,
        onImageQuestion: options.onImageQuestion, resourceBinding: this.#resourceBinding });
    });
    const abortHandler = () => {
      this.#discardImageTransfers(id, signal?.reason ?? new Error("Remote read cancelled"));
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
        ...(options.imageQuestionModel ? { imageQuestionModel: imageQuestionModelMetadata(options.imageQuestionModel) } : {}),
      });
      options.steeringSignal?.addEventListener("abort", steerHandler, { once: true });
      if (options.steeringSignal?.aborted) steerHandler();
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      options.steeringSignal?.removeEventListener("abort", steerHandler);
      this.#pending.delete(id);
      this.#discardImageTransfers(id, new Error("Remote read parent call settled"));
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

  kill(): void {
    this.#terminate(new Error("Remote runtime killed"));
  }

  #send(message: Request): void {
    if (this.#closed) throw new Error("Remote runtime is disconnected");
    this.#process.stdin?.write(encodeMessage(message));
  }

  async #readStdout(): Promise<void> {
    if (!this.#process.stdout) return;
    for await (const line of decodeFrames(this.#process.stdout)) {
      if (line.trim()) this.#handle(parseMessage(line));
    }
    // No result can follow EOF. A dying worker reports its own exit status; one
    // still running without its output channel cannot serve the session, so stop
    // it and let the exit handler fail what is pending.
    this.#outputEnded = true;
    if (!this.#closed && !this.#exited && !this.#killSent) {
      this.#killSent = true;
      this.#process.kill();
    }
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


  #handle(message: Message): void {
    if (message.type === "image-question-begin" || message.type === "image-question-chunk" || message.type === "image-question-commit") {
      this.#imageTransfer(message);
      return;
    }
    if (message.type === "image-question") {
      void this.#imageQuestion(message);
      return;
    }
    if (message.type === "image-question-cancel") {
      const transfer = this.#imageTransfers.delete(message.id);
      this.#invocations.get(message.id)?.controller.abort(new Error("Remote image question cancelled"));
      if (transfer) this.#invocations.delete(message.id);
      return;
    }
    if (message.type === "invoke") {
      // Never await a callback in the frame reader: it may execute another
      // native worker tool while the originating Eval waits for its reply.
      void this.#invoke(message);
      return;
    }
    if (message.type === "invoke-cancel") {
      this.#invocations.get(message.id)?.controller.abort(new Error("Remote Eval invocation cancelled"));
      return;
    }
    if (message.type === "ready") {
      this.#resourceBinding = message.resourceBinding;
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
    if (message.type === "capture") {
      this.#pending.get(message.id)?.onCapture?.(message.capture);
      return;
    }
    if (message.type === "update") {
      this.#pending.get(message.id)?.onUpdate?.(message.result);
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
    const error = new Error(`${message.error.name}: ${message.error.message}`);
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
    this.#discardImageTransfers(parentId, reason);
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

  #discardImageTransfers(parentId: string, reason: unknown): void {
    for (const [id, transfer] of this.#imageTransfers) {
      if (transfer.begin.parentId !== parentId) continue;
      transfer.controller.abort(reason);
      this.#imageTransfers.delete(id);
      this.#invocations.delete(id);
    }
  }

  #imageQuestionError(id: string, error: unknown): void {
    if (this.#closed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    try { this.#send({ type: "image-question-error", id, error: { name: failure.name, message: failure.message } }); }
    catch (sendError) { this.#terminate(sendError); }
  }

  #imageTransfer(message: ImageQuestionTransfer): void {
    try {
      if (message.type === "image-question-begin") {
        const parent = this.#pending.get(message.parentId);
        if (!parent || parent.tool !== "read" || !parent.onImageQuestion || !parent.resourceBinding ||
            message.resourceBinding !== parent.resourceBinding)
          throw new Error("Remote image question has no authorized active read parent");
        const seen = parent.invocationIds ??= new Set<string>();
        if (seen.has(message.id) || this.#invocations.has(message.id)) {
          this.#terminate(new Error("Duplicate remote image question id"));
          return;
        }
        if ([...this.#invocations.values()].some(invocation => invocation.parentId === message.parentId))
          throw new Error("Remote read parent already has an in-flight image question");
        // Reserve only after validating the parent and bounded allocation below.
        parent.signal?.throwIfAborted();
        if (!Number.isSafeInteger(message.length) || message.length <= 0 || message.length > MAX_IMAGE_QUESTION_BASE64)
          throw new Error("Remote image question exceeds native image size limit");
        seen.add(message.id);
        const controller = new AbortController();
        this.#invocations.set(message.id, { parentId: message.parentId, controller });
        this.#imageTransfers.set(message.id, { begin: message,
          chunks: new Array<string>(Math.ceil(message.length / IMAGE_QUESTION_CHUNK_CHARS)), size: 0, controller });
        return;
      }
      const transfer = this.#imageTransfers.get(message.id);
      if (!transfer) throw new Error("Remote image question transfer is not active");
      transfer.controller.signal.throwIfAborted();
      if (message.type === "image-question-chunk") {
        const expectedLength = Math.min(IMAGE_QUESTION_CHUNK_CHARS, transfer.begin.length - transfer.size);
        if (expectedLength <= 0 || message.offset !== transfer.size || message.data.length !== expectedLength ||
            transfer.size + message.data.length > transfer.begin.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data) ||
            (message.data.includes("=") && transfer.size + message.data.length !== transfer.begin.length))
          throw new Error("Invalid remote image question chunk");
        transfer.chunks[transfer.size / IMAGE_QUESTION_CHUNK_CHARS] = message.data;
        transfer.size += message.data.length;
        return;
      }
      if (transfer.size !== transfer.begin.length) throw new Error("Incomplete remote image question transfer");
      const data = transfer.chunks.join("");
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      if (data.length % 4 !== 0 || data.length / 4 * 3 - padding > MAX_IMAGE_QUESTION_BYTES)
        throw new Error("Remote image question exceeds native image size limit");
      this.#imageTransfers.delete(message.id);
      void this.#imageQuestion({ ...transfer.begin, type: "image-question", data }, transfer.controller);
    } catch (error) {
      this.#imageTransfers.delete(message.id);
      this.#invocations.get(message.id)?.controller.abort(error);
      this.#invocations.delete(message.id);
      this.#imageQuestionError(message.id, error);
    }
  }

  async #imageQuestion(message: ImageQuestionMessage, admittedController?: AbortController): Promise<void> {
    const parent = this.#pending.get(message.parentId);
    const controller = admittedController ?? new AbortController();
    const token = admittedController ? this.#invocations.get(message.id)! : { parentId: message.parentId, controller };
    const current = () => !this.#closed && this.#pending.get(message.parentId) === parent;
    try {
      if (!parent || parent.tool !== "read" || !parent.onImageQuestion || !parent.resourceBinding ||
          message.resourceBinding !== parent.resourceBinding)
        throw new Error("Remote image question has no authorized active read parent");
      const seen = parent.invocationIds ??= new Set<string>();
      if (!admittedController) {
        if (seen.has(message.id) || this.#invocations.has(message.id)) {
          this.#terminate(new Error("Duplicate remote image question id"));
          return;
        }
        seen.add(message.id);
      }
      if (message.data.length > MAX_IMAGE_QUESTION_BASE64) throw new Error("Remote image question exceeds native image size limit");
      this.#invocations.set(message.id, token);
      if (parent.signal?.aborted) controller.abort(parent.signal.reason);
      controller.signal.throwIfAborted();
      const text = await parent.onImageQuestion(message, controller.signal);
      controller.signal.throwIfAborted();
      if (current()) this.#send({ type: "image-question-result", id: message.id, text });
    } catch (error) {
      this.#imageQuestionError(message.id, error);
    } finally {
      if (this.#invocations.get(message.id) === token) this.#invocations.delete(message.id);
    }
  }

  #terminate(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!this.#exited && !this.#killSent) {
      this.#killSent = true;
      this.#process.kill();
    }
    this.#close(failure);
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const invocation of this.#invocations.values()) invocation.controller.abort(error);
    this.#invocations.clear();
    this.#imageTransfers.clear();
    this.#rejectReady?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#eventListeners.clear();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
  }
}
