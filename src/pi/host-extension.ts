import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { resolveRemoteHome, prepareRemoteWorker } from "../deploy.ts";
import {
  parseConnectArgs,
  loadConfiguredSshHosts,
  type RemoteConnectRequest,
} from "../connect-options.ts";
import type { ReadyMessage, ToolManifest } from "../protocol.ts";
import {
  clearPiSubagentConnectionSpec,
  publishPiSubagentConnectionSpec,
  readPiSubagentConnectionSpec,
} from "./integrations/pi-subagents.ts";
import {
  PI_CORE_TOOL_NAMES,
  resolvePiRuntimeAssembly,
  type PiRuntimeAssembly,
} from "./assembly.ts";
import { PiRemoteWorkspaceScope } from "./scope.ts";
import { PI_PLUGIN_ADAPTERS } from "./plugins/index.ts";
const STATE_KEY = Symbol.for("pi-ssh-remote/state");

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
      !(remoteWorkspaceNames.has(tool.name) && sourceKey(tool) === controlSource),
  );
}

export interface PiRemoteWorkspaceStatus {
  mode: "local" | "remote" | "unavailable";
  transport: "not-selected" | "connected" | "unavailable";
  remoteCwd: string | null;
  connectionError: string | null;
  remoteWorkspaceTools: string[];
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
}

type GlobalWithPiRemoteState = typeof globalThis & {
  [STATE_KEY]?: PiRemoteExtensionState;
};

const globalScope = globalThis as GlobalWithPiRemoteState;
const globalState = (globalScope[STATE_KEY] ??= { selected: false });

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
        ? "Runtime assembly ownership and the current SSH transport are verified."
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

function manifestSchema(tool: ToolManifest): TSchema {
  if (!tool.parameters || typeof tool.parameters !== "object") {
    throw new Error(
      `Remote tool ${tool.name} did not provide a parameter schema`,
    );
  }
  return tool.parameters as TSchema;
}

export default async function piRemoteExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const state = globalState;
  let inheritedSpec: ReturnType<typeof readPiSubagentConnectionSpec>;
  try {
    inheritedSpec = readPiSubagentConnectionSpec();
  } catch (error) {
    state.selected = true;
    state.ownershipVerified = false;
    state.connectionError =
      error instanceof Error ? error.message : String(error);
  }
  let registeredRemoteTools = new Set<string>();

  const resolveCurrentAssembly = (): Promise<PiRuntimeAssembly> => {
      const tools = filterStaleRemoteWrappers(pi.getAllTools());
      return resolvePiRuntimeAssembly({
        tools,
        activeTools: pi.getActiveTools(),
      });
    };

  const verifyOwnership = (): void => {
    if (!state.selected || !state.ready) return;
    const allTools = pi.getAllTools();
    const controlSource = sourceKey(
      allTools.find((tool) => tool.name === "remote_workspace_status"),
    );
    const wrongOwners = state.ready.tools
      .map((manifest) => allTools.find((tool) => tool.name === manifest.name))
      .filter((tool) => sourceKey(tool) !== controlSource)
      .map((tool) => tool?.name ?? "<missing>");
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
      pi.registerTool({
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
          if (
            !state.selected ||
            !state.ownershipVerified ||
            !state.scope ||
            state.scope.isClosed
          ) {
            state.connectionError ??=
              "Remote runtime connection lost (fail-closed protection)";
            throw new Error(
              "Remote runtime unavailable. Tool execution was blocked; no local fallback occurred.",
            );
          }
          const args =
            params && typeof params === "object"
              ? (params as Record<string, unknown>)
              : {};
          return (await state.scope.execute(
            tool.name,
            toolCallId,
            args,
            signal,
            onUpdate
              ? (update: unknown) => onUpdate(update as never)
              : undefined,
          )) as never;
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
      openedScope = await PiRemoteWorkspaceScope.open({
        assembly,
        connectOptions: parsed,
        workerPath: remoteWorkerPath,
        cwd: remoteCwd,
      });
      state.scope = openedScope;
      state.ready = openedScope.ready;
      registerRemoteWrappers(openedScope.ready, assembly);
      verifyOwnership();
      publishPiSubagentConnectionSpec({
        assembly: assembly.request,
        connectOptions: parsed,
        workerPath: remoteWorkerPath,
        cwd: remoteCwd,
      });
      return openedScope.ready;
    } catch (error) {
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
    return connectPrepared(assembly, parsed, remoteCwd, prepared.workerPath);
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
      setImmediate(() => {
        pi.sendUserMessage(command, {
                  deliverAs: "steer",
                  expandPromptTemplates: true,
                });
      });
      return {
        content: [{ type: "text", text: `Queued ${command}` }],
        details: { queued: true, command },
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
      try {
        await state.scope?.close(force);
        state.selected = false;
        state.scope = undefined;
        state.ready = undefined;
        state.assembly = undefined;
        state.cwd = undefined;
        state.connectOptions = undefined;
        state.connectionError = undefined;
        state.ownershipVerified = undefined;
        state.isInheritedChild = undefined;
        clearPiSubagentConnectionSpec();
        ctx.ui?.notify?.(
          "Disconnected. Reloading the local Pi tool set.",
          "info",
        );
        await ctx.reload();
        return;
      } catch (error) {
        state.selected = true;
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

  pi.on("tool_call", (event) => {
    const guardedNames = new Set([
      ...PI_CORE_TOOL_NAMES,
      ...(state.assembly?.knownWorkspaceTools ?? []),
      ...(state.ready?.tools.map((tool) => tool.name) ?? []),
    ]);
    if (
      state.selected &&
      guardedNames.has(event.toolName) &&
      (!state.ownershipVerified || !state.scope || state.scope.isClosed)
    ) {
      return {
        block: true,
        reason:
          state.connectionError ??
          "Remote Pi assembly is selected but unavailable; local fallback is blocked.",
      };
    }
  });

  pi.on("session_start", async () => {
    if (inheritedSpec && !state.selected && !state.scope) {
      try {
        const assembly = await resolveCurrentAssembly();
        if (assembly.id !== inheritedSpec.assembly.id) {
          throw new Error(
            `Inherited Pi assembly ${inheritedSpec.assembly.id} does not match this child runtime ${assembly.id}`,
          );
        }
        state.isInheritedChild = true;
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
      verifyOwnership();
      if (state.localActiveTools) pi.setActiveTools(state.localActiveTools);
    } else if (state.localActiveTools) {
      pi.setActiveTools(state.localActiveTools);
      state.localActiveTools = undefined;
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") return;
    try {
      await state.scope?.close(true);
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
      clearPiSubagentConnectionSpec();
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
