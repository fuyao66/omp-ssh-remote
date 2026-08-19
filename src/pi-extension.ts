import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { resolveRemoteHome, prepareRemoteWorker } from "./deploy.ts";
import { RemoteRuntimeClient } from "./client.ts";
import {
  parseConnectArgs,
  loadConfiguredSshHosts,
  type RemoteConnectRequest,
} from "./connect-options.ts";
import { buildSshWorkerCommand } from "./ssh.ts";
import {
  AFT_REMOTE_TOOLS,
  PI_NATIVE_TOOLS,
  type AnyRemoteToolName,
  type ReadyMessage,
  type ToolManifest,
} from "./protocol.ts";

export const PI_REMOTE_CORE_TOOLS: readonly string[] = PI_NATIVE_TOOLS;
const PI_REMOTE_INHERIT_ENV = "PI_REMOTE_CONNECTION_SPEC";
const STATE_KEY = Symbol.for("pi-ssh-remote/state");
const KNOWN_WORKSPACE_TOOLS = new Set<string>([
  ...PI_NATIVE_TOOLS,
  ...AFT_REMOTE_TOOLS,
]);

export interface PiRemoteWorkspaceStatus {
  mode: "local" | "remote" | "unavailable";
  transport: "not-selected" | "connected" | "unavailable";
  remoteCwd: string | null;
  connectionError: string | null;
  remoteWorkspaceTools: string[];
  aftTools: string[];
  routing: {
    ordinaryFilesystemPaths: string;
    internalUris: string;
    subagents: string;
    aftEngine: string;
  };
  note: string;
}

export interface PiRemoteExtensionState {
  selected: boolean;
  client?: RemoteRuntimeClient;
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

function isAftTool(name: string): boolean {
  return (
    name.startsWith("aft_") ||
    name.startsWith("ast_grep_") ||
    name.startsWith("bash_") ||
    ["read", "write", "edit", "bash"].includes(name)
  );
}

export function buildPiWorkspaceStatus(
  state: PiRemoteExtensionState,
): PiRemoteWorkspaceStatus {
  const mode = !state.selected
    ? "local"
    : state.connectionError ||
        !state.client ||
        state.client.isClosed ||
        !state.ownershipVerified
      ? "unavailable"
      : "remote";
  const toolNames = state.ready?.tools.map((tool) => tool.name) ?? [];

  return {
    mode,
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
    aftTools: mode === "remote" ? toolNames.filter(isAftTool) : [],
    routing: {
      ordinaryFilesystemPaths:
        mode === "remote"
          ? "remote native Pi/AFT runtime"
          : mode === "unavailable"
            ? "fail-closed (remote profile selected but unavailable)"
            : "local Pi/AFT runtime",
      internalUris: "local Pi control plane",
      subagents:
        mode === "remote"
          ? "independent companion inherited through connection environment"
          : "local process execution",
      aftEngine:
        mode === "remote"
          ? "headless Pi Agent with the matching AFT plugin and native engine on the remote workspace"
          : "local AFT plugin runtime",
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
            !state.client ||
            state.client.isClosed
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
          return (await state.client.execute(
            manifest.name as AnyRemoteToolName,
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
    parsed: RemoteConnectRequest,
    remoteCwd: string,
    remoteWorkerPath: string,
  ): Promise<ReadyMessage> => {
    if (state.client && !state.client.isClosed) {
      throw new Error(
        "Already connected to a remote runtime. Run /remote-exit first.",
      );
    }
    state.selected = true;
    state.ownershipVerified = false;
    state.connectionError = undefined;
    state.connectOptions = parsed;
    state.cwd = remoteCwd;
    state.localActiveTools ??= pi.getActiveTools();

    const client = new RemoteRuntimeClient({
      command: buildSshWorkerCommand({
        target: parsed.target,
        port: parsed.port,
        identityFile: parsed.identityFile,
        knownHostsFile: parsed.knownHostsFile,
        workerPath: remoteWorkerPath,
      }),
    });
    state.client = client;
    try {
      const ready = await client.initialize(remoteCwd, 30_000, "pi");
      state.ready = ready;
      registerRemoteWrappers(ready);
      verifyOwnership();
      process.env[PI_REMOTE_INHERIT_ENV] = JSON.stringify({
        connectOptions: parsed,
        workerPath: remoteWorkerPath,
        cwd: remoteCwd,
      });
      return ready;
    } catch (error) {
      state.ownershipVerified = false;
      state.connectionError =
        error instanceof Error ? error.message : String(error);
      try {
        await client.close();
      } catch {}
      state.client = undefined;
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
    const prepared = await prepareRemoteWorker(
      {
        target: parsed.target,
        port: parsed.port,
        identityFile: parsed.identityFile,
        knownHostsFile: parsed.knownHostsFile,
        localWorkerPath: parsed.workerPath,
      },
      "pi",
    );
    return connectPrepared(parsed, remoteCwd, prepared.workerPath);
  };

  const inheritedSpec = process.env[PI_REMOTE_INHERIT_ENV];

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
      "Connect this Pi session to an SSH workspace and activate the remote Pi/AFT tool profile.",
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
      "Queue a graceful remote disconnect and rebuild the local Pi/AFT profile.",
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
    description: "Disconnect and restore the local Pi/AFT tool profile",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const force = args.trim() === "--force";
      if (!state.selected && !state.client) {
        ctx.ui?.notify?.("Not connected to a remote runtime.", "warning");
        return;
      }
      try {
        if (state.client && !state.client.isClosed) {
          try {
            await state.client.close();
          } catch (error) {
            if (!force) throw error;
            state.client.kill();
          }
        }
        state.selected = false;
        state.client = undefined;
        state.ready = undefined;
        state.cwd = undefined;
        state.connectOptions = undefined;
        state.connectionError = undefined;
        state.ownershipVerified = undefined;
        state.isInheritedChild = undefined;
        delete process.env[PI_REMOTE_INHERIT_ENV];
        ctx.ui?.notify?.(
          "Disconnected. Reloading the local Pi/AFT profile.",
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
      ...KNOWN_WORKSPACE_TOOLS,
      ...(state.ready?.tools.map((tool) => tool.name) ?? []),
    ]);
    if (
      state.selected &&
      guardedNames.has(event.toolName) &&
      (!state.ownershipVerified || !state.client || state.client.isClosed)
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
    if (inheritedSpec && !state.selected && !state.client) {
      try {
        const inherited = JSON.parse(inheritedSpec) as {
          connectOptions: RemoteConnectRequest;
          workerPath: string;
          cwd: string;
        };
        state.isInheritedChild = true;
        await connectPrepared(
          inherited.connectOptions,
          inherited.cwd,
          inherited.workerPath,
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
    if (state.client && !state.client.isClosed) {
      try {
        await state.client.close();
      } catch {
        state.client.kill();
      }
    }
    state.client = undefined;
    state.selected = false;
    state.ready = undefined;
    state.ownershipVerified = undefined;
    delete process.env[PI_REMOTE_INHERIT_ENV];
  });

  if (state.selected && state.ready && state.client && !state.client.isClosed) {
    registeredRemoteTools = new Set();
    registerRemoteWrappers(state.ready);
  }
}
