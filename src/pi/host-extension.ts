import { randomUUID } from "node:crypto";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { resolveRemoteHome, prepareRemoteWorker } from "../deploy.ts";
import {
  parseConnectArgs,
  loadConfiguredSshHosts,
  type RemoteConnectRequest,
} from "../connect-options.ts";
import type { ReadyMessage, ToolManifest } from "../protocol.ts";
import type { PiRemoteConnectionInheritance, PiRemoteConnectionInheritanceSpec } from "./integrations/connection-inheritance.ts";
import {
  PI_CORE_TOOL_NAMES,
  resolvePiRuntimeAssembly,
  restorePiRuntimeAssembly,
  type PiRuntimeAssembly,
} from "./assembly.ts";
import { PiRemoteWorkspaceScope } from "./scope.ts";
import { PI_PLUGIN_ADAPTERS } from "./plugins/index.ts";
import { workspaceBinding } from "./workspace-binding.ts";
import { managedPlugins, managedToolSnapshots } from "./managed-plugins.ts";
import { publishSessionContext, restoreSessionContext, releaseSessionContext } from "./session-context.ts";
const STATE_KEY = Symbol.for("pi-ssh-remote/state");

type PendingReload = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function filterStaleRemoteWrappers(
  tools: readonly ToolInfo[],
): readonly ToolInfo[] {
  const controlSource = sourceKey(
    tools.find((tool) => tool.name === "remote_workspace_status"),
  );
  if (!controlSource) return tools;
  const remoteWorkspaceNames = new Set([
    ...PI_CORE_TOOL_NAMES,
    ...PI_PLUGIN_ADAPTERS.flatMap((adapter) => [...adapter.remoteTools]),
  ]);
  return tools.filter(
    (tool) =>
      !(
        remoteWorkspaceNames.has(tool.name) && sourceKey(tool) === controlSource
      ),
  );
}

export interface PiRemoteWorkspaceStatus {
  mode: "local" | "remote" | "unavailable";
  transport: "not-selected" | "connected" | "unavailable";
  remoteCwd: string | null;
  connectionError: string | null;
  remoteWorkspaceTools: string[];
  workspaceHooks: unknown;
  workspaceServices: unknown;
  componentToolGroups: Array<{
    id: string;
    displayName: string;
    localVersion: string;
    remoteVersion: string;
    tools: string[];
  }>;
  assembly: {
    id: string;
    displayName: string;
    host: { id: string; version: string };
    plugins: Array<{ id: string; version: string }>;
  } | null;
  routing: {
    ordinaryFilesystemPaths: string;
    internalUris: string;
    subagents: string;
    executionRuntime: string;
  };
  note: string;
}

export interface PiRemoteExtensionState {
  selected: boolean;
  scope?: PiRemoteWorkspaceScope;
  assembly?: PiRuntimeAssembly;
  cwd?: string;
  connectOptions?: RemoteConnectRequest;
  connectionError?: string;
  isInheritedChild?: boolean;
  ownershipVerified?: boolean;
  ready?: ReadyMessage;
  localActiveTools?: string[];
  pendingReload?: PendingReload;
  inheritanceDisabled?: boolean;
  inheritanceOwnerToken?: string;
}
const SESSION_STATES_KEY = Symbol.for("pi-ssh-remote/session-states");
type GlobalWithPiRemoteState = typeof globalThis & {
  [STATE_KEY]?: PiRemoteExtensionState;
  [SESSION_STATES_KEY]?: WeakMap<object, PiRemoteExtensionState>;
};

const globalScope = globalThis as GlobalWithPiRemoteState;
const globalState = (globalScope[STATE_KEY] ??= { selected: false });
const stateByEventBus = globalScope[SESSION_STATES_KEY] ??= new WeakMap<object, PiRemoteExtensionState>();

export function getPiRemoteStateForSession(
  eventBus: object,
): PiRemoteExtensionState {
  let state = stateByEventBus.get(eventBus);
  if (!state) {
    state = { selected: false };

    stateByEventBus.set(eventBus, state);
  }
  return state;
}

function beginPendingReload(state: PiRemoteExtensionState): PendingReload {
  const existing = state.pendingReload;
  if (existing) return existing;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  void promise.catch(() => {});
  const pending = { promise, resolve, reject };
  state.pendingReload = pending;
  return pending;
}

function finishPendingReload(
  state: PiRemoteExtensionState,
  error?: unknown,
): void {
  const pending = state.pendingReload;
  if (!pending) return;
  state.pendingReload = undefined;
  if (error === undefined) pending.resolve();
  else pending.reject(error);
}

export function getPiRemoteState(): PiRemoteExtensionState {
  return globalState;
}

function remoteComponentVersions(
  ready: ReadyMessage | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  const value = ready?.capabilities?.assembly;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  const components = (value as Record<string, unknown>).components;
  if (!Array.isArray(components)) return result;
  for (const component of components) {
    if (
      !component ||
      typeof component !== "object" ||
      Array.isArray(component)
    ) {
      continue;
    }
    const record = component as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.version === "string") {
      result.set(record.id, record.version);
    }
  }
  return result;
}

export function buildPiWorkspaceStatus(
  state: PiRemoteExtensionState,
): PiRemoteWorkspaceStatus {
  const mode = !state.selected
    ? "local"
    : state.connectionError ||
        !state.scope ||
        state.scope.isClosed ||
        !state.ownershipVerified ||
        !state.assembly
      ? "unavailable"
      : "remote";
  const toolNames = state.ready?.tools.map((tool) => tool.name) ?? [];
  const assembly = state.assembly;
  const remoteVersions = remoteComponentVersions(state.ready);

  return {
    mode,
    assembly: assembly
      ? {
          id: assembly.id,
          displayName: assembly.displayName,
          host: { id: assembly.host.id, version: assembly.host.version },
          plugins: assembly.plugins.map((plugin) => ({
            id: plugin.id,
            version: plugin.version,
          })),
        }
      : null,
    transport:
      mode === "local"
        ? "not-selected"
        : mode === "remote"
          ? "connected"
          : "unavailable",
    remoteCwd: mode === "remote" ? (state.cwd ?? null) : null,
    connectionError:
      mode === "unavailable"
        ? (state.connectionError ??
          "Remote tool ownership has not been verified")
        : null,
    remoteWorkspaceTools: mode === "remote" ? toolNames : [],
    workspaceHooks: mode === "remote" ? state.ready?.capabilities?.workspaceHooks ?? [] : [],
    workspaceServices: mode === "remote" ? state.ready?.capabilities?.workspaceServices ?? {} : {},
    componentToolGroups:
      mode === "remote" && assembly
        ? assembly.components.map((component) => ({
            id: component.id,
            displayName: component.displayName,
            localVersion: component.version,
            remoteVersion: remoteVersions.get(component.id) ?? "unknown",
            tools: toolNames.filter((name) => component.tools.includes(name)),
          }))
        : [],
    routing: {
      ordinaryFilesystemPaths:
        mode === "remote" && assembly
          ? `remote ${assembly.displayName} runtime`
          : mode === "unavailable"
            ? "fail-closed (remote assembly selected but unavailable)"
            : "local Pi runtime",
      internalUris: "local Pi control plane",
      subagents:
        mode === "remote"
          ? "independent companion inherited through connection environment"
          : "local process execution",
      executionRuntime:
        mode === "remote" && assembly
          ? assembly.executionRuntime.remote
          : (assembly?.executionRuntime.local ?? "local Pi runtime"),
    },
    note:
      mode === "remote"
        ? "Workspace tools, execution hooks and admitted plugin services run remotely; conversation, model requests and UI remain local."
        : mode === "unavailable"
          ? "Workspace tools fail closed until reconnection or /remote-exit."
          : "Local Pi tools are active.",
  };
}

function quoteCommandArgument(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function sourceKey(tool: ToolInfo | undefined): string | undefined {
  return tool ? JSON.stringify(tool.sourceInfo) : undefined;
}
export function getPiRemoteOwnershipErrors(
  allTools: readonly ToolInfo[],
  readyTools: readonly ToolManifest[],
  activeTools?: ReadonlySet<string>,
): string[] {
  const activeReadyTools = readyTools.filter(
    (manifest) => !activeTools || activeTools.has(manifest.name),
  );
  const controlSource = sourceKey(
    allTools.find((tool) => tool.name === "remote_workspace_status"),
  );
  if (!controlSource) return activeReadyTools.map((tool) => tool.name);
  return activeReadyTools
    .map((manifest) => allTools.find((tool) => tool.name === manifest.name))
    .filter((tool) => sourceKey(tool) !== controlSource)
    .map((tool) => tool?.name ?? "<missing>");
}

function manifestSchema(tool: ToolManifest): TSchema {
  if (!tool.parameters || typeof tool.parameters !== "object") {
    throw new Error(
      `Remote tool ${tool.name} did not provide a parameter schema`,
    );
  }
  return tool.parameters as TSchema;
}

export async function installPiRemoteExtension(
  pi: ExtensionAPI,
  options: { inheritedChild?: boolean; inheritance?: PiRemoteConnectionInheritance } = {},
): Promise<void> {
  let sessionKey: object = pi.events ?? globalScope;
  let state = getPiRemoteStateForSession(sessionKey);
  let binding = workspaceBinding(sessionKey);
  publishSessionContext(pi, () => sessionKey);
  const inheritance = options.inheritance;
  if (
    options.inheritedChild ||
    (state.inheritanceOwnerToken === undefined &&
      inheritance?.hasRootOwner())
  ) {
    state.isInheritedChild = true;
  } else {
    state.inheritanceOwnerToken ??= randomUUID();
  }
  const inheritedConnectionRequested =
    state.isInheritedChild === true &&
    !state.inheritanceDisabled &&
    inheritance?.hasSpec();
  let inheritedSpec: PiRemoteConnectionInheritanceSpec | undefined;
  if (!inheritedConnectionRequested || state.inheritanceDisabled) {
    inheritedSpec = undefined;
    if (state.isInheritedChild && !state.inheritanceDisabled) {
      state.selected = true;
      state.ownershipVerified = false;
      state.connectionError =
        "Child requires a valid inherited Pi remote connection";
    }
  } else {
    try {
      inheritedSpec = inheritance?.read();
    } catch (error) {
      state.isInheritedChild = true;
      state.selected = true;
      state.connectionError =
        error instanceof Error ? error.message : String(error);
      inheritedSpec = undefined;
    }
  }

  let registeredRemoteTools = new Set<string>();
  // Pi marks non-throwing tool returns successful; carry the worker's hook outcome through its result hook.
  const remoteResultErrors = new WeakMap<object, boolean>();
  const coreDefinitions = {
    read: createReadToolDefinition,
    write: createWriteToolDefinition,
    edit: createEditToolDefinition,
    bash: createBashToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
  };

  const resolveCurrentAssembly = async (): Promise<PiRuntimeAssembly> => {
    for (const command of pi.getCommands()) {
      if (command.source !== "extension" || (command.name !== "rtk" && !command.name.startsWith("rtk:"))) continue;
      const path = command.sourceInfo?.path?.replace(/\\/g, "/") ?? "";
      if (!managedPlugins(sessionKey).has("pi-rtk-optimizer") || !/\/pi-rtk-extension\.(?:ts|js)$/.test(path)) {
        throw new Error("RTK remote execution requires only the managed pi-rtk-extension entry; disable the ordinary pi-rtk-optimizer extension to avoid local workspace hooks");
      }
    }
    const managed = managedToolSnapshots(sessionKey);
    const managedNames = new Set(managed.map((tool) => tool.name));
    const tools = filterStaleRemoteWrappers(pi.getAllTools()).filter((tool) => !managedNames.has(tool.name));
    const assembly = await resolvePiRuntimeAssembly({
      tools: [...tools, ...managed],
      managedPlugins: [...managedPlugins(sessionKey).values()].map((plugin) => ({
        id: plugin.id,
        sourcePath: plugin.sourcePath,
        version: plugin.version,
        config: plugin.config(),
      })),
    });
    if (assembly.plugins.some((plugin) => plugin.id === "@ff-labs/pi-fff") &&
        !managedPlugins(sessionKey).has("@ff-labs/pi-fff")) {
      throw new Error("FFF remote execution requires the managed pi-fff-extension entry so tools, completion and index commands share one workspace");
    }
    return assembly;
  };

  const verifyOwnership = (): void => {
    if (!state.selected || !state.ready) return;
    const allTools = pi.getAllTools();
    const activeTools = state.isInheritedChild
      ? new Set(pi.getActiveTools())
      : undefined;
    const wrongOwners = getPiRemoteOwnershipErrors(
      allTools,
      state.ready.tools,
      activeTools,
    );
    if (wrongOwners.length > 0) {
      state.ownershipVerified = false;
      state.connectionError = `Pi SSH Remote must load before the tools it replaces; ownership check failed for: ${wrongOwners.join(", ")}`;
      throw new Error(state.connectionError);
    }
    state.ownershipVerified = true;
    state.connectionError = undefined;
  };

  const registerRemoteWrappers = (
    ready: ReadyMessage,
    assembly: PiRuntimeAssembly,
  ): void => {
    const readyNames = new Set(ready.tools.map((tool) => tool.name));
    for (const tool of assembly.tools) {
      if (!readyNames.has(tool.name) || registeredRemoteTools.has(tool.name)) {
        continue;
      }
      registeredRemoteTools.add(tool.name);
      const native = [...managedPlugins(sessionKey).values()]
        .flatMap((plugin) => [...plugin.tools()]).find((candidate) => candidate.name === tool.name)
        ?? (tool.owner === "pi-core" && tool.name in coreDefinitions
          ? coreDefinitions[tool.name as keyof typeof coreDefinitions](state.cwd ?? process.cwd())
          : undefined);
      // Each renderer retains its verified native schema; erase only the heterogeneous generic here.
      const nativeDefinition = native as ToolDefinition | undefined;
      pi.registerTool({
        ...nativeDefinition,
        name: tool.name,
        label: tool.name,
        description: `[Remote on ${state.connectOptions?.displayTarget ?? "SSH host"}] ${tool.description}`,
        parameters: manifestSchema(tool),
        execute: async (
          toolCallId: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: AgentToolUpdateCallback<unknown>,
          _ctx?: ExtensionContext,
        ) => {
          if (!state.selected || !state.scope || state.scope.isClosed) {
            state.connectionError ??=
              "Remote runtime connection lost (fail-closed protection)";
            throw new Error(
              "Remote runtime unavailable. Tool execution was blocked; no local fallback occurred.",
            );
          }
          if (!state.ownershipVerified) verifyOwnership();
          const args =
            params && typeof params === "object"
              ? (params as Record<string, unknown>)
              : {};
          const result = await binding.execute(
            tool.name,
            toolCallId,
            args,
            signal,
            onUpdate
              ? (update: unknown) => onUpdate(update as never)
              : undefined,
          );
          if (result && typeof result === "object" && "content" in result && Array.isArray(result.content) && "isError" in result && typeof result.isError === "boolean") {
            remoteResultErrors.set(result.content, result.isError);
          }
          return result as never;
        },
      });
    }
  };

  const connectPrepared = async (
    assembly: PiRuntimeAssembly,
    parsed: RemoteConnectRequest,
    remoteCwd: string,
    remoteWorkerPath: string,
  ): Promise<ReadyMessage> => {
    if (state.scope && !state.scope.isClosed) {
      throw new Error(
        "Already connected to a remote runtime. Run /remote-exit first.",
      );
    }
    if (
      state.selected &&
      state.connectionError &&
      (!state.scope || state.scope.isClosed)
    ) {
      throw new Error(
        "Remote runtime is selected but unavailable. Run /remote-exit before reconnecting.",
      );
    }
    state.selected = true;
    state.ownershipVerified = false;
    state.connectionError = undefined;
    state.assembly = assembly;
    state.connectOptions = parsed;
    state.cwd = remoteCwd;
    state.localActiveTools ??= pi.getActiveTools();

    let openedScope: PiRemoteWorkspaceScope | undefined;
    try {
      const generation = await binding.begin();
      openedScope = await PiRemoteWorkspaceScope.open({
        assembly,
        connectOptions: parsed,
        workerPath: remoteWorkerPath,
        cwd: remoteCwd,
      });
      state.scope = openedScope;
      state.ready = openedScope.ready;
      registerRemoteWrappers(openedScope.ready, assembly);
      if (!state.isInheritedChild) verifyOwnership();
      binding.commit(openedScope, generation);
      if (!state.isInheritedChild) {
        inheritance?.publish({
          ownerToken: state.inheritanceOwnerToken!,
          assembly: assembly.request,
          tools: assembly.tools,
          connectOptions: parsed,
          workerPath: remoteWorkerPath,
          cwd: remoteCwd,
        });
      }
      return openedScope.ready;
    } catch (error) {
      binding.fail(error);
      try {
        await openedScope?.close(true);
      } catch {}
      state.ownershipVerified = false;
      state.connectionError =
        error instanceof Error ? error.message : String(error);
      state.scope = undefined;
      state.ready = undefined;
      throw error;
    }
  };

  const connect = async (
    request: string | RemoteConnectRequest,
    localCwd: string,
  ): Promise<ReadyMessage> => {
    if (state.isInheritedChild) {
      throw new Error(
        "Child sessions can only restore a parent Pi remote connection",
      );
    }
    await state.pendingReload?.promise;
    const assembly = await resolveCurrentAssembly();
    const configuredHosts = await loadConfiguredSshHosts(localCwd);
    const parsed =
      typeof request === "string"
        ? parseConnectArgs(request, configuredHosts)
        : parseConnectArgs(
            [
              quoteCommandArgument(request.target),
              ...(request.cwd ? [quoteCommandArgument(request.cwd)] : []),
              ...(request.identityFile
                ? ["--identity", quoteCommandArgument(request.identityFile)]
                : []),
              ...(request.port ? ["--port", String(request.port)] : []),
            ].join(" "),
            configuredHosts,
          );
    if (!state.isInheritedChild) {
      inheritance?.claim(state.inheritanceOwnerToken!);
    }
    try {
      const remoteHome = await resolveRemoteHome({
        target: parsed.target,
        port: parsed.port,
        identityFile: parsed.identityFile,
        knownHostsFile: parsed.knownHostsFile,
      });
      const remoteCwd = parsed.cwd ?? remoteHome;
      const prepared = await prepareRemoteWorker(
        {
          target: parsed.target,
          port: parsed.port,
          identityFile: parsed.identityFile,
          knownHostsFile: parsed.knownHostsFile,
          localWorkerPath: parsed.workerPath,
        },
        assembly.workerBundle,
      );
      return await connectPrepared(
        assembly,
        parsed,
        remoteCwd,
        prepared.workerPath,
      );
    } catch (error) {
      if (!state.selected) {
        inheritance?.clear(state.inheritanceOwnerToken);
      }
      throw error;
    }
  };

  pi.registerTool({
    name: "remote_workspace_status",
    label: "workspace status",
    description:
      "Report the current Pi execution domain, resolved runtime assembly, remote cwd, verified tool ownership, and routing boundaries.",
    parameters: Type.Object({}),
    execute: async () => {
      const status = buildPiWorkspaceStatus(state);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        details: status,
      } as never;
    },
  });

  pi.registerTool({
    name: "remote_connect",
    label: "Remote Connect",
    description:
      "Connect this Pi session to an SSH workspace and activate the runtime assembly resolved from the current Pi plugins.",
    parameters: Type.Object({
      target: Type.String({ description: "SSH alias or user@host" }),
      cwd: Type.Optional(
        Type.String({ description: "Remote cwd; defaults to remote home" }),
      ),
      identity: Type.Optional(
        Type.String({ description: "SSH private key path" }),
      ),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    }),
    execute: async (
      _id: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<unknown>,
      ctx?: ExtensionContext,
    ) => {
      const args =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const target = typeof args.target === "string" ? args.target : "";
      if (!target) throw new Error("Missing required target");
      await connect(
        {
          target,
          displayTarget: target,
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(typeof args.identity === "string"
            ? { identityFile: args.identity }
            : {}),
          ...(typeof args.port === "number" ? { port: args.port } : {}),
        },
        ctx?.cwd ?? process.cwd(),
      );
      const status = buildPiWorkspaceStatus(state);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        details: status,
      } as never;
    },
  });

  pi.registerTool({
    name: "remote_exit",
    label: "Remote Exit",
    description:
      "Queue a graceful remote disconnect and rebuild the local Pi tool set.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id: string, params: unknown) => {
      const force =
        !!params &&
        typeof params === "object" &&
        (params as Record<string, unknown>).force === true;
      const command = force ? "/remote-exit --force" : "/remote-exit";
      const pendingReload = beginPendingReload(state);
      setImmediate(() => {
        pi.sendUserMessage(command, {
          deliverAs: "steer",
          expandPromptTemplates: true,
        });
      });
      await pendingReload.promise;
      return {
        content: [{ type: "text", text: `Disconnected (${command})` }],
        details: { queued: false, command },
      } as never;
    },
  });

  pi.registerCommand("remote-connect", {
    description: "Connect Pi Agent to a remote SSH workspace",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      try {
        await connect(args, ctx.cwd);
        ctx.ui?.notify?.(
          `Connected to ${state.connectOptions?.displayTarget} (cwd: ${state.cwd})`,
          "info",
        );
      } catch (error) {
        ctx.ui?.notify?.(
          `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("remote-exit", {
    description: "Disconnect and restore the local Pi tool set",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const force = args.trim() === "--force";
      if (!state.selected && !state.scope) {
        ctx.ui?.notify?.("Not connected to a remote runtime.", "warning");
        return;
      }
      beginPendingReload(state);
      try {
        const inheritedChild = state.isInheritedChild;
        await binding.close(force);
        state.selected = false;
        state.scope = undefined;
        state.ready = undefined;
        state.assembly = undefined;
        state.cwd = undefined;
        state.connectOptions = undefined;
        state.connectionError = undefined;
        state.ownershipVerified = undefined;
        if (inheritedChild) state.inheritanceDisabled = true;
        if (!inheritedChild) {
          inheritance?.clear(state.inheritanceOwnerToken);
        }
        ctx.ui?.notify?.(
          "Disconnected. Reloading the local Pi tool set.",
          "info",
        );
        await ctx.reload();
        finishPendingReload(state);
        return;
      } catch (error) {
        finishPendingReload(state, error);
        state.ownershipVerified = false;
        state.connectionError =
          error instanceof Error ? error.message : String(error);
        ctx.ui?.notify?.(
          `Failed to disconnect: ${state.connectionError}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("remote-status", {
    description: "Show current remote connection status",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const status = buildPiWorkspaceStatus(state);
      ctx.ui?.notify?.(
        JSON.stringify(status),
        status.mode === "unavailable" ? "error" : "info",
      );
    },
  });

  pi.on("tool_result", (event) => {
    const isError = remoteResultErrors.get(event.content);
    if (isError === undefined) return;
    remoteResultErrors.delete(event.content);
    return { isError };
  });

  pi.on("tool_call", (event) => {
    const guardedNames = new Set([
      ...PI_CORE_TOOL_NAMES,
      ...(state.assembly?.knownWorkspaceTools ?? []),
      ...(state.ready?.tools.map((tool) => tool.name) ?? []),
    ]);
    if (!state.selected || !guardedNames.has(event.toolName)) return;
    if (!state.scope || state.scope.isClosed) {
      return {
        block: true,
        reason:
          state.connectionError ??
          "Remote Pi assembly is selected but unavailable; local fallback is blocked.",
      };
    }
    if (!state.ownershipVerified) {
      try {
        verifyOwnership();
      } catch (error) {
        return {
          block: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx) {
      sessionKey = restoreSessionContext(ctx, sessionKey);
      state = getPiRemoteStateForSession(sessionKey);
      binding = workspaceBinding(sessionKey);
      if (state.selected && state.ready && state.assembly) registerRemoteWrappers(state.ready, state.assembly);
    }
    registeredRemoteTools = new Set();
    if (inheritedSpec && !state.selected && !state.scope) {
      state.isInheritedChild = true;
      try {
        const assembly = restorePiRuntimeAssembly(
          inheritedSpec.assembly,
          inheritedSpec.tools,
        );
        if (assembly.id !== inheritedSpec.assembly.id) {
          throw new Error(
            `Inherited Pi assembly ${inheritedSpec.assembly.id} does not match this child runtime ${assembly.id}`,
          );
        }
        await connectPrepared(
          assembly,
          inheritedSpec.connectOptions,
          inheritedSpec.cwd,
          inheritedSpec.workerPath,
        );
      } catch (error) {
        state.selected = true;
        state.ownershipVerified = false;
        state.connectionError =
          error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (state.selected && state.ready) {
      try {
        verifyOwnership();
      } catch {
        // Keep the selected runtime fail-closed; tool_call reports the stored error.
      }
      if (state.localActiveTools) pi.setActiveTools(state.localActiveTools);
    } else if (state.localActiveTools) {
      pi.setActiveTools(state.localActiveTools);
      state.localActiveTools = undefined;
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    if (ctx) releaseSessionContext(ctx);
    const inheritedChild = state.isInheritedChild;
    try {
      await binding.close(true);
    } finally {
      state.scope = undefined;
      state.selected = false;
      state.ready = undefined;
      state.assembly = undefined;
      state.cwd = undefined;
      state.connectOptions = undefined;
      state.connectionError = undefined;
      state.isInheritedChild = undefined;
      state.ownershipVerified = undefined;
      state.localActiveTools = undefined;
      if (!inheritedChild) {
        inheritance?.clear(state.inheritanceOwnerToken);
      }
    }
  });

  if (
    state.selected &&
    state.ready &&
    state.assembly &&
    state.scope &&
    !state.scope.isClosed
  ) {
    registeredRemoteTools = new Set();
    registerRemoteWrappers(state.ready, state.assembly);
  }
}

export default installPiRemoteExtension;
