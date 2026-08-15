#!/usr/bin/env bun
import { startJsEvalProcess } from "@oh-my-pi/pi-coding-agent/eval/js/process-entry";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { interceptUnhandledRejections } from "@oh-my-pi/pi-utils/postmortem";
import { dapSessionManager } from "@oh-my-pi/pi-coding-agent/dap";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { shutdownAll as shutdownAllLspClients } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { createNativeWorkerRuntime, type NativeWorkerRuntime } from "./runtime.ts";
import {
  OMP_VERSION,
  PROTOCOL_VERSION,
  TOOL_RUNTIME_VERSION,
  decodeFrames,
  encodeMessage,
  parseRequest,
  type ExecuteRequest,
  type InitializeRequest,
  type Message,
  type Request,
} from "./protocol.ts";

const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";

async function runJsEvalProcessHost(): Promise<void> {
  const { promise: disconnected, resolve } = Promise.withResolvers<void>();
  type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
  const ipcProcess = process as NodeJS.Process & { send?: IpcSend };
  const send = (message: WorkerOutbound): void => {
    const sender = ipcProcess.send;
    if (!sender) {
      resolve();
      return;
    }
    try {
      sender.call(process, message);
    } catch (error) {
      if (process.connected) throw error;
      resolve();
    }
  };
  startJsEvalProcess(
    {
      send,
      onMessage(handler) {
        const listener = (message: unknown): void => handler(message as WorkerInbound);
        process.on("message", listener);
        return () => process.off("message", listener);
      },
    },
    interceptUnhandledRejections,
  );
  const keepalive = setInterval(() => {}, 2 ** 30);
  process.on("disconnect", resolve);
  try {
    await disconnected;
  } finally {
    clearInterval(keepalive);
  }
  process.kill(process.pid, "SIGKILL");
}

let runtime: NativeWorkerRuntime | undefined;
const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
let cleanupPromise: Promise<void> | undefined;

async function cleanupWorker(reason: Error): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const call of active.values()) call.controller.abort(reason);
    await Promise.race([
      Promise.allSettled([...active.values()].map(call => call.done)),
      Bun.sleep(5_000),
    ]);
    const dapDeadline = Date.now() + 5_000;
    while (dapSessionManager.listSessions().length > 0 && Date.now() < dapDeadline) {
      const before = dapSessionManager.listSessions().length;
      const remaining = Math.max(1, dapDeadline - Date.now());
      await dapSessionManager.terminate(AbortSignal.timeout(remaining), remaining).catch(() => undefined);
      if (dapSessionManager.listSessions().length >= before) break;
    }
    await Promise.race([
      Promise.allSettled([disposeAllKernelSessions(), disposeAllVmContexts(), shutdownAllLspClients()]),
      Bun.sleep(5_000),
    ]);
  })();
  return cleanupPromise;
}

function send(message: Message): void {
  process.stdout.write(encodeMessage(message));
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: String(error) };
}

async function initialize(request: InitializeRequest): Promise<void> {
  if (runtime) throw new Error("Worker is already initialized");
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Protocol mismatch: client=${request.protocolVersion}, worker=${PROTOCOL_VERSION}`);
  }
  if (request.ompVersion !== OMP_VERSION) {
    throw new Error(`OMP version mismatch: client=${request.ompVersion}, worker=${OMP_VERSION}`);
  }
  if (request.runtimeVersion !== TOOL_RUNTIME_VERSION) {
    throw new Error(`Runtime version mismatch: client=${request.runtimeVersion}, worker=${TOOL_RUNTIME_VERSION}`);
  }
  runtime = await createNativeWorkerRuntime(request.cwd);
  const requested = new Set(request.tools);
  const tools = Object.values(runtime.tools)
    .filter(tool => requested.has(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  send({
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    ompVersion: OMP_VERSION,
    runtimeVersion: TOOL_RUNTIME_VERSION,
    cwd: runtime.cwd,
    tools,
  });
}

function startExecute(request: ExecuteRequest): void {
  if (!runtime) throw new Error("Worker is not initialized");
  const tool = runtime.tools[request.tool];
  if (!tool) throw new Error(`Remote tool is unavailable: ${request.tool}`);
  if (active.has(request.id)) throw new Error(`Duplicate request id: ${request.id}`);

  const controller = new AbortController();
  const done = (async () => {
    try {
      const result = await tool.execute(
        request.toolCallId,
        request.args,
        controller.signal,
        partial => send({ type: "update", id: request.id, result: partial }),
        undefined,
      );
      send({ type: "result", id: request.id, result });
    } catch (error) {
      send({ type: "error", id: request.id, error: serializeError(error) });
    } finally {
      active.delete(request.id);
    }
  })();
  active.set(request.id, { controller, done });
}

async function dispatch(request: Request): Promise<boolean> {
  switch (request.type) {
    case "initialize":
      await initialize(request);
      return true;
    case "execute":
      startExecute(request);
      return true;
    case "cancel":
      active.get(request.id)?.controller.abort(new Error("Remote tool call cancelled"));
      return true;
    case "shutdown":
      return false;
  }
}

if (process.argv[2] === JS_EVAL_PROCESS_ARG) {
  await runJsEvalProcessHost();
} else {
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
}
