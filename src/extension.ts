import { resolve as resolvePath, sep } from "node:path";
import type {
  AgentMessage,
  AgentToolResult,
  ToolApproval,
} from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import {
  loadConfiguredSshHosts,
  parseConnectArgs,
  type RemoteConnectRequest,
} from "./connect-options.ts";
import { RemoteRuntimeClient } from "./client.ts";
import { prepareRemoteWorker, resolveRemoteHome } from "./deploy.ts";
import { REMOTE_TOOL_NAMES, type RemoteToolName } from "./protocol.ts";
import {
  isInternalUri,
  normalizePathArgument,
  pathShouldStayLocal,
} from "./path-domain.ts";
export { pathShouldStayLocal } from "./path-domain.ts";
import { buildSshWorkerCommand } from "./ssh.ts";

const REMOTE_WORKSPACE_STATE_TYPE = "omp-ssh-remote/workspace-state";
type WorkspaceExecutionTarget = "local" | "remote" | "unavailable";

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
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  lsp: "LSP",
  ast_grep: "AST Grep",
  ast_edit: "AST Edit",
  eval: "Eval",
  debug: "Debug",
};

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

export function remoteWorkspaceStateMessage(
  target: WorkspaceExecutionTarget,
  remoteCwd?: string,
): string {
  const execution =
    target === "remote"
      ? [
          'mode: "remote"',
          'ordinary filesystem paths and workspace tools: "remote"',
          `remote working directory: ${JSON.stringify(remoteCwd ?? "")}`,
          'transport failure: "fail closed; do not fall back to local workspace tools"',
        ]
      : target === "unavailable"
        ? [
            'mode: "unavailable"',
            'ordinary filesystem paths and workspace tools: "fail closed"',
            'local fallback: "disabled"',
            'required action: "/remote-exit to restore local workspace tools"',
          ]
        : [
            'mode: "local"',
            'ordinary filesystem paths and workspace tools: "local"',
          ];
  return [
    "[OMP SSH Remote workspace state]",
    "Extension-generated operational context, not a user request.",
    ...execution,
    'control-plane tools and internal URI resources: "local"',
    'native xd:// workspace devices: "route according to underlying file arguments or AST proposal origin"',
    'connection state: "current known SSH transport state; inspect with /remote-status"',
  ].join("\n");
}

export function workspaceExecutionTarget(
  selected: boolean,
  connectionError?: string,
  client?: Pick<RemoteRuntimeClient, "isClosed">,
): WorkspaceExecutionTarget {
  if (!selected) return "local";
  return connectionError || !client || client.isClosed
    ? "unavailable"
    : "remote";
}

export function injectWorkspaceState(
  messages: AgentMessage[],
  target: WorkspaceExecutionTarget,
  remoteCwd?: string,
): AgentMessage[] {
  const stateMessage: AgentMessage = {
    role: "custom",
    customType: REMOTE_WORKSPACE_STATE_TYPE,
    content: remoteWorkspaceStateMessage(target, remoteCwd),
    display: false,
    attribution: "agent",
    details: {
      target,
      remoteCwd: target === "remote" ? remoteCwd : undefined,
    },
    timestamp: Date.now(),
  };
  return [
    ...messages.filter(
      (message) =>
        message.role !== "custom" ||
        message.customType !== REMOTE_WORKSPACE_STATE_TYPE,
    ),
    stateMessage,
  ];
}
const REMOTE_FAMILIES = (remoteFamilyGlobal[REMOTE_FAMILY_BROKER_KEY] ??=
  new Map<string, RemoteFamily>());

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
  if (toolName === "bash" && params.async === true) {
    return "Remote async bash is disabled until its job lifecycle is bridged to the local hub.";
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
    loadMode: "essential",
    approval: approvalFor(name),
    async execute(toolCallId, rawParams, signal, rawOnUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      const target = await executionTarget(name, params, state, ctx, signal);
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

async function closeRemoteState(state: RemoteExtensionState): Promise<void> {
  const current = detachRemoteState(state, true);
  if (current) await current.close();
}

async function closeRemoteFamily(family: RemoteFamily): Promise<void> {
  family.closing = true;
  REMOTE_FAMILIES.delete(family.ownerSessionFile);
  const clients = [...family.members]
    .map((member) => detachRemoteState(member, member.owner))
    .filter((client): client is RemoteRuntimeClient => client !== undefined);
  family.members.clear();
  const settled = await Promise.allSettled(
    clients.map((client) => client.close()),
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

async function attachFamilyMember(
  pi: ExtensionAPI,
  state: RemoteExtensionState,
  family: RemoteFamily,
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
    next = new RemoteRuntimeClient({
      command: buildSshWorkerCommand(family.connection),
    });
    const ready = await next.initialize(family.remoteCwd);
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
        const remoteCwd =
          request.cwd ?? prepared.home ?? (await resolveRemoteHome(request));
        const options: RemoteConnectOptions = { ...request, cwd: remoteCwd };
        const connection = {
          ...options,
          workerPath: prepared.workerPath,
        };
        next = new RemoteRuntimeClient({
          command: buildSshWorkerCommand(connection),
        });
        const ready = await next.initialize(options.cwd);
        const family: RemoteFamily = {
          ownerSessionFile: normalizedSessionFile,
          root: sessionFamilyRoot(normalizedSessionFile),
          localCwd: ctx.cwd,
          remoteCwd: ready.cwd,
          connection,
          members: new Set([state]),
          closing: false,
        };
        state.client = next;
        state.remoteCwd = ready.cwd;
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

  pi.on("context", (event) => {
    const target = workspaceExecutionTarget(
      state.selected,
      state.connectionError,
      state.client,
    );
    return {
      messages: injectWorkspaceState(
        event.messages,
        target,
        target === "remote" ? state.remoteCwd : undefined,
      ),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    state.localCwd = ctx.cwd;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const normalized = resolvePath(sessionFile);
    state.sessionFile = normalized;
    const family = findRemoteFamily(normalized);
    if (!family) return;
    await attachFamilyMember(pi, state, family);
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (!state.selected) return;
    ctx.ui.notify(
      "Disconnect the remote runtime before switching sessions",
      "warning",
    );
    return { cancel: true };
  });

  pi.on("session_before_branch", (_event, ctx) => {
    if (!state.selected) return;
    ctx.ui.notify(
      "Disconnect the remote runtime before branching the session",
      "warning",
    );
    return { cancel: true };
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
      await closeRemoteFamily(state.family);
      return;
    }
    await closeRemoteState(state);
  });
}
