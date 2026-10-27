import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { DebugTool } from "@oh-my-pi/pi-coding-agent/tools/debug";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import {
  REMOTE_TOOL_NAMES,
  parseResourceBinding,
  isRecord,
  type RemoteToolName,
  type OmpEditMode,
  type ToolManifest,
} from "./protocol.ts";
import { assertNestedRemoteTool, NESTED_TOOL_NAMES } from "./nested-dispatch.ts";
import { createRemoteArtifacts } from "./omp/artifacts.ts";
import { resolveRemoteArtifactArgs } from "./omp/artifact-input.ts";
import type { RemoteExecutionSettings } from "./omp/execution-settings.ts";
import { createCapturedBashTool } from "./omp/captured-bash.ts";
import type { JobCaptureSender } from "./omp/job-capture.ts";
import { RemoteConflictHistory } from "./omp/conflict-resources.ts";
import { bindRemoteResourceResult } from "./resource-routing.ts";
import type { executeOwnedRemoteService, stopRemoteServiceInstance, ServiceStopReceipt } from "./omp/service-lifecycle.ts";
export interface RemoteNativeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly mode?: OmpEditMode;
  readonly customFormat?: ToolManifest["customFormat"];
  readonly customWireName?: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    context?: unknown,
  ): Promise<unknown>;
}

function asRemoteNativeTool(
  tool:
    | ReadTool
    | WriteTool
    | EditTool
    | BashTool
    | GlobTool
    | GrepTool
    | LspTool
    | AstGrepTool
    | AstEditTool
    | EvalTool
    | DebugTool,
): RemoteNativeTool {
  return tool as unknown as RemoteNativeTool;
}

type PendingInvoker = {
  id: string;
  sourceToolName: string;
  onInvoked: (input: unknown) => Promise<unknown> | unknown;
};

class PendingInvokerQueueAdapter {
  #pending: PendingInvoker[] = [];

  registerPendingInvoker(
    id: string,
    sourceToolName: string,
    onInvoked: PendingInvoker["onInvoked"],
  ): void {
    this.removePendingInvoker(id);
    this.#pending.push({ id, sourceToolName, onInvoked });
  }

  removePendingInvoker(id: string): void {
    this.#pending = this.#pending.filter((entry) => entry.id !== id);
  }

  clearPendingInvokers(): void {
    this.#pending = [];
  }

  peekPendingInvoker(): PendingInvoker["onInvoked"] | undefined {
    return this.#pending.at(-1)?.onInvoked;
  }
}

/**
 * Structural pins. These decide tool wire schemas or execution-domain
 * ownership and therefore always win over anything the local host forwards.
 */
const WORKER_OVERRIDES = {
  "async.enabled": false,
  "bash.autoBackground.enabled": false,
  "lsp.enabled": true,
  "lsp.lazy": true,
  "lsp.shared": false,
  "memory.backend": "off",
  "eval.py": true,
  "eval.js": true,
  "tools.xdev": false,
  "debug.enabled": true,
  // `git worktree add` would otherwise be rewritten into `<worker binary>
  // worktree add ...`, which the companion binary does not implement.
  "worktree.clone": false,
} as const;

export type NativeWorkerRuntime = {
  cwd: string;
  /** Effective native process owner, resolved once for this runtime. */
  sessionId: string;
  tools: Readonly<Record<RemoteToolName, RemoteNativeTool>>;
  editMode: OmpEditMode;
  resourceBinding: string;
  session: ToolSession;
  executeEval: (invoke: NonNullable<NativeWorkerRuntimeOptions["invokeTool"]>, ...args: Parameters<RemoteNativeTool["execute"]>) => Promise<unknown>;
  createJobBash: (onCapture: JobCaptureSender, foreground?: boolean) => RemoteNativeTool;
  stopService: (name: string, id: string) => Promise<ServiceStopReceipt>;
  /** Release runtime-owned host resources (the output artifact namespace). Idempotent. */
  dispose: () => Promise<void>;
};

export type NativeWorkerRuntimeOptions = {
  /** Owner identity for remote supervised processes (local OMP session id). */
  sessionId?: string;
  /** Receives broker completion notifications for daemons this owner started. */
  onLaunchCompletion?: (notification: DaemonCompletionNotification) => void | Promise<void>;
  /** Execution-domain settings forwarded by the local host; structural pins win. */
  settings?: RemoteExecutionSettings;
  /** Negotiated effective edit mode; shared by read's anchors and edit's parser. */
  editMode?: OmpEditMode;
  /** Service capability negotiated from the real host bash schema. */
  bashServices?: boolean;
  /** Shared workspace resource namespace; independent runtimes get a fresh id. */
  resourceBinding?: string;
  /** Host-authorized invocation; omitted in frontend schema-only snapshots. */
  invokeTool?: RemoteNativeTool["execute"] extends (...args: infer A) => infer R
    ? (name: RemoteToolName, ...args: A) => R : never;
  /** Worker-only broker adapter; frontend schema snapshots do not need it. */
  serviceLifecycle?: {
    execute: typeof executeOwnedRemoteService;
    stop: typeof stopRemoteServiceInstance;
  };
};

export async function createNativeWorkerRuntime(
  cwd: string,
  hostVersion: string,
  options: NativeWorkerRuntimeOptions = {},
): Promise<NativeWorkerRuntime> {
  const resourceBinding = parseResourceBinding(options.resourceBinding ?? randomUUID());
  const sessionId = options.sessionId ?? `omp-ssh-remote:${randomUUID()}`;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0)
    throw new Error("Remote sessionId must be a non-empty string");
  const resolvedCwd = resolve(cwd);
  const cwdStat = await stat(resolvedCwd);
  if (!cwdStat.isDirectory())
    throw new Error(`Remote cwd is not a directory: ${cwd}`);
  const absoluteCwd = await realpath(resolvedCwd);
  const artifacts = await createRemoteArtifacts();
  const settings = Settings.isolated({
    ...(options.settings ?? {}),
    ...WORKER_OVERRIDES,
    "launch.enabled": options.bashServices ?? true,
    ...(options.editMode === undefined ? {} : { "edit.mode": options.editMode }),
  });
  const mutationVersions = new Map<string, number>();
  const pendingInvokers = new PendingInvokerQueueAdapter();
  const xdevTools = new Map<string, RemoteNativeTool>();
  const xdevMountedNames = new Set<string>(["lsp", "ast_grep", "ast_edit", "debug"]);
  const callableTools = new Map<string, RemoteNativeTool>();
  type EvalLease = { invoke: NonNullable<NativeWorkerRuntimeOptions["invokeTool"]>; active: boolean };
  let evalLease: EvalLease | undefined;
  let evalQueue: Promise<void> = Promise.resolve();
  const disposeCallbacks = new Set<() => void>();
  const conflictHistory = new RemoteConflictHistory();
  const session: ToolSession = {
    cwd: absoluteCwd,
    hasUI: false,
    enableLsp: true,
    enableIrc: false,
    enableMCP: false,
    hasEditTool: true,
    restrictToolNames: true,
    settings,
    conflictHistory,
    getSessionFile: () => null,
    getSessionSpawns: () => "",
    getSessionId: () => sessionId,
    getArtifactsDir: () => artifacts.manager.dir,
    getArtifactManager: () => artifacts.manager,
    allocateOutputArtifact: (type) => artifacts.manager.allocatePath(type),
    registerDisposeCallback: (callback) => {
      disposeCallbacks.add(callback);
      return () => {
        disposeCallbacks.delete(callback);
      };
    },
    ...(options.onLaunchCompletion
      ? {
          queueLaunchCompletion: async (notification) => {
            await options.onLaunchCompletion?.(notification);
          },
        }
      : {}),
    xdev: {
      tools: xdevTools,
      mountedNames: xdevMountedNames,
      builtInNames: new Set(xdevMountedNames),
      isActive: (name) => REMOTE_TOOL_NAMES.includes(name as (typeof REMOTE_TOOL_NAMES)[number]),
    } as NonNullable<ToolSession["xdev"]>,
    getFileMutationVersion: (path) => mutationVersions.get(path) ?? 0,
    bumpFileMutationVersion: (path) => {
      const next = (mutationVersions.get(path) ?? 0) + 1;
      mutationVersions.set(path, next);
      return next;
    },
    isToolActive: (name) => REMOTE_TOOL_NAMES.includes(name as (typeof REMOTE_TOOL_NAMES)[number]),
    getToolByName: name => {
      const tool = callableTools.get(name);
      if (!tool) return undefined;
      // Native JS/Python resolve ordinary tools synchronously while their
      // per-run registration is still active. Snapshot ownership at lookup,
      // never after an await in the callback's eventual execute path.
      const lease = evalLease;
      return {
        ...tool,
        async execute(...args: Parameters<RemoteNativeTool["execute"]>) {
          args[2]?.throwIfAborted();
          if (lease && (!lease.active || evalLease !== lease)) throw new Error("Remote Eval invocation lease is no longer active");
          assertNestedRemoteTool(name, args[1], resourceBinding, resolveEditMode(session));
          const invoke = lease?.invoke ?? options.invokeTool;
          if (!invoke) throw new Error("Remote Eval nested tools require the host invocation bridge");
          return invoke(name as RemoteToolName, ...args);
        },
      } as unknown as ReturnType<NonNullable<ToolSession["getToolByName"]>>;
    },
    getToolChoiceQueue: () =>
      pendingInvokers as unknown as ReturnType<
        NonNullable<ToolSession["getToolChoiceQueue"]>
      >,
    peekPendingInvoker: () => pendingInvokers.peekPendingInvoker(),
    clearPendingInvokers: () => pendingInvokers.clearPendingInvokers(),
  };
  const editMode = resolveEditMode(session);
  if (options.editMode !== undefined && editMode !== options.editMode) {
    await artifacts.dispose();
    throw new Error(`Remote edit mode ${editMode} conflicts with negotiated ${options.editMode}; pin PI_EDIT_VARIANT before creating the worker runtime`);
  }

  const tools: Record<RemoteToolName, RemoteNativeTool> = {
    read: asRemoteNativeTool(new ReadTool(session)),
    write: asRemoteNativeTool(new WriteTool(session)),
    edit: asRemoteNativeTool(new EditTool(session, editMode)),
    bash: asRemoteNativeTool(new BashTool(session)),
    grep: asRemoteNativeTool(new GrepTool(session)),
    glob: asRemoteNativeTool(new GlobTool(session, { rootPathAlias: true })),
    lsp: asRemoteNativeTool(new LspTool(session)),
    ast_grep: asRemoteNativeTool(new AstGrepTool(session)),
    ast_edit: asRemoteNativeTool(new AstEditTool(session)),
    eval: asRemoteNativeTool(new EvalTool(session)),
    debug: asRemoteNativeTool(new DebugTool(session)),
  };
  const read = tools.read.execute.bind(tools.read);
  tools.read.execute = (...args) => conflictHistory.captureRead(() => read(...args));
  const publishTool = (tool: RemoteNativeTool): RemoteNativeTool => {
    const execute = tool.execute.bind(tool);
    tool.execute = async (id, params, signal, onUpdate, context) => {
      const resolved = await resolveRemoteArtifactArgs(tool.name, params);
      const update = onUpdate ? (value: unknown) => onUpdate(artifacts.publish(value, tool.name)) : undefined;
      const serviceName = tool.name === "bash" && typeof resolved.name === "string" ? resolved.name.trim() : "";
      const callContext = isRecord(context) ? context : {};
      const toolCall = isRecord(callContext.toolCall) ? callContext.toolCall : {};
      const result = artifacts.publish(
        serviceName && options.serviceLifecycle
          ? await options.serviceLifecycle.execute(absoluteCwd, sessionId, serviceName, (steeringSignal) =>
            execute(id, resolved, undefined, update, { ...callContext, toolCall: { ...toolCall, steeringSignal } }),
            signal, toolCall.steeringSignal instanceof AbortSignal ? toolCall.steeringSignal : undefined)
          : await execute(id, resolved, signal, update, context),
        tool.name,
      );
      // Bind only after native artifact footers have been published. Eval's
      // tool.read(...).text then carries owned references without metadata.
      return tool.name === "read"
        ? bindRemoteResourceResult("read", params, result as AgentToolResult, resourceBinding)
        : result;
    };
    return tool;
  };
  Object.values(tools).forEach(publishTool);
  const evalCallableNames = NESTED_TOOL_NAMES;
  for (const name of evalCallableNames) {
    const tool = tools[name];
    callableTools.set(name, { name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async () => { throw new Error("Eval callable tools must resolve an invocation lease"); },
    });
  }
  for (const name of xdevMountedNames)
    xdevTools.set(name, tools[name as RemoteToolName]);
  let disposed: Promise<void> | undefined;
  const dispose = () => (disposed ??= artifacts.dispose());
  return {
    cwd: absoluteCwd, sessionId, tools, session, editMode, resourceBinding, dispose,
    executeEval: async (invoke, ...args) => {
      // Eval is natively exclusive. Serialize only Eval runs, never the native
      // workspace requests that a leased Eval reenters through the host.
      const previous = evalQueue;
      // Native JS drains/removes its per-run pending entry; Python unregisters
      // its unique run before backend completion. Ordinary callbacks resolve
      // this session's tool synchronously before their first await. Worker
      // speculation is disabled: adding shadows must revisit this lease proof.
      const release = Promise.withResolvers<void>();
      // A cancelled waiter may leave promptly, but later runs must still wait
      // for both its predecessor and its own release before acquiring ownership.
      evalQueue = Promise.all([previous, release.promise]).then(() => undefined);
      const lease: EvalLease = { invoke, active: true };
      try {
        const signal = args[2];
        if (signal) {
          signal.throwIfAborted();
          const cancelled = Promise.withResolvers<never>();
          const abort = () => cancelled.reject(signal.reason instanceof Error ? signal.reason : new Error("Remote Eval cancelled while queued"));
          signal.addEventListener("abort", abort, { once: true });
          try { await Promise.race([previous, cancelled.promise]); }
          finally { signal.removeEventListener("abort", abort); }
        } else await previous;
        args[2]?.throwIfAborted();
        evalLease = lease;
        return await tools.eval.execute(...args);
      } finally {
        lease.active = false;
        if (evalLease === lease) evalLease = undefined;
        release.resolve();
      }
    },
    stopService: async (name, id) => {
      if (!options.serviceLifecycle) throw new Error("Remote service lifecycle is unavailable in this runtime");
      return options.serviceLifecycle.stop(absoluteCwd, name, id);
    },
    createJobBash: (onCapture, foreground = false) => {
      const jobSettings = Settings.isolated({
        ...(options.settings ?? {}), ...WORKER_OVERRIDES, "edit.mode": editMode, "async.enabled": true,
        "launch.enabled": options.bashServices ?? true,
      });
      // Native managed bash isolates shells by the capture job's UUID, not owner identity.
      return publishTool(createCapturedBashTool({ ...session, settings: jobSettings }, onCapture, foreground));
    },
  };
}
