#!/usr/bin/env bun
import { createPiNativeWorkerRuntime, type PiNativeWorkerRuntime } from "./pi-runtime.ts";
import {
  PI_VERSION,
  PROTOCOL_VERSION,
  PI_TOOL_RUNTIME_VERSION,
  decodeFrames,
  encodeMessage,
  parseRequest,
  type ExecuteRequest,
  type InitializeRequest,
  type Message,
  type Request,
} from "./protocol.ts";

let runtime: PiNativeWorkerRuntime | undefined;
const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
let cleanupPromise: Promise<void> | undefined;

async function cleanupWorker(reason: Error): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const [id, entry] of active) {
      entry.controller.abort(reason);
      send({
        type: "error",
        id,
        error: serializeError(reason),
      });
    }
    active.clear();
    if (runtime) {
      try {
        await runtime.close();
      } catch {}
    }
  })();
  return cleanupPromise;
}

function send(message: Message): void {
  process.stdout.write(encodeMessage(message));
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

async function initialize(request: InitializeRequest): Promise<void> {
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocol version: ${request.protocolVersion} (expected ${PROTOCOL_VERSION})`,
    );
  }
  runtime = createPiNativeWorkerRuntime(request.cwd, {});
  send(runtime.manifest);
}

function startExecute(request: ExecuteRequest): void {
  if (!runtime) {
    send({
      type: "error",
      id: request.id,
      error: { name: "NotInitialized", message: "Worker runtime is not initialized" },
    });
    return;
  }
  const controller = new AbortController();
  const executePromise = (async () => {
    try {
      const result = await runtime.execute(request);
      active.delete(request.id);
      send({ type: "result", id: request.id, result });
    } catch (error) {
      active.delete(request.id);
      send({ type: "error", id: request.id, error: serializeError(error) });
    }
  })();
  active.set(request.id, { controller, done: executePromise });
}

async function dispatch(request: Request): Promise<boolean> {
  if (request.type === "initialize") {
    await initialize(request);
    return true;
  }
  if (request.type === "execute") {
    startExecute(request);
    return true;
  }
  if (request.type === "cancel") {
    const entry = active.get(request.id);
    if (entry) {
      entry.controller.abort(new Error("Request cancelled by client"));
    }
    return true;
  }
  if (request.type === "shutdown") {
    await cleanupWorker(new Error("Worker shutdown requested"));
    return false;
  }
  return true;
}

const stopForSignal = (signal: string): void => {
  void cleanupWorker(new Error(`Remote worker received ${signal}`)).finally(() => process.exit(0));
};
process.once("SIGHUP", () => stopForSignal("SIGHUP"));
process.once("SIGTERM", () => stopForSignal("SIGTERM"));

try {
  for await (const line of decodeFrames(Bun.stdin.stream())) {
    if (!line.trim()) continue;
    try {
      if (!(await dispatch(parseRequest(line)))) break;
    } catch (error) {
      send({ type: "error", error: serializeError(error) });
    }
  }
} finally {
  await cleanupWorker(new Error("Remote worker transport closed"));
}
process.exit(0);
