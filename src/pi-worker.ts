#!/usr/bin/env bun
import {
  createPiNativeWorkerRuntime,
  type PiNativeWorkerRuntime,
} from "./pi-runtime.ts";
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
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workerDir =
  process.env.PI_COMPILED === "true"
    ? dirname(process.execPath)
    : dirname(fileURLToPath(import.meta.url));
process.env.PATH = `${workerDir}${delimiter}${process.env.PATH ?? ""}`;

let runtime: PiNativeWorkerRuntime | undefined;
const active = new Map<
  string,
  { controller: AbortController; done: Promise<void> }
>();
let cleanupPromise: Promise<void> | undefined;
let shuttingDown = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanupWorker(reason: Error): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  shuttingDown = true;
  cleanupPromise = (async () => {
    for (const entry of active.values()) entry.controller.abort(reason);
    await Promise.race([
      Promise.allSettled([...active.values()].map((entry) => entry.done)),
      sleep(5_000),
    ]);
    active.clear();
    if (runtime) {
      await Promise.race([runtime.close().catch(() => {}), sleep(5_000)]);
      runtime = undefined;
    }
  })();
  return cleanupPromise;
}

function send(message: Message): void {
  process.stdout.write(encodeMessage(message));
}

function serializeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
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
  runtime = await createPiNativeWorkerRuntime(request.cwd, {});
  send(runtime.manifest);
}

function startExecute(request: ExecuteRequest): void {
  if (!runtime) {
    send({
      type: "error",
      id: request.id,
      error: {
        name: "NotInitialized",
        message: "Worker runtime is not initialized",
      },
    });
    return;
  }
  const controller = new AbortController();
  const executePromise = (async () => {
    try {
      const result = await runtime.execute(
        request,
        controller.signal,
        (update) => {
          if (!shuttingDown)
            send({ type: "update", id: request.id, result: update });
        },
      );
      if (!shuttingDown) send({ type: "result", id: request.id, result });
    } catch (error) {
      if (!shuttingDown)
        send({ type: "error", id: request.id, error: serializeError(error) });
    } finally {
      active.delete(request.id);
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
  void cleanupWorker(new Error(`Remote worker received ${signal}`)).finally(
    () => process.exit(0),
  );
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
