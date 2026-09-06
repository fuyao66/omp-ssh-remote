import { resolve as resolvePath, sep } from "node:path";
import type { AgentToolResult, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/omptype/zod";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import {
  loadConfiguredSshHosts,
  parseConnectArgs,
  type RemoteConnectRequest,
} from "./connect-options.ts";
import { RemoteRuntimeClient } from "./client.ts";
import { prepareRemoteWorker, resolveRemoteHome } from "./deploy.ts";
import { REMOTE_TOOL_NAMES, type RemoteToolName } from "./protocol.ts";
import { createOmpRuntimeHandshake, toolParametersToWire } from "./omp/runtime-contract.ts";
import { resolveOmpHostVersion } from "./omp/host-identity.ts";
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
} from "./omp/async-bash.ts";
import { isHubLaunchOperation } from "./omp/hub-ops.ts";
import { buildLaunchCompletionBatchMessage } from "@oh-my-pi/pi-coding-agent/session/launch-completion";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";

function asyncBashAvailable(): boolean {
  return resolveLocalAsyncJobManager() !== undefined;
}

const REMOTE_TOOL_SET = new Set<string>(REMOTE_TOOL_NAMES);
const REMOTE_XDEV_TOOLS = new Set<RemoteToolName>([
  "lsp",
  "ast_grep",
  "ast_edit",
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
  hub: "hub",
};

const REMOTE_WORKSPACE_STATUS_TOOL = "remote_workspace_status";

export type RemoteWorkspaceStatus = {
  mode: "local" | "remote" | "unavailable";
  transport: "not-selected" | "connected" | "unavailable";
  remoteCwd: string | null;
  sessionRole: "owner" | "subagent" | null;
  connectionError: string | null;
  remoteWorkspaceTools: RemoteToolName[];
  pendingRemoteAstProposals: number;
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
    remoteWorkspaceTools: selected
      ? [...new Set(input.wrappedTools)].sort()
      : [],
    pendingRemoteAstProposals: [...input.proposalSources].filter(
      (source) => source === "remote",
    ).length,
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
            ? "hub start/ps/logs/stop/restart/describe and process send/wait run in the remote project broker; peer messaging and job ops stay local; non-persist services stop on remote exit"
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
  client?: RemoteRuntimeClient;
  remoteCwd?: string;
  localCwd?: string;
  sessionFile?: string;
  wrappedTools: Set<RemoteToolName>;
  proposalSources: ExecutionTarget[];
  selected: boolean;
  owner: boolean;
  family?: RemoteFamily;
  connectionError?: string;
};
type RemoteFamily = {
  ownerSessionFile: string;
  root: string;
  localCwd: string;
  remoteCwd: string;
  connection: RemoteConnectOptions & { workerPath: string };
  members: Set<RemoteExtensionState>;
  closing: boolean;
};

const REMOTE_FAMILY_BROKER_KEY = Symbol.for("omp-ssh-remote/session-families");
type RemoteFamilyBrokerGlobal = typeof globalThis & {
  [REMOTE_FAMILY_BROKER_KEY]?: Map<string, RemoteFamily>;
};
const remoteFamilyGlobal = globalThis as RemoteFamilyBrokerGlobal;

const REMOTE_FAMILIES = (remoteFamilyGlobal[REMOTE_FAMILY_BROKER_KEY] ??=
  new Map<string, RemoteFamily>());

const SESSION_SHUTDOWN_REMOTE_CLOSE_TIMEOUT_MS = 1_000;

function sessionFamilyRoot(sessionFile: string): string {
  const normalized = resolvePath(sessionFile);
  return normalized.endsWith(".jsonl")
    ? normalized.slice(0, -".jsonl".length)
    : normalized;
}

export function sessionBelongsToFamily(
  ownerSessionFile: string,
  candidateSessionFile: string,
): boolean {
  const root = sessionFamilyRoot(ownerSessionFile);
  return resolvePath(candidateSessionFile).startsWith(`${root}${sep}`);
}

function findRemoteFamily(sessionFile: string): RemoteFamily | undefined {
  let best: RemoteFamily | undefined;
  for (const family of REMOTE_FAMILIES.values()) {
    if (
      family.closing ||
      !sessionBelongsToFamily(family.ownerSessionFile, sessionFile)
    )
      continue;
    if (!best || family.root.length > best.root.length) best = family;
  }
  return best;
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
): string | undefined {
  const params = asRecord(input);
  if (toolName === "task" && taskRequestsIsolation(params)) {
    return "Remote runtime does not support OMP local isolated worktrees. Use isolated:false or disconnect first.";
  }
  if (toolName === "bash" && params.async === true && !asyncBashAvailable()) {
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
  if (name === "hub") {
    return (args) => {
      const input = asRecord(args);
      const op = input.op;
      if (!isHubLaunchOperation(input)) return "read";
      if (op === "ps" || op === "logs" || op === "describe" || op === "wait")
        return "read";
      return "exec";
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

function successfulResolution(result: AgentToolResult): boolean {
  const dispatch = xdevDispatch(result);
  return (
    (dispatch?.tool === "resolve" || dispatch?.tool === "reject") &&
    result.isError !== true
  );
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
  let target: ExecutionTarget;
  if (name !== "write") {
    target = pathShouldStayLocal(name, params) ? "local" : "remote";
  } else {
    const path = normalizePathArgument(params.path);
    const device = xdevDevice(path);
    if (!device) {
      target = isInternalUri(path) ? "local" : "remote";
    } else if (RESOLUTION_DEVICES.has(device)) {
      target = state.proposalSources.at(-1) ?? "local";
    } else if (
      device === "propose" ||
      !REMOTE_XDEV_TOOLS.has(device as RemoteToolName)
    ) {
      target = "local";
    } else {
      const inner = parseDeviceArgs(params.content);
      target =
        !inner || !(await localXdevAvailable(device, ctx, signal))
          ? "local"
          : pathShouldStayLocal(device as RemoteToolName, inner)
            ? "local"
            : "remote";
    }
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
  if (!state.client) throw new Error("Remote runtime is disconnected");
  try {
    return (await state.client.execute(
      name,
      toolCallId,
      params,
      signal,
      onUpdate,
    )) as AgentToolResult;
  } catch (error) {
    throw new Error(
      `Remote ${name} failed (${state.remoteCwd ?? "disconnected"}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function remoteWrapperRenderer(name: RemoteToolName) {
  return toolRenderers[name] ?? {};
}

function startRemoteAsyncBash(
  toolCallId: string,
  params: Record<string, unknown>,
  state: RemoteExtensionState,
  ctx: ExtensionContext,
): AgentToolResult {
  const client = state.client;
  if (!client) throw new Error("Remote runtime is disconnected");
  const manager = resolveLocalAsyncJobManager();
  if (!manager) {
    throw new Error(
      "Remote async bash requires the local OMP background job manager, which is unavailable in this session.",
    );
  }
  const command = typeof params.command === "string" ? params.command : "";
  if (!command) throw new Error("bash requires a command");
  const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? state.sessionFile;
  const ownerId = resolveJobOwnerId(
    sessionFile ? resolvePath(sessionFile) : undefined,
  );
  if (!ownerId) {
    throw new Error(
      "Remote async bash could not resolve the owning OMP agent; run it in the foreground instead.",
    );
  }
  const remoteCwd = state.remoteCwd ?? "remote";
  return startRemoteAsyncBashJob({
    manager,
    ownerId,
    command,
    params,
    remoteCwd,
    execute: async (remoteParams, signal, onUpdate) => {
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
      )) as AgentToolResult;
    },
  });
}

function registerWrapper(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
  name: RemoteToolName,
  native: ToolInfo,
): void {
  pi.registerTool({
    name,
    label: TOOL_LABELS[name],
    description: native.description,
    parameters: native.parameters,
    ...remoteWrapperRenderer(name),
    loadMode: "essential",
    approval: approvalFor(name),
    async execute(toolCallId, rawParams, signal, rawOnUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      const target = await executionTarget(name, params, state, ctx, signal);
      if (name === "bash" && target === "remote" && params.async === true) {
        return startRemoteAsyncBash(toolCallId, params, state, ctx);
      }
      const result = await executeWithTarget(
        target,
        name,
        toolCallId,
        params,
        state,
        ctx,
        signal,
        rawOnUpdate as (update: unknown) => void,
      );
      if (
        (name === "ast_edit" ||
          (name === "write" &&
            xdevDevice(normalizePathArgument(params.path)) === "ast_edit")) &&
        stagedProposal(result)
      ) {
        state.proposalSources.push(target);
      }
      if (name === "write" && successfulResolution(result))
        state.proposalSources.pop();
      return result;
    },
  });
  state.wrappedTools.add(name);
}
async function ompHandshake(_pi: ExtensionAPI) {
  // Top-level getAllTools() omits setting-gated/xdev tools such as ast_grep.
  // Admission must still compare the companion's full remote surface, so take
  // wire schemas from the same native ToolSession the worker instantiates.
  const hostVersion = await resolveOmpHostVersion();
  const nativeRuntime = await createNativeWorkerRuntime(
    process.cwd(),
    hostVersion,
  );
  return createOmpRuntimeHandshake({
    hostVersion,
    localTools: REMOTE_TOOL_NAMES.map((name) => {
      const native = nativeRuntime.tools[name];
      if (!native)
        throw new Error(`OMP native tool metadata is unavailable: ${name}`);
      return { name, parameters: toolParametersToWire(native.parameters) };
    }),
  });
}


function registerActiveWrappers(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
): void {
  const active = new Set(pi.getActiveTools());
  const metadata = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  for (const name of REMOTE_TOOL_NAMES) {
    if (!active.has(name) || state.wrappedTools.has(name)) continue;
    const native = metadata.get(name);
    if (!native)
      throw new Error(`OMP native tool metadata is unavailable: ${name}`);
    registerWrapper(pi, state, name, native);
  }
}

function detachRemoteState(
  state: RemoteExtensionState,
  restoreLocal: boolean,
): RemoteRuntimeClient | undefined {
  const current = state.client;
  state.client = undefined;
  state.remoteCwd = restoreLocal ? undefined : state.remoteCwd;
  state.selected = !restoreLocal;
  state.owner = false;
  state.connectionError = restoreLocal
    ? undefined
    : "Remote runtime family disconnected; local fallback is disabled";
  state.proposalSources = state.proposalSources.filter(
    (source) => source === "local",
  );
  state.family?.members.delete(state);
  state.family = undefined;
  return current;
}

async function closeRemoteState(
  state: RemoteExtensionState,
  timeoutMs?: number,
): Promise<void> {
  const current = detachRemoteState(state, true);
  if (current) await current.close(timeoutMs);
}

async function closeRemoteFamily(
  family: RemoteFamily,
  timeoutMs?: number,
): Promise<void> {
  family.closing = true;
  REMOTE_FAMILIES.delete(family.ownerSessionFile);
  const clients = [...family.members]
    .map((member) => detachRemoteState(member, member.owner))
    .filter((client): client is RemoteRuntimeClient => client !== undefined);
  family.members.clear();
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
    if (!notification?.daemon || typeof notification.daemon !== "object") return;
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

async function attachFamilyMember(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
  family: RemoteFamily,
  ctx?: ExtensionContext,
): Promise<void> {
  if (state.selected) return;
  state.selected = true;
  state.owner = false;
  state.family = family;
  state.remoteCwd = family.remoteCwd;
  family.members.add(state);
  registerActiveWrappers(pi, state);

  if (
    !state.localCwd ||
    resolvePath(state.localCwd) !== resolvePath(family.localCwd)
  ) {
    state.connectionError = `Remote subagent inheritance rejected: local cwd ${state.localCwd ?? "unknown"} differs from owner cwd ${family.localCwd}. Local isolated worktrees are not supported.`;
    return;
  }

  let next: RemoteRuntimeClient | undefined;
  try {
    const handshake = await ompHandshake(pi);
    next = new RemoteRuntimeClient({
      command: buildSshWorkerCommand(family.connection),
    });
    const ready = await next.initialize(family.remoteCwd, handshake, undefined, {
      sessionId: launchOwnerId(ctx),
    });
    bindLaunchCompletionDelivery(pi, next);
    if (family.closing)
      throw new Error(
        "Remote session family disconnected during subagent initialization",
      );
    state.client = next;
    state.remoteCwd = ready.cwd;
    state.connectionError = undefined;
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
    wrappedTools: new Set(),
    proposalSources: [],
    selected: false,
    owner: false,
  };

  pi.registerTool({
    name: REMOTE_WORKSPACE_STATUS_TOOL,
    label: "Remote Workspace Status",
    description:
      "Report the current known remote workspace mode and routing boundary. Use before workspace work when the execution location is unclear, after a remote tool error, or when asked whether paths run locally or remotely. This reads extension state only; it does not send an SSH health probe.",
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
      if (REMOTE_FAMILIES.has(normalizedSessionFile)) {
        throw new Error("This session already owns a remote runtime family");
      }
      const localCwd = ctx?.cwd ?? process.cwd();
      const configuredHosts = await loadConfiguredSshHosts(localCwd);

      const rawArgs = [target];
      if (typeof p.cwd === "string") rawArgs.push(p.cwd);
      if (typeof p.identity === "string")
        rawArgs.push("--identity", p.identity);
      if (typeof p.port === "number") rawArgs.push("--port", String(p.port));

      const request = parseConnectArgs(rawArgs.join(" "), configuredHosts);
      let next: RemoteRuntimeClient | undefined;
      try {
        const prepared = await prepareRemoteWorker(request);
        const remoteCwd: string =
          request.cwd ?? prepared.home ?? (await resolveRemoteHome(request));
        const options: RemoteConnectOptions = { ...request, cwd: remoteCwd };
        const connection = {
          ...options,
          workerPath: prepared.workerPath,
        };
        const handshake = await ompHandshake(pi);
        next = new RemoteRuntimeClient({
          command: buildSshWorkerCommand(connection),
        });
        const ready = await next.initialize(options.cwd, handshake, undefined, {
          sessionId: launchOwnerId(ctx),
        });
        bindLaunchCompletionDelivery(pi, next);
        const resolvedRemoteCwd: string = ready.cwd ?? options.cwd;
        const family: RemoteFamily = {
          ownerSessionFile: normalizedSessionFile,
          root: sessionFamilyRoot(normalizedSessionFile),
          localCwd,
          remoteCwd: resolvedRemoteCwd,
          connection,
          members: new Set([state]),
          closing: false,
        };
        state.client = next;
        state.remoteCwd = resolvedRemoteCwd;
        state.localCwd = localCwd;
        state.sessionFile = normalizedSessionFile;
        state.selected = true;
        state.owner = true;
        state.family = family;
        state.connectionError = undefined;
        REMOTE_FAMILIES.set(normalizedSessionFile, family);
        registerActiveWrappers(pi, state);
        ctx?.ui?.setStatus?.(
          "remote-runtime",
          `ssh ${request.displayTarget}:${ready.cwd}`,
        );
        ctx?.ui?.notify?.(
          `Remote runtime connected: ${request.displayTarget}:${ready.cwd}`,
          "info",
        );
        const details = {
          success: true,
          mode: "remote",
          target: request.displayTarget,
          remoteCwd: resolvedRemoteCwd,
          wrappedTools: [...state.wrappedTools],
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
        };
      } catch (error) {
        next?.kill();
        throw error;
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

  pi.registerCommand("remote-connect", {
    description: "Connect native workspace tools to a remote OMP runtime",
    async handler(args, ctx) {
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
      if (REMOTE_FAMILIES.has(normalizedSessionFile))
        throw new Error("This session already owns a remote runtime family");
      const configuredHosts = await loadConfiguredSshHosts(ctx.cwd);

      const request = parseConnectArgs(args, configuredHosts);
      ctx.ui.setWorkingMessage("Deploying remote OMP runtime");
      let next: RemoteRuntimeClient | undefined;
      try {
        const prepared = await prepareRemoteWorker(request);
        const remoteCwd: string =
          request.cwd ?? prepared.home ?? (await resolveRemoteHome(request));
        const options: RemoteConnectOptions = { ...request, cwd: remoteCwd };
        const connection = {
          ...options,
          workerPath: prepared.workerPath,
        };
        const handshake = await ompHandshake(pi);
        next = new RemoteRuntimeClient({
          command: buildSshWorkerCommand(connection),
        });
        const ready = await next.initialize(options.cwd, handshake, undefined, {
          sessionId: launchOwnerId(ctx),
        });
        bindLaunchCompletionDelivery(pi, next);
        const resolvedRemoteCwd: string = ready.cwd ?? options.cwd;
        const family: RemoteFamily = {
          ownerSessionFile: normalizedSessionFile,
          root: sessionFamilyRoot(normalizedSessionFile),
          localCwd: ctx.cwd,
          remoteCwd: resolvedRemoteCwd,
          connection,
          members: new Set([state]),
          closing: false,
        };
        state.client = next;
        state.remoteCwd = resolvedRemoteCwd;
        state.localCwd = ctx.cwd;
        state.sessionFile = normalizedSessionFile;
        state.selected = true;
        state.owner = true;
        state.family = family;
        state.connectionError = undefined;
        REMOTE_FAMILIES.set(normalizedSessionFile, family);
        registerActiveWrappers(pi, state);
        ctx.ui.setStatus(
          "remote-runtime",
          `ssh ${request.displayTarget}:${ready.cwd}`,
        );
        ctx.ui.notify(
          `Remote runtime connected: ${request.displayTarget}:${ready.cwd}`,
          "info",
        );
      } catch (error) {
        next?.kill();
        throw error;
      } finally {
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
      ctx.ui.notify(status, "info");
    },
  });

  pi.registerCommand("remote-exit", {
    description: "Disconnect the remote runtime and restore local native tools",
    async handler(args, ctx) {
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
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const normalized = resolvePath(sessionFile);
    state.sessionFile = normalized;
    const family = findRemoteFamily(normalized);
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

  pi.on("tool_call", (event) => {
    if (!state.selected) return;
    const controlPlaneBlock = remoteControlPlaneBlockReason(
      event.toolName,
      event.input,
    );
    if (controlPlaneBlock) return { block: true, reason: controlPlaneBlock };
    if (
      !REMOTE_TOOL_SET.has(event.toolName) ||
      state.wrappedTools.has(event.toolName as RemoteToolName)
    )
      return;
    return {
      block: true,
      reason: `Remote runtime is selected, but ${event.toolName} is not remotely bound. Reconnect to refresh the active tool surface.`,
    };
  });

  pi.on("session_shutdown", async () => {
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
