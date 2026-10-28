import { resolve as resolvePath } from "node:path";
import type { AgentToolResult, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/omptype/zod";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import {
  loadConfiguredSshHosts,
  parseConnectArgs,
  parseConnectOptions,
  type RemoteConnectRequest,
} from "./connect-options.ts";
import { RemoteRuntimeClient } from "./client.ts";
import { describeRemoteWorkerCacheAudit, prepareRemoteWorker, resolveRemoteHome, type PreparedRemoteWorker, type RemoteWorkerCacheAudit } from "./deploy.ts";
import { REMOTE_TOOL_NAMES, type RemoteToolName, type ReadyMessage } from "./protocol.ts";
import { createOmpRuntimeHandshake, captureOmpToolSnapshot } from "./omp/runtime-contract.ts";
import { ompHostCompatibility, resolveOmpHostVersion, type OmpHostCompatibility } from "./omp/host-identity.ts";
import { createNativeWorkerRuntime } from "./runtime.ts";
import {
  isInternalUri,
  normalizePathArgument,
  pathShouldStayLocal,
} from "./path-domain.ts";
export { pathShouldStayLocal } from "./path-domain.ts";
import { buildSshWorkerCommand } from "./ssh.ts";
import {
  resolveJobOwnerId,
  resolveLocalAsyncJobManager,
  startRemoteAsyncBashJob,
  runRemoteForegroundBashJob,
  type RemoteAsyncBashJobOptions,
} from "./omp/async-bash.ts";
import { startRemoteService, completeService, completeStoppedService } from "./omp/service-jobs.ts";
import { withReadinessSteering } from "./omp/readiness-steering.ts";
import { remoteWrapperApproval } from "./omp/approval-targets.ts";
import { isProcessListingPath, mergeProcessListings } from "./omp/process-routing.ts";
import { buildLaunchCompletionBatchMessage } from "@oh-my-pi/pi-coding-agent/session/launch-completion";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { captureExecutionSettings, type RemoteExecutionSettings } from "./omp/execution-settings.ts";
import { WORKSPACE_RULES, workspaceAnnouncement, type WorkspaceBindingNotice } from "./omp/workspace-context.ts";
import { resolveRemoteResourceArgs } from "./resource-routing.ts";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getRemoteFamilyBroker, sessionFamilyRoot } from "./family-broker.ts";
export { sessionBelongsToFamily } from "./family-broker.ts";
import { assertNestedRemoteTool, nestedDispatchScope } from "./nested-dispatch.ts";
import type { HostToolInvoker } from "./client.ts";
import { validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { resourceOwnershipTarget } from "./resource-ownership.ts";
import type { ToolContextStore } from "@oh-my-pi/pi-coding-agent/tools/context";

/**
 * Snapshot the execution-domain subset of the local session's settings.
 * `findScopedSettings()` resolves the extension's active settings scope, so a
 * project-level `config.yml` is honoured; when no settings are initialized
 * (bare test harnesses) nothing is forwarded and the companion keeps defaults.
 */
export function captureLocalExecutionSettings(): RemoteExecutionSettings {
  try {
    const scoped = findScopedSettings();
    return scoped ? captureExecutionSettings(scoped) : {};
  } catch {
    return {};
  }
}

const REMOTE_TOOL_SET = new Set<string>(REMOTE_TOOL_NAMES);
const REMOTE_XDEV_TOOLS = new Set<RemoteToolName>([
  "lsp",
  "ast_grep",
  "ast_edit",
  "debug",
]);
const RESOLUTION_DEVICES = new Set(["resolve", "reject"]);
const LSP_READONLY_ACTIONS = new Set([
  "diagnostics",
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
  "symbols",
  "status",
  "capabilities",
]);
const DEBUG_READONLY_ACTIONS = new Set([
  "output",
  "threads",
  "stack_trace",
  "scopes",
  "variables",
  "disassemble",
  "read_memory",
  "loaded_sources",
  "modules",
  "sessions",
]);
const TOOL_LABELS: Record<RemoteToolName, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  lsp: "lsp",
  ast_grep: "ast search",
  ast_edit: "ast replace",
  eval: "eval",
  debug: "debug",
};

const REMOTE_WORKSPACE_STATUS_TOOL = "remote_workspace_status";

export type RemoteWorkspaceStatus = {
  mode: "local" | "remote" | "unavailable";
  transport: "not-selected" | "connected" | "unavailable";
  remoteCwd: string | null;
  sessionRole: "owner" | "subagent" | null;
  connectionError: string | null;
  /** Last connection deployment snapshot; status never probes SSH. */
  cacheAudit: RemoteWorkerCacheAudit | null;
  remoteWorkspaceTools: RemoteToolName[];
  pendingRemoteAstProposals: number;
  hostCompatibility: {
    installedHostVersion: string | null;
    compiledHostVersion: string | null;
    compatible: boolean;
    advice: string | null;
  };
  routing: {
    ordinaryFilesystemPaths: string;
    internalUris: string;
    controlPlane: string;
    asyncBash: string;
    hubProcesses: string;
    isolatedTasks: string;
  };
  note: string;
};

type RemoteWorkspaceStatusInput = {
  selected: boolean;
  clientPresent: boolean;
  clientClosed: boolean;
  connectionError?: string;
  remoteCwd?: string;
  owner: boolean;
  wrappedTools: Iterable<RemoteToolName>;
  proposalSources: Iterable<ExecutionTarget>;
  hostCompatibility?: OmpHostCompatibility;
  cacheAudit?: RemoteWorkerCacheAudit;
};

export function workspaceStatus(
  input: RemoteWorkspaceStatusInput,
): RemoteWorkspaceStatus {
  const mode = !input.selected
    ? "local"
    : input.connectionError || !input.clientPresent || input.clientClosed
      ? "unavailable"
      : "remote";
  const selected = mode !== "local";
  return {
    mode,
    transport:
      mode === "local"
        ? "not-selected"
        : mode === "remote"
          ? "connected"
          : "unavailable",
    remoteCwd: selected ? (input.remoteCwd ?? null) : null,
    sessionRole: selected ? (input.owner ? "owner" : "subagent") : null,
    connectionError:
      mode === "unavailable"
        ? (input.connectionError ?? "Remote runtime transport is unavailable")
        : null,
    cacheAudit: selected ? (input.cacheAudit ?? null) : null,
    remoteWorkspaceTools: selected
      ? [...new Set(input.wrappedTools)].sort()
      : [],
    pendingRemoteAstProposals: [...input.proposalSources].filter(
      (source) => source === "remote",
    ).length,
    hostCompatibility: {
      installedHostVersion: input.hostCompatibility?.installedHostVersion ?? null,
      compiledHostVersion: input.hostCompatibility?.compiledHostVersion ?? null,
      compatible: input.hostCompatibility?.compatible ?? false,
      advice: input.hostCompatibility?.advice ?? null,
    },
    routing: {
      ordinaryFilesystemPaths:
        mode === "remote"
          ? "remote native runtime"
          : mode === "unavailable"
            ? "rejected (fail closed)"
            : "local native tools",
      internalUris: "local control plane",
      controlPlane: "local control plane",
      asyncBash:
        mode === "local"
          ? "local OMP policy"
          : mode === "remote"
            ? "local OMP job owns lifecycle; remote companion runs the command in the foreground; cancel or disconnect aborts it"
            : "rejected (fail closed)",
      hubProcesses:
        mode === "local"
          ? "local OMP policy"
          : mode === "remote"
            ? "named bash services and service proc:// operations run remotely; jobs and agent coordination stay local; non-persistent services stop on exit"
            : "rejected (fail closed)",
      isolatedTasks:
        mode === "local"
          ? "local OMP policy"
          : "rejected; remote isolated worktrees are not available",
    },
    note: "Current in-process SSH transport state only; this tool does not send an SSH health probe.",
  };
}

export type SessionNavigationState = {
  selected: boolean;
  owner: boolean;
  familyMemberCount: number;
  remoteProposalCount: number;
};

export function remoteSessionNavigationBlockReason(
  input: SessionNavigationState,
): string | undefined {
  if (!input.selected) return undefined;
  if (input.owner && input.remoteProposalCount > 0) {
    return "Remote staged proposals are pending; resolve/reject them first, or run /remote-exit --force";
  }
  if (input.owner && input.familyMemberCount > 1) {
    return "Remote subagent sessions are still active; wait for them or run /remote-exit --force";
  }
  return undefined;
}

type ExecutionTarget = "local" | "remote";
type RemoteConnectOptions = Omit<RemoteConnectRequest, "cwd"> & {
  cwd: string;
};
type RemoteExtensionState = {
  binding: string;
  client?: RemoteRuntimeClient;
  deployment?: AbortController;
  remoteCwd?: string;
  localCwd?: string;
  sessionFile?: string;
  wrappedTools: Set<RemoteToolName>;
  proposalSources: ExecutionTarget[];
  selected: boolean;
  owner: boolean;
  family?: RemoteFamily;
  connectionError?: string;
  editMode?: EditMode;
  /** Active tool names of the local session; forwarded so the remote bash interceptor sees the real tool set. */
  activeToolNames: () => string[] | undefined;
};
type RemoteFamily = {
  ownerSessionFile: string;
  root: string;
  localCwd: string;
  remoteCwd: string;
  connection: RemoteConnectOptions & { workerPath: string };
  cacheAudit?: RemoteWorkerCacheAudit;
  members: Set<RemoteExtensionState>;
  closing: boolean;
};

const remoteFamilyBroker = getRemoteFamilyBroker<RemoteFamily>();

const SESSION_SHUTDOWN_REMOTE_CLOSE_TIMEOUT_MS = 1_000;

function hostSessionFor(state: RemoteExtensionState, ctx?: ExtensionContext) {
  const file = ctx?.sessionManager?.getSessionFile?.() ?? state.sessionFile;
  return AgentRegistry.global().list().find((ref) =>
    file && ref.sessionFile && resolvePath(ref.sessionFile) === resolvePath(file))?.session;
}

function effectiveHostEditMode(state: RemoteExtensionState, ctx?: ExtensionContext): EditMode {
  const host = hostSessionFor(state, ctx);
  const settings = host?.settings ?? findScopedSettings();
  if (!settings) return state.editMode ?? "hashline";
  const model = ctx?.model ?? host?.model;
  return resolveEditMode({ settings, getActiveModelString: () => model ? `${model.provider}/${model.id}` : undefined });
}


function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function taskRequestsIsolation(input: Record<string, unknown>): boolean {
  if (input.isolated === true) return true;
  if (!Array.isArray(input.tasks)) return false;
  return input.tasks.some((item) => asRecord(item).isolated === true);
}

export function remoteControlPlaneBlockReason(
  toolName: string,
  input: unknown,
  sessionFile?: string,
): string | undefined {
  if (["find", "security_scan", "ida"].includes(toolName)) {
    return `${toolName} is not remote-adapted. Disconnect before using it on the local workspace; use remote grep/glob/bash for remote files.`;
  }
  if ((toolName === "read" || toolName === "write") && typeof asRecord(input).path === "string") {
    const device = xdevDevice(asRecord(input).path as string);
    if (device && ["find", "security_scan", "ida"].includes(device)) {
      return `${device} is not remote-adapted; local workspace execution is blocked while connected.`;
    }
  }
  if (toolName === "github" || (toolName === "write" &&
      xdevDevice(String(asRecord(input).path ?? "")) === "github")) {
    const params = toolName === "github" ? asRecord(input) : parseDeviceArgs(asRecord(input).content);
    const op = params?.op;
    const apiReads: Readonly<Record<string, true>> = { repo_view: true, file_read: true, search_issues: true, search_prs: true, search_code: true, search_commits: true, search_repos: true, run_watch: true };
    if (typeof op !== "string" || apiReads[op] !== true) {
      return "GitHub workspace operations are not remote-adapted. Use remote bash with an explicitly selected repository, or disconnect first.";
    }
    if (!op.startsWith("search_") && (typeof params?.repo !== "string" || !params.repo.trim())) {
      return "GitHub API reads require an explicit repo while remote is selected; inferring the local repository is disabled.";
    }
  }
  const params = asRecord(input);
  if (toolName === "task" && taskRequestsIsolation(params)) {
    return "Remote runtime does not support OMP local isolated worktrees. Use isolated:false or disconnect first.";
  }
  if (toolName === "bash" && params.async === true && !resolveLocalAsyncJobManager(sessionFile)) {
    return "Remote async bash requires the local OMP background job manager, which is unavailable in this session.";
  }
  return undefined;
}

function xdevDevice(path: string): string | undefined {
  const match = /^xd:\/\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(path);
  return match?.[1]?.toLowerCase();
}

function parseDeviceArgs(
  content: unknown,
): Record<string, unknown> | undefined {
  if (typeof content !== "string") return undefined;
  if (/^\s*(?:\?|help)?\s*$/i.test(content)) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function lspTier(args: Record<string, unknown>): "read" | "write" {
  const action =
    typeof args.action === "string" ? args.action.toLowerCase() : "";
  return LSP_READONLY_ACTIONS.has(action) ? "read" : "write";
}

function astEditTier(args: Record<string, unknown>): "read" | "write" {
  const paths = Array.isArray(args.paths)
    ? args.paths.filter((path): path is string => typeof path === "string")
    : [];
  return paths.length > 0 && paths.every(isInternalUri) ? "read" : "write";
}

function approvalFor(name: RemoteToolName): ToolApproval {
  if (name === "read") {
    return (args) =>
      normalizePathArgument(asRecord(args).path).includes("ssh://")
        ? "exec"
        : "read";
  }
  if (name === "grep") {
    return (args) =>
      JSON.stringify(args).includes("ssh://") ? "exec" : "read";
  }
  if (name === "glob" || name === "ast_grep") return "read";
  if (name === "edit") {
    return (args) =>
      pathShouldStayLocal("edit", asRecord(args)) ? "read" : "write";
  }
  if (name === "ast_edit") return (args) => astEditTier(asRecord(args));
  if (name === "lsp") return (args) => lspTier(asRecord(args));
  if (name === "debug") {
    return (args) => {
      const action = asRecord(args).action;
      return typeof action === "string" && DEBUG_READONLY_ACTIONS.has(action)
        ? "read"
        : "exec";
    };
  }
  if (name === "write") {
    return (args) => {
      const input = asRecord(args);
      const path = normalizePathArgument(input.path);
      const device = xdevDevice(path);
      if (device && (RESOLUTION_DEVICES.has(device) || device === "propose"))
        return "read";
      if (device === "lsp") {
        const inner = parseDeviceArgs(input.content);
        return inner ? lspTier(inner) : "exec";
      }
      if (device === "ast_grep") return "read";
      if (device === "ast_edit") {
        const inner = parseDeviceArgs(input.content);
        return inner ? astEditTier(inner) : "exec";
      }
      if (isInternalUri(path)) return "exec";
      return "write";
    };
  }
  return "exec";
}

function xdevDispatch(
  result: AgentToolResult,
): Record<string, unknown> | undefined {
  const details = result.details;
  if (!details || typeof details !== "object" || !("xdev" in details))
    return undefined;
  const xdev = details.xdev;
  return xdev && typeof xdev === "object"
    ? (xdev as Record<string, unknown>)
    : undefined;
}

export function stagedProposal(result: AgentToolResult): boolean {
  if (result.isError === true) return false;
  const details = asRecord(result.details);
  if (details.applied === false && Number(details.totalReplacements) > 0)
    return true;
  const dispatch = xdevDispatch(result);
  const inner = asRecord(dispatch?.inner);
  return (
    dispatch?.tool === "ast_edit" &&
    inner.applied === false &&
    Number(inner.totalReplacements) > 0
  );
}

export function consumedResolution(result: AgentToolResult): boolean {
  const dispatch = xdevDispatch(result);
  const inner = asRecord(dispatch?.inner);
  // Native queueResolveHandler consumes a normally returned invocation even
  // when its business result isError (e.g. stale AST). A thrown apply has no
  // completed ResolveDetails and retains its pending entry.
  return (dispatch?.tool === "resolve" || dispatch?.tool === "reject") &&
    (inner.action === "apply" || inner.action === "discard") &&
    typeof inner.sourceToolName === "string";
}

async function localXdevAvailable(
  device: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.invokeTool) return false;
  const result = await ctx.invokeTool(
    { path: `xd://${device}`, content: "?" },
    { signal },
  );
  const dispatch = xdevDispatch(result);
  return (
    result.isError !== true &&
    dispatch?.tool === device &&
    dispatch.mode === "help"
  );
}

async function executionTarget(
  name: RemoteToolName,
  params: Record<string, unknown>,
  state: RemoteExtensionState,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ExecutionTarget> {
  const ownership = {
    selected: state.selected, binding: state.binding, editMode: effectiveHostEditMode(state, ctx),
    isLocalProcessId: (id: string) => resolveLocalAsyncJobManager(state.sessionFile)?.getAllJobs().some(job => job.id === id) === true ||
      AgentRegistry.global().list().some(agent => agent.id === id),
  };
  const owner = resourceOwnershipTarget(name, params, ownership);
  let target: ExecutionTarget;
  if (owner) target = owner;
  else if (name !== "write") {
    target = pathShouldStayLocal(name, params, effectiveHostEditMode(state, ctx)) ? "local" : "remote";
  } else {
    const path = normalizePathArgument(params.path);
    const device = xdevDevice(path);
    if (!device) {
      target = pathShouldStayLocal(name, params, effectiveHostEditMode(state, ctx)) ? "local" : "remote";
    } else if (RESOLUTION_DEVICES.has(device)) {
      target = state.proposalSources.at(-1) ?? "local";
    } else if (
      device === "propose" ||
      !REMOTE_XDEV_TOOLS.has(device as RemoteToolName)
    ) {
      target = "local";
    } else {
      const inner = parseDeviceArgs(params.content);
      const innerOwner = inner ? resourceOwnershipTarget(device as RemoteToolName, inner, ownership) : undefined;
      target = !inner || !(await localXdevAvailable(device, ctx, signal))
        ? "local"
        : innerOwner ?? (pathShouldStayLocal(device as RemoteToolName, inner, effectiveHostEditMode(state, ctx)) ? "local" : "remote");
    }
  }
  if (target === "remote" && (name === "read" || name === "edit") &&
      state.editMode !== effectiveHostEditMode(state, ctx)) {
    throw new Error("The host edit mode changed after connection. Reconnect before reading or editing the remote workspace.");
  }

  if (target === "remote" && !state.client) {
    if (state.selected) {
      throw new Error(
        state.connectionError ??
          "Remote runtime is disconnected; local fallback is disabled",
      );
    }
    return "local";
  }
  return target;
}

function hostEvalInvoker(state: RemoteExtensionState, client: RemoteRuntimeClient, ctx: ExtensionContext): HostToolInvoker {
  const binding = state.binding;
  const owner = hostSessionFor(state, ctx);
  const sessionFile = ctx.sessionManager.getSessionFile();
  return async (invocation, signal, onUpdate) => {
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!owner || hostSessionFor(state, ctx) !== owner || ctx.sessionManager.getSessionFile() !== sessionFile ||
          state.client !== client || client.isClosed || state.binding !== binding || invocation.resourceBinding !== binding) {
        throw new Error("Remote Eval invocation belongs to a closed or changed workspace/session binding");
      }
    };
    assertCurrent();
    assertNestedRemoteTool(invocation.tool, invocation.args, binding, effectiveHostEditMode(state, ctx));
    if (!state.wrappedTools.has(invocation.tool)) throw new Error(`Remote Eval tool.${invocation.tool} is not owned by this remote wrapper`);
    const tool = owner!.getToolForEvalBridge(invocation.tool);
    if (!tool) throw new Error(`Remote Eval tool.${invocation.tool} is not enabled by the host`);
    const args = validateAgentToolArguments(tool, {
      type: "toolCall", id: invocation.toolCallId, name: invocation.tool, arguments: invocation.args,
    }, "payload");
    // Fresh native-shaped session context: never inherit a model-loop dispatch
    // marker or the outer Eval's already-granted approval/provider metadata.
    const context: ReturnType<ToolContextStore["getContext"]> = {
      sessionManager: ctx.sessionManager, modelRegistry: ctx.modelRegistry,
      model: owner!.model, settings: owner!.settings,
      ui: ctx.ui, hasUI: ctx.hasUI, localProtocolOptions: ctx.localProtocolOptions,
      toolNames: owner!.getActiveToolNames(), isIdle: () => ctx.isIdle(),
      hasQueuedMessages: () => ctx.hasPendingMessages(), abort: () => ctx.abort(),
    };
    return nestedDispatchScope.run({ assertCurrent }, async () => {
      const result = await tool.execute(invocation.toolCallId, args, signal, onUpdate, context);
      assertCurrent();
      return result;
    });
  };
}

async function executeWithTarget(
  target: ExecutionTarget,
  name: RemoteToolName,
  toolCallId: string,
  params: Record<string, unknown>,
  state: RemoteExtensionState,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: (update: unknown) => void,
): Promise<AgentToolResult> {
  if (target === "local") {
    if (!ctx.invokeTool)
      throw new Error(`OMP native fallback is unavailable for ${name}`);
    return ctx.invokeTool(params, { signal, onUpdate });
  }
  const client = state.client;
  if (!client) throw new Error("Remote runtime is disconnected");
  const remoteParams = resolveRemoteResourceArgs(name, params, state.binding);
  const execute = async (steeringSignal?: AbortSignal) =>
    await client.execute(name, toolCallId, remoteParams, signal, onUpdate,
      { toolNames: state.activeToolNames(), steeringSignal, ...(name === "eval" ? { onInvoke: hostEvalInvoker(state, client, ctx) } : {}) }) as AgentToolResult;
  try {
    if (name === "bash" && typeof params.name === "string" && params.ready !== undefined) {
      const sessionFile = ctx.sessionManager.getSessionFile() ?? state.sessionFile;
      const session = AgentRegistry.global().list().find((ref) =>
        sessionFile && ref.sessionFile && resolvePath(ref.sessionFile) === resolvePath(sessionFile),
      )?.session;
      return await withReadinessSteering(session ?? undefined, execute);
    }
    return await execute();
  } catch (error) {
    throw new Error(
      `Remote ${name} failed (${state.remoteCwd ?? "disconnected"}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function remoteWrapperRenderer(name: RemoteToolName) {
  // OMP's transcript accepts undefined components for both native and custom
  // renderers; the extension declaration still requires Component.
  return (toolRenderers[name] ?? {}) as Omit<(typeof toolRenderers)[string], "renderCall" | "renderResult"> & Pick<ToolDefinition, "renderCall" | "renderResult">;
}

function remoteBashJobOptions(
  toolCallId: string,
  params: Record<string, unknown>,
  state: RemoteExtensionState,
  ctx: ExtensionContext,
  onUpdate?: (update: AgentToolResult) => void,
): RemoteAsyncBashJobOptions {
  const client = state.client;
  if (!client) throw new Error("Remote runtime is disconnected");
  const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? state.sessionFile;
  const manager = resolveLocalAsyncJobManager(sessionFile);
  if (!manager) {
    throw new Error(
      "Remote async bash requires the local OMP background job manager, which is unavailable in this session.",
    );
  }
  const command = typeof params.command === "string" ? params.command : "";
  if (!command) throw new Error("bash requires a command");
  const ownerId = resolveJobOwnerId(
    sessionFile ? resolvePath(sessionFile) : undefined,
  );
  if (!ownerId) {
    throw new Error(
      "Remote async bash could not resolve the owning OMP agent; run it in the foreground instead.",
    );
  }
  const remoteCwd = state.remoteCwd ?? "remote";
  return {
    manager,
    ownerId,
    command,
    params,
    remoteCwd,
    maxTimeout: captureLocalExecutionSettings()["tools.maxTimeout"] as number | undefined,
    onUpdate,
    execute: async (remoteParams, signal, onUpdate, onCapture, scope = "job") => {
      if (state.client !== client || client.isClosed) {
        throw new Error(
          `Remote bash job lost its runtime (${remoteCwd}); the connection was closed`,
        );
      }
      return (await client.execute(
        "bash",
        `${toolCallId}:async`,
        remoteParams,
        signal,
        onUpdate,
        { toolNames: state.activeToolNames(), bashScope: scope, onCapture },
      )) as AgentToolResult;
    },
  };
}

function registerWrapper(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
  name: RemoteToolName,
  native: ToolInfo,
): void {
  const hostSession = AgentRegistry.global().list().find(
    (ref) => ref.sessionFile === state.sessionFile,
  )?.session;
  const original = hostSession?.getToolByName(name);
  const approval = remoteWrapperApproval(
    name,
    typeof original?.approval === "function" ? original.approval.bind(original) : original?.approval ?? approvalFor(name),
    original?.approvalCacheTargets?.bind(original),
    () => ({ ...state, editMode: effectiveHostEditMode(state) }),
  );
  pi.registerTool({
    name,
    label: original?.label ?? TOOL_LABELS[name],
    get description() { return original?.description ?? native.description; },
    get parameters() { return original?.parameters ?? native.parameters; },
    ...remoteWrapperRenderer(name),
    loadMode: original?.loadMode ?? "essential",
    readsSkillUris: original?.readsSkillUris,
    deferrable: original?.deferrable,
    strict: original?.strict,
    get customWireName() { return original?.customWireName; },
    get customFormat() { return original?.customFormat; },
    approval: approval.approval,
    approvalCacheTargets: approval.approvalCacheTargets,
    async execute(toolCallId, rawParams, signal, rawOnUpdate, ctx) {
      const nested = nestedDispatchScope.getStore();
      nested?.assertCurrent();
      if (nested) assertNestedRemoteTool(name, rawParams as Record<string, unknown>, state.binding, effectiveHostEditMode(state, ctx));
      approval.assertBinding(rawParams);
      const params = rawParams as Record<string, unknown>;
      const binding = state.binding;
      const ensureCurrent = () => {
        nested?.assertCurrent();
        if (state.binding !== binding) throw new Error("Workspace binding changed during this call; execution was not retried in the new workspace. Recheck the current workspace before continuing.");
      };
      const target = await executionTarget(name, params, state, ctx, signal);
      ensureCurrent();
      if (nested && target !== "remote") throw new Error(`Eval tool.${name} cannot access local host resources from the remote runtime`);
      const serviceName = name === "bash" && target === "remote" && typeof params.name === "string" ? params.name.trim() || undefined : undefined;
      if (name === "bash" && target === "remote" && params.async === true && !serviceName) {
        return startRemoteAsyncBashJob(remoteBashJobOptions(toolCallId, params, state, ctx, rawOnUpdate));
      }
      if (name === "bash" && target === "remote" && !serviceName && !params.pty) {
        const file = ctx.sessionManager?.getSessionFile?.() ?? state.sessionFile;
        const liveSession = AgentRegistry.global().list().find(ref => ref.sessionFile === file)?.session;
        const autoManager = resolveLocalAsyncJobManager(file);
        if (liveSession && lookup("bash.autoBackground.enabled")?.get(liveSession.settings) === true && autoManager && !autoManager.atCapacity) {
          const result = await withReadinessSteering(liveSession, steeringSignal => runRemoteForegroundBashJob({
            ...remoteBashJobOptions(toolCallId, params, state, ctx, rawOnUpdate), signal, steeringSignal,
            thresholdMs: Math.floor(Number(lookup("bash.autoBackground.thresholdMs")?.get(liveSession.settings) ?? 60_000)),
          }));
          ensureCurrent();
          return result;
        }
      }
      if (!nested && name === "read" && isProcessListingPath(params.path) && target === "remote") {
        const remote = await executeWithTarget(target, name, toolCallId, params, state, ctx, signal);
        ensureCurrent();
        const local = await executeWithTarget("local", name, `${toolCallId}:local`, params, state, ctx, signal);
        ensureCurrent();
        return mergeProcessListings(local, remote);
      }
      const manager = resolveLocalAsyncJobManager(state.sessionFile);
      if (serviceName && (manager?.getAllJobs().some((job) => job.id === serviceName) || AgentRegistry.global().list().some((agent) => agent.id === serviceName))) {
        throw new Error(`Remote service name ${serviceName} conflicts with a local job or agent`);
      }
      const execute = (executionSignal = signal) => {
        ensureCurrent();
        return executeWithTarget(
          target, name, toolCallId, params, state, ctx, executionSignal,
          (update) => { if (state.binding === binding) rawOnUpdate?.(update as AgentToolResult); },
        );
      };
      let result: AgentToolResult;
      if (serviceName) {
        if (!manager || !state.client) throw new Error("Remote service requires the current session job manager and transport");
        const owner = resolveJobOwnerId(state.sessionFile);
        if (!owner) throw new Error("Remote service requires a registered session owner");
        result = await startRemoteService(state.client, serviceName, owner, manager, execute, signal);
      } else {
        result = await execute();
      }
      ensureCurrent();
      if (name === "write" && target === "remote" && state.client) {
        completeStoppedService(state.client, result);
      }
      if (
        (name === "ast_edit" ||
          (name === "write" &&
            xdevDevice(normalizePathArgument(params.path)) === "ast_edit")) &&
        stagedProposal(result)
      ) {
        state.proposalSources.push(target);
      }
      if (name === "write" && consumedResolution(result))
        state.proposalSources.pop();
      return result;
    },
  });
  state.wrappedTools.add(name);
}
export async function captureOmpHandshake(pi: ExtensionAPI, state: RemoteExtensionState, ctx?: ExtensionContext) {
  const hostVersion = await resolveOmpHostVersion();
  const editMode = effectiveHostEditMode(state, ctx);
  const host = hostSessionFor(state, ctx);
  const metadata = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const missing = REMOTE_TOOL_NAMES.filter((name) => !metadata.has(name));
  // Only setting-gated tools absent from the actual registry need a fallback.
  // Never substitute a default editor for the editor advertised by the host.
  const fallback = missing.length ? await createNativeWorkerRuntime(
    ctx?.cwd ?? state.localCwd ?? process.cwd(), hostVersion,
    { editMode, settings: host ? captureExecutionSettings(host.settings) : captureLocalExecutionSettings() },
  ) : undefined;
  try {
    const localTools = REMOTE_TOOL_NAMES.map((name) => {
      const live = host?.getToolByName(name);
      const info = metadata.get(name);
      const native = info ? {
        name, parameters: live?.parameters ?? info.parameters,
        customFormat: live?.customFormat, customWireName: live?.customWireName,
      } : fallback?.tools[name];
      if (!native) throw new Error(`Local OMP tool metadata is unavailable: ${name}`);
      return captureOmpToolSnapshot(native);
    });
    return createOmpRuntimeHandshake({ hostVersion, localTools, editMode });
  } finally {
    await fallback?.dispose();
  }
}


async function registerActiveWrappers(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
): Promise<void> {
  const active = new Set(pi.getActiveTools());
  const metadata = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  for (const name of REMOTE_TOOL_NAMES) {
    if (!active.has(name) || state.wrappedTools.has(name)) continue;
    const native = metadata.get(name);
    if (!native)
      throw new Error(`OMP native tool metadata is unavailable: ${name}`);
    // Preserve other plugins' ownership; remote calls to unbound names fail closed.
    if (native.sourceInfo.source !== "builtin") continue;
    registerWrapper(pi, state, name, native);
  }
  const hostSession = AgentRegistry.global().list().find((ref) => ref.sessionFile === state.sessionFile)?.session;
  await hostSession?.runToolRegistryMutation(async () => {});
}

function detachRemoteState(
  state: RemoteExtensionState,
  restoreLocal: boolean,
): RemoteRuntimeClient | undefined {
  const current = state.client;
  state.client = undefined;
  state.binding = crypto.randomUUID();
  state.remoteCwd = restoreLocal ? undefined : state.remoteCwd;
  state.selected = !restoreLocal;
  state.owner = false;
  state.connectionError = restoreLocal
    ? undefined
    : "Remote runtime family disconnected; local fallback is disabled";
  state.proposalSources = state.proposalSources.filter(
    (source) => source === "local",
  );
  const family = state.family;
  if (restoreLocal) {
    if (family) remoteFamilyBroker.detach(family, state);
    state.family = undefined;
  }
  return current;
}

async function closeRemoteState(
  state: RemoteExtensionState,
  timeoutMs?: number,
): Promise<void> {
  const current = detachRemoteState(state, true);
  if (current) await current.close(timeoutMs);
}

export async function closeRemoteFamily(
  family: RemoteFamily,
  timeoutMs?: number,
): Promise<void> {
  remoteFamilyBroker.revoke(family);
  const clients = [...family.members]
    .map((member) => detachRemoteState(member, member.owner))
    .filter((client): client is RemoteRuntimeClient => client !== undefined);
  const settled = await Promise.allSettled(
    clients.map((client) => client.close(timeoutMs)),
  );
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Failed to close remote session family",
    );
  }
}

/**
 * Deliver remote broker completions the way the native hub does: one
 * model-visible custom message per terminal daemon exit. `followUp` queues
 * during streaming and starts a turn when idle, matching the yield-queue
 * semantics of the native `queueLaunchCompletion` path closely enough for the
 * model to react to a remote service exiting.
 */
function bindLaunchCompletionDelivery(
  pi: ExtensionAPI,
  client: RemoteRuntimeClient,
): void {
  client.onEvent((event) => {
    if (event.event !== "launch-completion") return;
    const notification = event.payload as unknown as DaemonCompletionNotification;
    if (!notification?.daemon || typeof notification.daemon !== "object") throw new Error("Invalid remote launch completion");
    if (completeService(client, notification.daemon.name, notification)) return;
    const message = buildLaunchCompletionBatchMessage([notification]);
    pi.sendMessage(
      {
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
        attribution: message.attribution,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}

function launchOwnerId(ctx: ExtensionContext | undefined): string | undefined {
  const id = ctx?.sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Spawn the SSH worker, run the admission handshake, and bind event delivery. */
async function openRemoteTransport(
  pi: ExtensionAPI,
  connection: RemoteConnectOptions & { workerPath: string },
  cwd: string,
  state: RemoteExtensionState,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ client: RemoteRuntimeClient; ready: ReadyMessage; binding: string }> {
  const handshake = await captureOmpHandshake(pi, state, ctx);
  const binding = crypto.randomUUID();
  const client = new RemoteRuntimeClient({
    command: buildSshWorkerCommand(connection),
  });
  try {
    const ready = await client.initialize(cwd, handshake, undefined, {
      sessionId: launchOwnerId(ctx),
      settings: hostSessionFor(state, ctx) ? captureExecutionSettings(hostSessionFor(state, ctx)!.settings) : captureLocalExecutionSettings(),
      signal,
      resourceBinding: binding,
    });
    bindLaunchCompletionDelivery(pi, client);
    return { client, ready, binding };
  } catch (error) {
    client.kill();
    throw error;
  }
}

export type RemoteReconnectOutcome = {
  target: string;
  remoteCwd: string;
  droppedRemoteProposals: number;
  replacedLiveTransport: boolean;
  cacheAudit: RemoteWorkerCacheAudit;
};

/**
 * Re-establish the owner's transport for an already-selected remote family
 * using its stored connection spec. Tool wrappers resolve `state.client` per
 * call, so swapping the client in place restores routing without touching the
 * tool registry. Two things intentionally do not survive: remote-staged AST
 * proposals (they lived in the dead worker's memory) and non-persistent hub
 * services (the old worker's EOF cleanup stopped them). Fails closed: on any
 * error the session stays selected and unavailable.
 */
async function reconnectRemoteRuntime(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
  ctx: ExtensionContext | undefined,
  options: { force: boolean; signal?: AbortSignal },
): Promise<RemoteReconnectOutcome> {
  if (state.deployment) throw new Error("Remote connection is already in progress");
  if (!state.selected) {
    throw new Error("No remote runtime is selected; use /remote-connect <target> [cwd]");
  }
  const family = state.family;
  if (!family || family.closing) throw new Error("Remote runtime family state is missing");
  options.signal?.throwIfAborted();
  const live = state.client !== undefined && !state.client.isClosed;
  if (live && !options.force) {
    throw new Error("Remote runtime transport is still connected; pass --force to replace it");
  }
  const previous = state.client;
  state.client = undefined;
  state.binding = crypto.randomUUID();
  previous?.kill();
  const droppedRemoteProposals = state.proposalSources.filter((source) => source === "remote").length;
  state.proposalSources = state.proposalSources.filter((source) => source === "local");
  state.connectionError = "Remote runtime reconnect in progress";
  family.cacheAudit = undefined;
  const deployment = new AbortController();
  state.deployment = deployment;
  let prepared: PreparedRemoteWorker | undefined;
  let next: RemoteRuntimeClient | undefined;
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, deployment.signal]) : deployment.signal;
    prepared = await prepareRemoteWorker({ ...family.connection, signal, onProgress: (stage) => ctx?.ui?.setWorkingMessage(stage) });
    const connection = { ...family.connection, cwd: family.remoteCwd, workerPath: prepared.workerPath };
    const { client, ready, binding } = await openRemoteTransport(
      pi,
      connection,
      family.remoteCwd,
      state,
      ctx,
      prepared.signal,
    );
    next = client;
    if (family.closing || signal.aborted) {
      client.kill();
      signal.throwIfAborted();
      throw new Error("Remote session family was closed during reconnect");
    }
    const remoteCwd: string = ready.cwd ?? family.remoteCwd;
    if (remoteCwd !== family.remoteCwd) {
      client.kill();
      throw new Error("Remote workspace canonical directory changed during reconnect");
    }
    await prepared.commitUsage();
    if (state.owner) family.connection = connection;
    state.client = client;
    state.binding = binding;
    state.remoteCwd = remoteCwd;
    state.connectionError = undefined;
    family.cacheAudit = prepared.cacheAudit;
    state.editMode = ready.editMode;
    return {
      target: family.connection.displayTarget,
      remoteCwd,
      droppedRemoteProposals,
      replacedLiveTransport: live,
      cacheAudit: prepared.cacheAudit,
    };
  } catch (error) {
    next?.kill();
    state.connectionError = `Remote runtime reconnect failed: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    await prepared?.dispose();
    if (state.deployment === deployment) state.deployment = undefined;
  }
}

function describeReconnect(outcome: RemoteReconnectOutcome): string {
  const notes: string[] = [];
  if (outcome.replacedLiveTransport) notes.push("replaced a live transport");
  if (outcome.droppedRemoteProposals > 0) {
    notes.push(`${outcome.droppedRemoteProposals} remote staged proposal(s) were lost with the old worker`);
  }
  notes.push("non-persistent remote services stopped by the disconnect are not restarted");
  return `Remote runtime reconnected: ${outcome.target}:${outcome.remoteCwd} (${notes.join("; ")})\n${describeRemoteWorkerCacheAudit(outcome.cacheAudit)}`;
}

async function attachFamilyMember(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
  family: RemoteFamily,
  ctx?: ExtensionContext,
): Promise<void> {
  if (state.selected) return;
  state.selected = true;
  state.binding = crypto.randomUUID();
  state.owner = false;
  state.family = family;
  state.remoteCwd = family.remoteCwd;
  remoteFamilyBroker.attach(family, state);
  if (family.closing) {
    state.connectionError = "Remote runtime family was revoked; descendants cannot fall back locally";
    return;
  }

  if (
    !state.localCwd ||
    resolvePath(state.localCwd) !== resolvePath(family.localCwd)
  ) {
    state.connectionError = `Remote subagent inheritance rejected: local cwd ${state.localCwd ?? "unknown"} differs from owner cwd ${family.localCwd}. Local isolated worktrees are not supported.`;
    return;
  }

  let next: RemoteRuntimeClient | undefined;
  try {
    const opened = await openRemoteTransport(pi, family.connection, family.remoteCwd, state, ctx);
    next = opened.client;
    if (family.closing)
      throw new Error(
        "Remote session family disconnected during subagent initialization",
      );
    state.client = next;
    state.binding = opened.binding;
    state.remoteCwd = opened.ready.cwd;
    state.connectionError = undefined;
    state.editMode = opened.ready.editMode;
  } catch (error) {
    next?.kill();
    state.connectionError = `Remote subagent runtime failed: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

export default async function remoteRuntimeExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const state: RemoteExtensionState = {
    binding: crypto.randomUUID(),
    wrappedTools: new Set(),
    proposalSources: [],
    selected: false,
    owner: false,
    activeToolNames: () => {
      try {
        const names = pi.getActiveTools?.();
        return Array.isArray(names) ? names : undefined;
      } catch {
        return undefined;
      }
    },
  };
  // Compare the running host against the version this bundle (and its
  // companion workers) were compiled for. A mismatch is the usual root cause of
  // "schema is incompatible" handshake rejections after `omp update`.
  const hostCompatibility = ompHostCompatibility(await resolveOmpHostVersion().catch(() => undefined));
  let hostCompatibilityNotified = false;

  pi.registerTool({
    name: REMOTE_WORKSPACE_STATUS_TOOL,
    label: "Remote Workspace Status",
    description:
      `Report the current workspace binding and execution boundaries. ${WORKSPACE_RULES}`,
    parameters: z.object({}),
    loadMode: "essential",
    approval: "read",
    async execute() {
      const snapshot = workspaceStatus({
        selected: state.selected,
        clientPresent: state.client !== undefined,
        clientClosed: state.client?.isClosed ?? false,
        connectionError: state.connectionError,
        remoteCwd: state.remoteCwd,
        owner: state.owner,
        wrappedTools: state.wrappedTools,
        proposalSources: state.proposalSources,
        hostCompatibility,
        cacheAudit: state.family?.cacheAudit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        details: snapshot,
        useless: true,
      };
    },
  });

  pi.registerTool({
    name: "remote_connect",
    label: "Remote Connect",
    description:
      "Connect native workspace tools to a remote OMP runtime over SSH. Target can be an SSH alias or user@host. When cwd is omitted, defaults to remote $HOME. Transparently routes workspace tools (read, write, edit, bash, grep, glob, lsp, eval, debug) to the remote host.",
    parameters: z.object({
      target: z.string().describe("SSH host alias or user@host target"),
      cwd: z
        .string()
        .optional()
        .describe(
          "Remote working directory (defaults to remote $HOME if omitted)",
        ),
      identity: z.string().optional().describe("Private key file path"),
      port: z.number().int().positive().optional().describe("SSH port number"),
    }),
    loadMode: "essential",
    approval: "exec",
    async execute(_id, params: unknown, _signal, _onUpdate, ctx) {
      if (state.deployment) throw new Error("Remote connection is already in progress");
      if (state.selected) {
        throw new Error(
          "A remote runtime is already selected; call remote_exit first",
        );
      }
      const p = asRecord(params);
      const target = typeof p.target === "string" ? p.target : "";
      if (!target) {
        throw new Error(
          "Missing required 'target' parameter (SSH alias or user@host)",
        );
      }
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        throw new Error(
          "Remote runtime requires a persisted OMP session so subagents can inherit safely",
        );
      }
      const normalizedSessionFile = resolvePath(sessionFile);
      if (remoteFamilyBroker.hasOwner(normalizedSessionFile)) {
        throw new Error("This session already owns a remote runtime family");
      }
      const localCwd = ctx?.cwd ?? process.cwd();
      const configuredHosts = await loadConfiguredSshHosts(localCwd);

      const request = parseConnectOptions({
        target, cwd: p.cwd, identity: p.identity, port: p.port,
      }, configuredHosts);
      let next: RemoteRuntimeClient | undefined;
      let prepared: PreparedRemoteWorker | undefined;
      state.deployment = new AbortController();
      try {
        const signal = _signal ? AbortSignal.any([_signal, state.deployment.signal]) : state.deployment.signal;
        prepared = await prepareRemoteWorker({ ...request, signal, onProgress: (stage) => _onUpdate?.({ content: [{ type: "text", text: stage }] }) });
        const remoteCwd: string =
          request.cwd ?? prepared.home ?? (await resolveRemoteHome(request));
        const options: RemoteConnectOptions = { ...request, cwd: remoteCwd };
        const connection = {
          ...options,
          workerPath: prepared.workerPath,
        };
        const opened = await openRemoteTransport(pi, connection, options.cwd, state, ctx, prepared.signal);
        next = opened.client;
        state.deployment.signal.throwIfAborted();
        _signal?.throwIfAborted();
        await prepared.commitUsage();
        const ready = opened.ready;
        const resolvedRemoteCwd: string = ready.cwd ?? options.cwd;
        const family: RemoteFamily = {
          ownerSessionFile: normalizedSessionFile,
          root: sessionFamilyRoot(normalizedSessionFile),
          localCwd,
          remoteCwd: resolvedRemoteCwd,
          connection: { ...connection, cwd: resolvedRemoteCwd },
          cacheAudit: prepared.cacheAudit,
          members: new Set([state]),
          closing: false,
        };
        state.client = next;
        state.binding = opened.binding;
        state.remoteCwd = resolvedRemoteCwd;
        state.localCwd = localCwd;
        state.sessionFile = normalizedSessionFile;
        state.selected = true;
        state.owner = true;
        state.family = family;
        state.connectionError = undefined;
        state.editMode = ready.editMode;
        remoteFamilyBroker.register(family);
        ctx?.ui?.setStatus?.(
          "remote-runtime",
          `ssh ${request.displayTarget}:${ready.cwd}`,
        );
        ctx?.ui?.notify?.(
          `Remote runtime connected: ${request.displayTarget}:${ready.cwd}\n${describeRemoteWorkerCacheAudit(prepared.cacheAudit)}`,
          prepared.cacheAudit.available ? "info" : "warning",
        );
        const details = {
          success: true,
          mode: "remote",
          target: request.displayTarget,
          remoteCwd: resolvedRemoteCwd,
          wrappedTools: [...state.wrappedTools],
          cacheAudit: prepared.cacheAudit,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
        };
      } catch (error) {
        next?.kill();
        throw error;
      } finally {
        await prepared?.dispose();
        state.deployment = undefined;
      }
    },
  });

  pi.registerTool({
    name: "remote_exit",
    label: "Remote Exit",
    description:
      "Disconnect the active remote runtime and restore local native tools. Pass force: true to disconnect even if subagents or pending proposals exist.",
    parameters: z.object({
      force: z
        .boolean()
        .optional()
        .describe(
          "Force disconnect even if subagents are active or proposals pending",
        ),
    }),
    loadMode: "essential",
    approval: "exec",
    async execute(_id, params: unknown, _signal, _onUpdate, ctx) {
      state.deployment?.abort(new Error("Remote connection cancelled by remote_exit"));
      const p = asRecord(params);
      const force = p.force === true;
      if (!state.selected) {
        return {
          content: [
            {
              type: "text",
              text: "Remote runtime is already disconnected; workspace tools are local.",
            },
          ],
          details: { success: true, mode: "local" },
        };
      }
      if (!state.owner) {
        throw new Error(
          "Only the owning OMP session can disconnect the remote runtime family",
        );
      }
      const family = state.family;
      if (!family) throw new Error("Remote runtime family state is missing");
      if (!force) {
        const remoteProposalCount = [...family.members].reduce(
          (count, member) =>
            count +
            member.proposalSources.filter((source) => source === "remote")
              .length,
          0,
        );
        if (remoteProposalCount > 0) {
          throw new Error(
            "Remote staged proposals are pending; resolve/reject them first, or pass force: true",
          );
        }
        if (family.members.size > 1) {
          throw new Error(
            "Remote subagent sessions are still active; wait for them or pass force: true",
          );
        }
      }
      await closeRemoteFamily(family);
      ctx?.ui?.setStatus?.("remote-runtime", undefined);
      ctx?.ui?.notify?.(
        "Disconnected from remote runtime; workspace tools restored to local",
        "info",
      );
      return {
        content: [
          {
            type: "text",
            text: "Disconnected from remote runtime; workspace tools restored to local.",
          },
        ],
        details: { success: true, mode: "local" },
      };
    },
  });

  pi.registerTool({
    name: "remote_reconnect",
    label: "Remote Reconnect",
    description:
      "Re-establish the SSH transport for the currently selected remote runtime after a connection loss, reusing the stored target, cwd, and options. Remote staged AST proposals and non-persistent remote services from before the loss do not survive. Pass force: true to replace a transport that is still connected.",
    parameters: z.object({
      force: z
        .boolean()
        .optional()
        .describe("Replace the transport even if it is still connected"),
    }),
    loadMode: "essential",
    approval: "exec",
    async execute(_id, params: unknown, _signal, _onUpdate, ctx) {
      const p = asRecord(params);
      const outcome = await reconnectRemoteRuntime(pi, state, ctx, { force: p.force === true, signal: _signal });
      ctx?.ui?.setStatus?.("remote-runtime", `ssh ${outcome.target}:${outcome.remoteCwd}`);
      ctx?.ui?.notify?.(describeReconnect(outcome), outcome.cacheAudit.available ? "info" : "warning");
      const details = { success: true, mode: "remote", ...outcome, wrappedTools: [...state.wrappedTools] };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  pi.registerCommand("remote-connect", {
    description: "Connect native workspace tools to a remote OMP runtime",
    async handler(args, ctx) {
      if (state.deployment) throw new Error("Remote connection is already in progress; /remote-exit cancels deployment");
      if (state.selected)
        throw new Error(
          "A remote runtime is already selected; run /remote-exit first",
        );
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile)
        throw new Error(
          "Remote runtime requires a persisted OMP session so subagents can inherit safely",
        );
      const normalizedSessionFile = resolvePath(sessionFile);
      if (remoteFamilyBroker.hasOwner(normalizedSessionFile))
        throw new Error("This session already owns a remote runtime family");
      const configuredHosts = await loadConfiguredSshHosts(ctx.cwd);

      const request = parseConnectArgs(args, configuredHosts);
      ctx.ui.setWorkingMessage("Deploying remote OMP runtime");
      let next: RemoteRuntimeClient | undefined;
      let prepared: PreparedRemoteWorker | undefined;
      state.deployment = new AbortController();
      try {
        prepared = await prepareRemoteWorker({ ...request, signal: state.deployment.signal, onProgress: (stage) => ctx.ui.setWorkingMessage(stage) });
        const remoteCwd: string =
          request.cwd ?? prepared.home ?? (await resolveRemoteHome(request));
        const options: RemoteConnectOptions = { ...request, cwd: remoteCwd };
        const connection = {
          ...options,
          workerPath: prepared.workerPath,
        };
        const opened = await openRemoteTransport(pi, connection, options.cwd, state, ctx, prepared.signal);
        next = opened.client;
        state.deployment.signal.throwIfAborted();
        await prepared.commitUsage();
        const ready = opened.ready;
        const resolvedRemoteCwd: string = ready.cwd ?? options.cwd;
        const family: RemoteFamily = {
          ownerSessionFile: normalizedSessionFile,
          root: sessionFamilyRoot(normalizedSessionFile),
          localCwd: ctx.cwd,
          remoteCwd: resolvedRemoteCwd,
          connection: { ...connection, cwd: resolvedRemoteCwd },
          cacheAudit: prepared.cacheAudit,
          members: new Set([state]),
          closing: false,
        };
        state.client = next;
        state.binding = opened.binding;
        state.remoteCwd = resolvedRemoteCwd;
        state.localCwd = ctx.cwd;
        state.sessionFile = normalizedSessionFile;
        state.selected = true;
        state.owner = true;
        state.family = family;
        state.connectionError = undefined;
        state.editMode = ready.editMode;
        remoteFamilyBroker.register(family);
        ctx.ui.setStatus(
          "remote-runtime",
          `ssh ${request.displayTarget}:${ready.cwd}`,
        );
        ctx.ui.notify(
          `Remote runtime connected: ${request.displayTarget}:${ready.cwd}\n${describeRemoteWorkerCacheAudit(prepared.cacheAudit)}`,
          prepared.cacheAudit.available ? "info" : "warning",
        );
      } catch (error) {
        next?.kill();
        throw error;
      } finally {
        await prepared?.dispose();
        state.deployment = undefined;
        ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("remote-status", {
    description: "Show the active remote runtime",
    async handler(_args, ctx) {
      const status = !state.selected
        ? "Remote runtime: disconnected (local tools active)"
        : state.connectionError
          ? `Remote runtime: unavailable (fail-closed): ${state.connectionError}`
          : state.client?.isClosed
            ? `Remote runtime: connection lost at ${state.remoteCwd} (fail-closed)`
            : `Remote runtime: ${state.remoteCwd}; role=${state.owner ? "owner" : "subagent"}; tools=${[...state.wrappedTools].join(",")}; pending=${state.proposalSources.length}`;
      const build = hostCompatibility.compatible
        ? `plugin built for OMP ${hostCompatibility.compiledHostVersion}`
        : (hostCompatibility.advice ?? "plugin build version unknown");
      const cacheAudit = state.family?.cacheAudit;
      const audit = state.selected && cacheAudit ? ` Last deployment (${cacheAudit.observedAt}): ${describeRemoteWorkerCacheAudit(cacheAudit)}` : "";
      ctx.ui.notify(`${status}. ${build}${audit}`, hostCompatibility.compatible ? "info" : "warning");
    },
  });

  pi.registerCommand("remote-reconnect", {
    description: "Re-establish the remote runtime transport after a connection loss",
    async handler(args, ctx) {
      const force = args.trim() === "--force";
      ctx.ui.setWorkingMessage("Reconnecting remote OMP runtime");
      try {
        const outcome = await reconnectRemoteRuntime(pi, state, ctx, { force });
        ctx.ui.setStatus("remote-runtime", `ssh ${outcome.target}:${outcome.remoteCwd}`);
        ctx.ui.notify(describeReconnect(outcome), outcome.cacheAudit.available ? "info" : "warning");
      } finally {
        ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("remote-exit", {
    description: "Disconnect the remote runtime and restore local native tools",
    async handler(args, ctx) {
      state.deployment?.abort(new Error("Remote connection cancelled by /remote-exit"));
      const force = args.trim() === "--force";
      if (!state.selected) {
        ctx.ui.notify(
          "Remote runtime is already disconnected; workspace tools are local",
          "info",
        );
        return;
      }
      if (!state.owner)
        throw new Error(
          "Only the owning OMP session can disconnect the remote runtime family",
        );
      const family = state.family;
      if (!family) throw new Error("Remote runtime family state is missing");
      if (!force) {
        const remoteProposalCount = [...family.members].reduce(
          (count, member) =>
            count +
            member.proposalSources.filter((source) => source === "remote")
              .length,
          0,
        );
        if (remoteProposalCount > 0) {
          throw new Error(
            "Remote staged proposals are pending; resolve/reject them first, or run /remote-exit --force",
          );
        }
        if (family.members.size > 1) {
          throw new Error(
            "Remote subagent sessions are still active; wait for them or run /remote-exit --force",
          );
        }
      }
      await closeRemoteFamily(family);
      ctx.ui.setStatus("remote-runtime", undefined);
      ctx.ui.notify(
        "Remote runtime disconnected; workspace tools are local",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.localCwd = ctx.cwd;
    if (!hostCompatibility.compatible && !hostCompatibilityNotified && hostCompatibility.advice) {
      hostCompatibilityNotified = true;
      ctx.ui.notify(`omp-ssh-remote: ${hostCompatibility.advice}`, "warning");
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const normalized = resolvePath(sessionFile);
    state.sessionFile = normalized;
    state.editMode = effectiveHostEditMode(state, ctx);
    await registerActiveWrappers(pi, state);
    const family = remoteFamilyBroker.find(normalized);
    if (!family) return;
    await attachFamilyMember(pi, state, family, ctx);
  });

  const closeBeforeSessionNavigation = async (
    ctx: ExtensionContext,
  ): Promise<{ cancel: true } | undefined> => {
    if (!state.selected) return;
    const family = state.family;
    const blockReason = remoteSessionNavigationBlockReason({
      selected: state.selected,
      owner: state.owner,
      familyMemberCount: family?.members.size ?? 0,
      remoteProposalCount:
        family && state.owner
          ? [...family.members].reduce(
              (count, member) =>
                count +
                member.proposalSources.filter((source) => source === "remote")
                  .length,
              0,
            )
          : 0,
    });
    if (blockReason) {
      ctx.ui.notify(blockReason, "warning");
      return { cancel: true };
    }
    try {
      if (state.owner && family) {
        await closeRemoteFamily(family);
      } else {
        await closeRemoteState(state);
      }
      ctx.ui.notify(
        "Remote runtime disconnected before session navigation; workspace tools are local",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        `Remote runtime stopped before session navigation: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    return undefined;
  };

  pi.on("session_before_switch", async (_event, ctx) => {
    return closeBeforeSessionNavigation(ctx);
  });

  pi.on("session_before_branch", async (_event, ctx) => {
    return closeBeforeSessionNavigation(ctx);
  });
  // Returning an explicit result is required: OMP may swallow hook exceptions
  // and otherwise continue with its local shell/Python runner.
  const blockedUserExecution = () => {
    const output = "Remote workspace selected: direct !/!! shell and $/$$ Python shortcuts are disabled. Use the remote bash/eval tool, or /remote-exit before executing locally.";
    const bytes = Buffer.byteLength(output);
    return { output, exitCode: 1, cancelled: false, truncated: false, totalLines: 1, outputLines: 1, totalBytes: bytes, outputBytes: bytes };
  };
  pi.on("user_bash", () => state.selected ? { result: blockedUserExecution() } : undefined);
  pi.on("user_python", () => state.selected ? { result: { ...blockedUserExecution(), displayOutputs: [], stdinRequested: false } } : undefined);
  pi.on("before_agent_start", (_event, ctx) => {
    const current: WorkspaceBindingNotice = {
      binding: state.binding,
      mode: !state.selected ? "local" : (!state.client || state.client.isClosed || state.connectionError) ? "unavailable" : "remote",
      target: state.selected ? state.family?.connection.displayTarget ?? null : null,
      cwd: (state.selected ? state.remoteCwd : state.localCwd) ?? null,
    };
    const message = workspaceAnnouncement(current, ctx.sessionManager.getBranch());
    return message ? { message } : undefined;
  });

  pi.on("tool_call", (event) => {
    if (!state.selected) return;
    if (event.toolName === "task" && (!state.client || state.client.isClosed || state.connectionError)) {
      return { block: true, reason: "Remote runtime is unavailable; spawning a new task cannot fall back locally. Reconnect first." };
    }
    const controlPlaneBlock = remoteControlPlaneBlockReason(
      event.toolName,
      event.input,
      state.sessionFile,
    );
    if (controlPlaneBlock) return { block: true, reason: controlPlaneBlock };
    if (
      !REMOTE_TOOL_SET.has(event.toolName) ||
      state.wrappedTools.has(event.toolName as RemoteToolName)
    )
      return;
    return {
      block: true,
      reason: `Remote runtime is selected, but ${event.toolName} was not bound at session initialization. Restart with the required tool enabled; execution is blocked rather than falling back locally.`,
    };
  });

  pi.on("session_shutdown", async () => {
    state.deployment?.abort(new Error("Session shutdown"));
    state.sessionFile = undefined;
    if (state.owner && state.family) {
      await closeRemoteFamily(
        state.family,
        SESSION_SHUTDOWN_REMOTE_CLOSE_TIMEOUT_MS,
      );
      return;
    }
    await closeRemoteState(state, SESSION_SHUTDOWN_REMOTE_CLOSE_TIMEOUT_MS);
  });
}
