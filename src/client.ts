import {
  OMP_VERSION,
  PI_VERSION,
  PI_TOOL_RUNTIME_VERSION,
  PROTOCOL_VERSION,
  REMOTE_TOOL_NAMES,
  TOOL_RUNTIME_VERSION,
  decodeFrames,
  encodeMessage,
  parseMessage,
  type AnyRemoteToolName,
  type Message,
  type ReadyMessage,
  type RemoteToolName,
  type Request,
} from "./protocol.ts";

export type SpawnSpec = { command: string[]; cwd?: string; env?: Record<string, string> };

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onUpdate?: (update: unknown) => void;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

export class RemoteRuntimeClient {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #pending = new Map<string, PendingCall>();
  readonly #ready: Promise<ReadyMessage>;
  #resolveReady?: (message: ReadyMessage) => void;
  #rejectReady?: (error: Error) => void;
  #closed = false;
  #nextId = 1;

  get isClosed(): boolean {
    return this.#closed;
  }

  constructor(spec: SpawnSpec) {
    this.#process = Bun.spawn(spec.command, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#ready = new Promise<ReadyMessage>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.#readStdout().catch(error => this.#terminate(error));
    void this.#readStderr().catch(error => this.#terminate(error));
    void this.#watchExit();
  }

  async initialize(
    cwd: string,
    timeoutMs = 15_000,
    host: "omp" | "pi" = "omp",
  ): Promise<ReadyMessage> {
    const tools = host === "pi"
      ? ["read", "write", "edit", "bash", "grep", "find", "ls"]
      : [...REMOTE_TOOL_NAMES];
    this.#send({
      type: "initialize",
      protocolVersion: PROTOCOL_VERSION,
      host,
      ompVersion: host === "omp" ? OMP_VERSION : undefined,
      hostVersion: host === "pi" ? PI_VERSION : OMP_VERSION,
      runtimeVersion: host === "pi" ? PI_TOOL_RUNTIME_VERSION : TOOL_RUNTIME_VERSION,
      cwd,
      tools,
    });
    try {
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
      if (host === "omp") {
        if (
          ready.ompVersion !== OMP_VERSION ||
          ready.runtimeVersion !== TOOL_RUNTIME_VERSION
        ) {
          throw new Error(
            `Remote runtime version mismatch: protocol=${ready.protocolVersion}, OMP=${ready.ompVersion}, runtime=${ready.runtimeVersion}`,
          );
        }
        const available = new Set(ready.tools.map(tool => tool.name));
        const missing = REMOTE_TOOL_NAMES.filter(name => !available.has(name));
        if (missing.length > 0) throw new Error(`Remote runtime is missing tools: ${missing.join(", ")}`);
      } else {
        const piTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
        const available = new Set(ready.tools.map(tool => tool.name));
        const missing = piTools.filter(name => !available.has(name));
        if (missing.length > 0) throw new Error(`Remote Pi runtime is missing tools: ${missing.join(", ")}`);
      }
      return ready;
    } catch (error) {
      this.#terminate(error);
      throw error;
    }
  }

  async execute(
    tool: AnyRemoteToolName,
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> {
    if (this.#closed) throw new Error("Remote runtime is disconnected");
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new Error("Remote tool call cancelled"));
    const id = String(this.#nextId++);
    let abort: (() => void) | undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onUpdate });
      abort = () => {
        try {
          this.#send({ type: "cancel", id });
        } catch {
          // Disconnect handling rejects every pending call.
        }
        this.#pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Remote tool call cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.#send({ type: "execute", id, toolCallId, tool, args });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      return await promise;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  async close(timeoutMs = 10_000): Promise<void> {
    if (this.#closed) return;
    try {
      this.#send({ type: "shutdown" });
      this.#process.stdin.end();
      await withTimeout(
        this.#process.exited,
        timeoutMs,
        `Remote runtime shutdown timed out after ${timeoutMs}ms`,
      );
      this.#close(new Error("Remote runtime closed"));
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
    this.#process.stdin.write(encodeMessage(message));
    this.#process.stdin.flush();
  }

  async #readStdout(): Promise<void> {
    for await (const line of decodeFrames(this.#process.stdout)) {
      if (line.trim()) this.#handle(parseMessage(line));
    }
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let bytes = 0;
    for await (const chunk of this.#process.stderr) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error("Remote runtime stderr exceeded 1 MiB");
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    if (text.trim()) process.stderr.write(`[omp-remote-worker] ${text}`);
  }

  async #watchExit(): Promise<void> {
    const code = await this.#process.exited;
    this.#close(new Error(`Remote runtime exited with code ${code}`));
  }

  #handle(message: Message): void {
    if (message.type === "ready") {
      this.#resolveReady?.(message);
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
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
      pending.resolve(message.result);
      return;
    }
    const error = new Error(`${message.error.name}: ${message.error.message}`);
    if (message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.reject(error);
    } else {
      this.#rejectReady?.(error);
      this.#close(error);
    }
  }

  #terminate(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!this.#closed) this.#process.kill();
    this.#close(failure);
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectReady?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
