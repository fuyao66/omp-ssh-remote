import { spawn, type ChildProcess } from "node:child_process";
import {
  AFT_REMOTE_TOOLS,
  OMP_VERSION,
  PI_NATIVE_TOOLS,
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

export type SpawnSpec = {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onUpdate?: (update: unknown) => void;
};
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
const PI_RUNTIME_TOOLS = new Set<string>([
  ...PI_NATIVE_TOOLS,
  ...AFT_REMOTE_TOOLS,
]);

export function validatePiReadyMessage(ready: ReadyMessage): void {
  if (
    ready.host !== "pi" ||
    ready.hostVersion !== PI_VERSION ||
    ready.toolRuntimeVersion !== PI_TOOL_RUNTIME_VERSION
  ) {
    throw new Error(
      `Remote Pi runtime version mismatch: host=${ready.hostVersion}, runtime=${ready.toolRuntimeVersion}`,
    );
  }
  if (ready.capabilities?.aftHostRuntime !== "@cortexkit/aft-pi@0.51.2") {
    throw new Error("Remote Pi runtime did not verify AFT 0.51.2");
  }
  const names = new Set<string>();
  for (const tool of ready.tools) {
    if (!PI_RUNTIME_TOOLS.has(tool.name)) {
      throw new Error(
        `Remote Pi runtime exposed unsupported tool: ${tool.name}`,
      );
    }
    if (names.has(tool.name)) {
      throw new Error(`Remote Pi runtime exposed duplicate tool: ${tool.name}`);
    }
    if (
      !tool.parameters ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters) ||
      (tool.parameters as Record<string, unknown>).type !== "object"
    ) {
      throw new Error(
        `Remote Pi tool ${tool.name} has an invalid parameter schema`,
      );
    }
    names.add(tool.name);
  }
  const missing = [...PI_RUNTIME_TOOLS].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Remote Pi runtime is missing tools: ${missing.join(", ")}`,
    );
  }
}

export class RemoteRuntimeClient {
  readonly #process: ChildProcess;
  readonly #pending = new Map<string, PendingCall>();
  readonly #ready: Promise<ReadyMessage>;
  #resolveReady?: (message: ReadyMessage) => void;
  #rejectReady?: (error: Error) => void;
  #closed = false;
  #nextId = 1;
  readonly #exitPromise: Promise<number | null>;

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
    this.#exitPromise = new Promise<number | null>((resolve) => {
      this.#process.on("close", (code) => resolve(code));
    });
    void this.#readStdout().catch((error) => this.#terminate(error));
    void this.#readStderr().catch((error) => this.#terminate(error));
    void this.#watchExit();
  }

  async initialize(
    cwd: string,
    timeoutMs = 15_000,
    host: "omp" | "pi" = "omp",
  ): Promise<ReadyMessage> {
    const tools = host === "pi" ? [] : [...REMOTE_TOOL_NAMES];
    this.#send({
      type: "initialize",
      protocolVersion: PROTOCOL_VERSION,
      host,
      ompVersion: host === "omp" ? OMP_VERSION : undefined,
      hostVersion: host === "pi" ? PI_VERSION : OMP_VERSION,
      runtimeVersion:
        host === "pi" ? PI_TOOL_RUNTIME_VERSION : TOOL_RUNTIME_VERSION,
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
        const available = new Set(ready.tools.map((tool) => tool.name));
        const missing = REMOTE_TOOL_NAMES.filter(
          (name) => !available.has(name),
        );
        if (missing.length > 0)
          throw new Error(
            `Remote runtime is missing tools: ${missing.join(", ")}`,
          );
      } else {
        validatePiReadyMessage(ready);
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
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error("Operation aborted");
    }
    const id = `req_${this.#nextId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onUpdate });
    });
    const abortHandler = () => {
      if (this.#pending.has(id)) {
        try {
          this.#send({ type: "cancel", id });
        } catch {}
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
      });
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      this.#pending.delete(id);
    }
  }

  async close(timeoutMs = 10_000): Promise<void> {
    if (this.#closed) return;
    try {
      this.#send({ type: "shutdown" });
      this.#process.stdin?.end();
      await withTimeout(
        this.#exitPromise,
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
    this.#process.stdin?.write(encodeMessage(message));
  }

  async #readStdout(): Promise<void> {
    if (!this.#process.stdout) return;
    for await (const line of decodeFrames(this.#process.stdout)) {
      if (line.trim()) this.#handle(parseMessage(line));
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

  async #watchExit(): Promise<void> {
    const code = await this.#exitPromise;
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
