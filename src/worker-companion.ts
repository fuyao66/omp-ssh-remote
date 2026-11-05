import { register as registerCleanup } from "@oh-my-pi/pi-utils/postmortem";
import { dapSessionManager } from "@oh-my-pi/pi-coding-agent/dap";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { shutdownAll as shutdownAllLspClients } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { closeDaemonClients } from "@oh-my-pi/pi-coding-agent/launch/client";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import { createNativeWorkerRuntime, type NativeWorkerRuntime } from "./runtime.ts";
import { stopOwnedRemoteDaemons } from "./omp/hub-cleanup.ts";
import { mountRemoteArtifactScheme } from "./omp/artifacts.ts";
import { executeOwnedRemoteService, stopRemoteServiceInstance } from "./omp/service-lifecycle.ts";
import {
  PROTOCOL_VERSION,
  TOOL_RUNTIME_VERSION,
  decodeFrames,
  IMAGE_QUESTION_CHUNK_CHARS,
  MAX_IMAGE_QUESTION_BASE64,
  encodeMessage,
  parseRequest,
  type ExecuteRequest,
  type InitializeRequest,
  type Message,
  type RemoteToolName,
  type Request,
} from "./protocol.ts";
import { ompCompiledHostVersion, resolveOmpBuildVersion } from "./omp/host-identity.ts";
import { captureOmpToolSnapshot } from "./omp/runtime-contract.ts";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { captureExecutionSettings } from "./omp/execution-settings.ts";

let runtime: NativeWorkerRuntime | undefined;
const active = new Map<string, { controller: AbortController; steering: AbortController; done: Promise<void> }>();
let cleanupPromise: Promise<void> | undefined;
const pendingEvents = new Map<string, { resolve(): void; reject(reason: Error): void }>();
let nextInvocation = 1;
const pendingInvocations = new Map<string, {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  onUpdate?: (value: unknown) => void;
}>();
const pendingImageQuestions = new Map<string, { resolve(text: string): void; reject(reason: Error): void }>();

async function cleanupWorker(reason: Error): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const event of pendingEvents.values()) event.reject(reason);
    pendingEvents.clear();
    for (const invocation of pendingInvocations.values()) invocation.reject(reason);
    pendingInvocations.clear();
    for (const question of pendingImageQuestions.values()) question.reject(reason);
    pendingImageQuestions.clear();
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
    if (runtime) {
      await stopOwnedRemoteDaemons(runtime.cwd, runtime.sessionId);
    }
    await Promise.race([
      Promise.allSettled([disposeAllKernelSessions(), disposeAllVmContexts(), shutdownAllLspClients()]),
      Bun.sleep(5_000),
    ]);
    await closeDaemonClients().catch(() => undefined);
    // Artifacts only matter while this worker can still serve remote-artifact://
    // reads; once the transport is gone they are unreachable, so free them.
    await runtime?.dispose().catch(() => undefined);
  })();
  return cleanupPromise;
}

function send(message: Message): void {
  process.stdout.write(encodeMessage(message));
}

/** One awaited write per capture chunk bounds buffering on slow SSH links. */
async function sendCapture(message: Message): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(encodeMessage(message), error => error ? reject(error) : resolve());
  });
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
  if (request.host !== undefined && request.host !== "omp") {
    throw new Error(`Host mismatch: client=${request.host}, worker=omp`);
  }
  if (request.runtimeVersion !== TOOL_RUNTIME_VERSION) {
    throw new Error(`Runtime version mismatch: client=${request.runtimeVersion}, worker=${TOOL_RUNTIME_VERSION}`);
  }
  const hostVersion = ompCompiledHostVersion() ?? await resolveOmpBuildVersion();
  // One session per process: the negotiated edit language must override any
  // ambient remote PI_EDIT_VARIANT before native tools resolve their mode.
  if (request.editMode) process.env.PI_EDIT_VARIANT = request.editMode;
  // Native LSP messages use the theme even without a UI. Preserve any existing
  // theme and initialize the default without starting file watchers.
  await ensureTheme();
  // remote-artifact:// names files on this host; only the worker process mounts it.
  mountRemoteArtifactScheme();
  runtime = await createNativeWorkerRuntime(request.cwd, hostVersion, {
    sessionId: request.sessionId,
    settings: request.settings,
    outReplies: request.outReplies,
    taskDepth: request.taskDepth,
    editMode: request.editMode,
    bashServices: request.bashServices,
    resourceBinding: request.resourceBinding,
    serviceLifecycle: { execute: executeOwnedRemoteService, stop: stopRemoteServiceInstance },
    onLspMutation: mutation => send({ type: "event", event: "lsp-mutation", payload: mutation }),
    onDeferredDiagnostics: diagnostics => send({ type: "event", event: "lsp-diagnostics", payload: diagnostics }),
    onLspOperation: (operation, phase) => send({ type: "event", event: phase === "begin" ? "lsp-operation-begin" : "lsp-operation-end", payload: operation }),
    onLaunchCompletion: (notification) => new Promise<void>((resolve, reject) => {
      pendingEvents.set(notification.completionId, { resolve, reject });
      send({ type: "event", event: "launch-completion", payload: notification as unknown as Record<string, unknown> });
    }),
  });
  // The native shell executor reads Settings.init(), not ToolSession.settings.
  // This process owns one session; initialize its in-memory shell settings
  // from the same allowlist, outside the remote project's config scope.
  const settingsCwd = runtime.session.getArtifactsDir!()!;
  await Settings.init({
    inMemory: true,
    cwd: settingsCwd,
    agentDir: settingsCwd,
    overrides: captureExecutionSettings({
      get: (key) => lookup(key)?.get(runtime!.session.settings),
    }),
  });
  const requested = new Set(request.tools);
  const tools = Object.values(runtime.tools)
    .filter(tool => requested.has(tool.name))
    .map(tool => ({ ...captureOmpToolSnapshot(tool), description: tool.description }));
  send({
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    host: "omp",
    ompVersion: hostVersion,
    hostVersion,
    runtimeVersion: TOOL_RUNTIME_VERSION,
    editMode: runtime.editMode,
    cwd: runtime.cwd,
    resourceBinding: runtime.resourceBinding,
    capabilities: { jobCapture: "native-retained" },
    tools,
  });
}

function hostInvoker(parentId: string): NonNullable<Parameters<typeof createNativeWorkerRuntime>[2]>["invokeTool"] {
  return async (tool, toolCallId, args, signal, onUpdate) => {
    if (!runtime || !active.has(parentId) || cleanupPromise) throw new Error("Remote Eval invocation has no active parent binding");
    signal?.throwIfAborted();
    const id = `invoke_${nextInvocation++}`;
    const deferred = Promise.withResolvers<unknown>();
    pendingInvocations.set(id, { ...deferred, onUpdate });
    const abort = () => {
      pendingInvocations.delete(id);
      deferred.reject(signal?.reason instanceof Error ? signal.reason : new Error("Remote Eval invocation cancelled"));
      send({ type: "invoke-cancel", id });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      send({ type: "invoke", id, parentId, tool, toolCallId, args, resourceBinding: runtime.resourceBinding });
      return await deferred.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
      pendingInvocations.delete(id);
    }
  };
}

function hostImageQuestion(parentId: string): Parameters<NativeWorkerRuntime["createImageQuestionRead"]>[1] {
  return async (question, signal) => {
    if (!runtime || !active.has(parentId) || cleanupPromise) throw new Error("Remote image question has no active read parent");
    signal?.throwIfAborted();
    const id = `image_question_${nextInvocation++}`;
    const deferred = Promise.withResolvers<string>();
    // Cancellation or an early host rejection can arrive while chunks are still
    // draining; keep that rejection handled until the sender awaits the reply.
    void deferred.promise.catch(() => {});
    pendingImageQuestions.set(id, deferred);
    const abort = () => {
      pendingImageQuestions.delete(id);
      deferred.reject(signal?.reason instanceof Error ? signal.reason : new Error("Remote image question cancelled"));
      send({ type: "image-question-cancel", id });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (question.data.length > MAX_IMAGE_QUESTION_BASE64) throw new Error("Remote image question exceeds native image size limit");
      const { data, ...metadata } = question;
      await sendCapture({ type: "image-question-begin", id, parentId, resourceBinding: runtime.resourceBinding,
        ...metadata, length: data.length });
      for (let offset = 0; offset < data.length; offset += IMAGE_QUESTION_CHUNK_CHARS) {
        signal?.throwIfAborted();
        await sendCapture({ type: "image-question-chunk", id, offset, data: data.slice(offset, offset + IMAGE_QUESTION_CHUNK_CHARS) });
      }
      signal?.throwIfAborted();
      await sendCapture({ type: "image-question-commit", id });
      return await deferred.promise;
    } catch (error) {
      if (!signal?.aborted) send({ type: "image-question-cancel", id });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      pendingImageQuestions.delete(id);
    }
  };
}

function startExecute(request: ExecuteRequest): void {
  const toolName = request.tool as RemoteToolName;
  const current = runtime;
  const tool = request.bashScope
    ? current?.createJobBash(capture => sendCapture({ type: "capture", id: request.id, capture }), request.bashScope === "session")
    : toolName === "eval" && current ? { execute: (...args: Parameters<NativeWorkerRuntime["tools"]["eval"]["execute"]>) => current.executeEval(hostInvoker(request.id)!, ...args) }
    : toolName === "read" && request.imageQuestionModel && current
      ? current.createImageQuestionRead(request.imageQuestionModel, hostImageQuestion(request.id)) : current?.tools[toolName];
  if (!tool) {
    send({
      type: "error",
      id: request.id,
      error: {
        name: "UnknownTool",
        message: `Tool not found on remote runtime: ${request.tool}`,
      },
    });
    return;
  }
  const controller = new AbortController();
  const steering = new AbortController();
  // Steering ends only the native readiness wait; cancellation still aborts
  // the operation. No host UI, credentials or model state enters this context.
  const context = {
    ...(request.toolNames ? { toolNames: request.toolNames } : {}),
    hasUI: false,
    ...(request.steering ? { toolCall: { steeringSignal: steering.signal } } : {}),
  };
  const done = Promise.resolve().then(async () => {
    try {
      const result = await tool.execute(
        request.toolCallId,
        request.args,
        controller.signal,
        (partial: unknown) => send({ type: "update", id: request.id, result: partial }),
        context,
      );
      send({ type: "result", id: request.id, result });
    } catch (error) {
      send({ type: "error", id: request.id, error: serializeError(error) });
    } finally {
      active.delete(request.id);
    }
  });
  active.set(request.id, { controller, steering, done });
}

async function dispatch(request: Request): Promise<boolean> {
  switch (request.type) {
    case "initialize":
      await initialize(request);
      return true;
    case "execute":
      startExecute(request);
      return true;
    case "service-stop":
      try {
        if (!runtime) throw new Error("Worker is not initialized");
        send({ type: "result", id: request.id, result: await runtime.stopService(request.name, request.instanceId) });
      } catch (error) {
        send({ type: "error", id: request.id, error: serializeError(error) });
      }
      return true;
    case "cancel":
      active.get(request.id)?.controller.abort(new Error("Remote tool call cancelled"));
      return true;
    case "steer":
      active.get(request.id)?.steering.abort(new Error("Host message queued"));
      return true;
    case "event-ack":
      pendingEvents.get(request.id)?.resolve();
      pendingEvents.delete(request.id);
      return true;
    case "image-question-result":
      pendingImageQuestions.get(request.id)?.resolve(request.text);
      pendingImageQuestions.delete(request.id);
      return true;
    case "image-question-error":
      pendingImageQuestions.get(request.id)?.reject(Object.assign(new Error(request.error.message), { name: request.error.name }));
      pendingImageQuestions.delete(request.id);
      return true;
    case "invoke-update":
      pendingInvocations.get(request.id)?.onUpdate?.(request.result);
      return true;
    case "invoke-result":
      pendingInvocations.get(request.id)?.resolve(request.result);
      pendingInvocations.delete(request.id);
      return true;
    case "invoke-error":
      pendingInvocations.get(request.id)?.reject(new Error(`${request.error.name}: ${request.error.message}`));
      pendingInvocations.delete(request.id);
      return true;
    case "shutdown":
      return false;
  }
}

export async function runCompanionWorker(): Promise<void> {
  // Native postmortem owns signal exit codes (SIGTERM=143, SIGHUP=129).
  // Join its awaited cleanup barrier instead of racing another async handler
  // against its hard exit.
  registerCleanup("ssh-remote-worker", reason =>
    cleanupWorker(new Error(`Remote worker cleanup: ${reason}`)));
  try {
    for await (const line of decodeFrames(Bun.stdin.stream())) {
      if (!line.trim()) continue;
      if (!(await dispatch(parseRequest(line)))) break;
    }
  } catch (error) {
    // An error without a request id is fatal to this session. Do not wait for
    // more stdin after initialization/protocol failure: clients may keep it open.
    send({ type: "error", error: serializeError(error) });
    process.exitCode = 1;
  } finally {
    await cleanupWorker(new Error("Remote worker transport closed"));
  }
  process.exit(process.exitCode ?? 0);
}
