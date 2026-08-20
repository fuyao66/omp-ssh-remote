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
import { DEFAULT_PI_PROFILE, getPiRuntimeProfile } from "./profiles/index.ts";
import type { PiRuntimeProfile } from "./profile.ts";
import { PiRemoteWorkspaceScope } from "./scope.ts";

const STATE_KEY = Symbol.for("pi-ssh-remote/state");

export interface PiRemoteWorkspaceStatus {
  mode: "local" | "remote" | "unavailable";
  transport: "not-selected" | "connected" | "unavailable";
  remoteCwd: string | null;
  connectionError: string | null;
  remoteWorkspaceTools: string[];
  profileToolGroups: Array<{
    id: string;
    displayName: string;
    tools: string[];
  }>;
  profile: { id: string; version: string; displayName: string } | null;
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
  profile?: PiRuntimeProfile;
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

export function buildPiWorkspaceStatus(
  state: PiRemoteExtensionState,
): PiRemoteWorkspaceStatus {
  const mode = !state.selected
    ? "local"
    : state.connectionError ||
        !state.scope ||
        state.scope.isClosed ||
        !state.ownershipVerified
      ? "unavailable"
      : "remote";
  const toolNames = state.ready?.tools.map((tool) => tool.name) ?? [];
  const profile = state.profile ?? DEFAULT_PI_PROFILE;

  return {
    mode,
    profile:
      mode === "local"
        ? null
        : {
            id: profile.id,
            version: profile.version,
            displayName: profile.displayName,
          },
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
    profileToolGroups:
      mode === "remote"
        ? profile.toolGroups.map((group) => ({
            id: group.id,
            displayName: group.displayName,
            tools: toolNames.filter((name) => group.tools.has(name)),
          }))
        : [],
    routing: {
      ordinaryFilesystemPaths:
        mode === "remote"
          ? `remote ${profile.displayName} runtime`
          : mode === "unavailable"
            ? "fail-closed (remote profile selected but unavailable)"
            : `local ${profile.displayName} runtime`,
      internalUris: "local Pi control plane",
      subagents:
        mode === "remote"
          ? "independent companion inherited through connection environment"
          : "local process execution",
      executionRuntime:
        mode === "remote"
          ? profile.executionRuntime.remote
          : profile.executionRuntime.local,
    },
    note:
      mode === "remote"
        ? "Remote profile ownership and the current SSH transport are verified."
        : mode === "unavailable"
          ? "Workspace tools fail closed until reconnection or /remote-exit."
          : "Local profile active.",
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
    state.profile = DEFAULT_PI_PROFILE;
    state.ownershipVerified = false;
    state.connectionError =
      error instanceof Error ? error.message : String(error);
  }
  let registeredRemoteTools = new Set<string>();

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

  const registerRemoteWrappers = (ready: ReadyMessage): void => {
    for (const manifest of ready.tools) {
      if (registeredRemoteTools.has(manifest.name)) continue;
      registeredRemoteTools.add(manifest.name);
      pi.registerTool({
        name: manifest.name,
        label: manifest.name,
        description: `[Remote on ${state.connectOptions?.displayTarget ?? "SSH host"}] ${manifest.description}`,
        parameters: manifestSchema(manifest),
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
            manifest.name,
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
    profile: PiRuntimeProfile,
    parsed: RemoteConnectRequest,
    remoteCwd: string,
    remoteWorkerPath: string,
  ): Promise<ReadyMessage> => {
    if (state.scope && !state.scope.isClosed) {
      throw new Error(
        "Already connected to a remote runtime. Run /remote-exit first.",
      );
    }
    state.selected = true;
    state.ownershipVerified = false;
    state.connectionError = undefined;
    state.profile = profile;
    state.connectOptions = parsed;
    state.cwd = remoteCwd;
    state.localActiveTools ??= pi.getActiveTools();

    let openedScope: PiRemoteWorkspaceScope | undefined;
    try {
      openedScope = await PiRemoteWorkspaceScope.open({
        profile,
        connectOptions: parsed,
        workerPath: remoteWorkerPath,
        cwd: remoteCwd,
      });
      state.scope = openedScope;
      state.ready = openedScope.ready;
      registerRemoteWrappers(openedScope.ready);
      verifyOwnership();
      publishPiSubagentConnectionSpec({
        profileId: profile.id,
        connectOptions: parsed,
        workerPath: remoteWorkerPath,
        cwd: remoteCwd,
      });
      return openedScope.ready;
    } catch (error) {
      await openedScope?.close(true);
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
    const profile = DEFAULT_PI_PROFILE;
    const prepared = await prepareRemoteWorker(
      {
        target: parsed.target,
        port: parsed.port,
        identityFile: parsed.identityFile,
        knownHostsFile: parsed.knownHostsFile,
        localWorkerPath: parsed.workerPath,
      },
      profile.workerBundle,
    );
    return connectPrepared(profile, parsed, remoteCwd, prepared.workerPath);
  };

  pi.registerTool({
    name: "remote_workspace_status",
    label: "workspace status",
    description:
      "Report the current Pi execution domain, remote cwd, verified tool ownership, and routing boundaries.",
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
      "Connect this Pi session to an SSH workspace and activate the selected remote runtime profile.",
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
      "Queue a graceful remote disconnect and rebuild the local Pi tool profile.",
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
          deliverAs: "followUp",
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
    description: "Disconnect and restore the local Pi tool profile",
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
        state.profile = undefined;
        state.cwd = undefined;
        state.connectOptions = undefined;
        state.connectionError = undefined;
        state.ownershipVerified = undefined;
        state.isInheritedChild = undefined;
        clearPiSubagentConnectionSpec();
        ctx.ui?.notify?.(
          "Disconnected. Reloading the local Pi tool profile.",
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
    const profile = state.profile ?? DEFAULT_PI_PROFILE;
    const guardedNames = new Set([
      ...profile.knownWorkspaceTools,
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
          "Remote Pi profile is selected but unavailable; local fallback is blocked.",
      };
    }
  });

  pi.on("session_start", async () => {
    if (inheritedSpec && !state.selected && !state.scope) {
      try {
        const profile = getPiRuntimeProfile(inheritedSpec.profileId);
        state.isInheritedChild = true;
        await connectPrepared(
          profile,
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
      state.profile = undefined;
      state.cwd = undefined;
      state.connectOptions = undefined;
      state.connectionError = undefined;
      state.isInheritedChild = undefined;
      state.ownershipVerified = undefined;
      state.localActiveTools = undefined;
      clearPiSubagentConnectionSpec();
    }
  });

  if (state.selected && state.ready && state.scope && !state.scope.isClosed) {
    registeredRemoteTools = new Set();
    registerRemoteWrappers(state.ready);
  }
}
