import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveRemoteHome, prepareRemoteWorker } from "./deploy.ts";
import { RemoteRuntimeClient } from "./client.ts";
import {
  parseConnectArgs,
  loadConfiguredSshHosts,
  type RemoteConnectRequest,
} from "./connect-options.ts";
import { isInternalUri } from "./path-domain.ts";
import { buildSshWorkerCommand } from "./ssh.ts";
import { AFT_EXTENDED_TOOLS, type AnyRemoteToolName } from "./protocol.ts";
export const PI_REMOTE_CORE_TOOLS: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
];

export const ALL_PI_REMOTE_TOOLS: readonly string[] = [
  ...PI_REMOTE_CORE_TOOLS,
  ...AFT_EXTENDED_TOOLS,
];

const PI_REMOTE_INHERIT_ENV = "PI_REMOTE_CONNECTION_SPEC";

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
  cwd?: string;
  client?: RemoteRuntimeClient;
  connectOptions?: RemoteConnectRequest;
  connectionError?: string;
  isInheritedChild?: boolean;
}

const globalState: PiRemoteExtensionState = {
  selected: false,
};

export function getPiRemoteState(): PiRemoteExtensionState {
  return globalState;
}

export function buildPiWorkspaceStatus(state: PiRemoteExtensionState): PiRemoteWorkspaceStatus {
  const mode = !state.selected
    ? "local"
    : state.connectionError || !state.client || state.client.isClosed
      ? "unavailable"
      : "remote";

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
        ? (state.connectionError ?? "Remote runtime transport is unavailable")
        : null,
    remoteWorkspaceTools: mode === "remote" ? [...ALL_PI_REMOTE_TOOLS] : [],
    aftTools: mode === "remote" ? [...AFT_EXTENDED_TOOLS] : [],
    routing: {
      ordinaryFilesystemPaths:
        mode === "remote"
          ? "remote native runtime"
          : mode === "unavailable"
            ? "fail-closed (error; remote runtime unreachable)"
            : "local native tools",
      internalUris: "local Pi control plane",
      subagents:
        mode === "remote"
          ? "automatic remote connection inheritance via process environment"
          : "local process execution",
      aftEngine:
        mode === "remote"
          ? "remote AFT daemon bridge (AST search, callgraph, inspect, outline, zoom executing on remote workspace)"
          : "local AFT plugin execution active",
    },
    note:
      mode === "remote"
        ? "Remote connection active; Pi core tools and AFT AST/inspection engine execute natively on the remote host."
        : mode === "unavailable"
          ? "Remote connection selected but unavailable; operations will fail closed until reconnected or /remote-exit."
          : "Local execution active; tools execute on the local machine.",
  };
}

export default async function piRemoteExtension(pi: ExtensionAPI): Promise<void> {
  const state = globalState;

  // Auto-connect if spawned as a subagent inheriting parent remote connection
  const inheritedSpec = process.env[PI_REMOTE_INHERIT_ENV];
  if (inheritedSpec && !state.selected && !state.client) {
    try {
      const parsed = JSON.parse(inheritedSpec) as {
        connectOptions: RemoteConnectRequest;
        workerPath: string;
        cwd: string;
      };
      state.selected = true;
      state.connectOptions = parsed.connectOptions;
      state.cwd = parsed.cwd;
      state.isInheritedChild = true;

      const command = buildSshWorkerCommand({
        target: parsed.connectOptions.target,
        port: parsed.connectOptions.port,
        identityFile: parsed.connectOptions.identityFile,
        knownHostsFile: parsed.connectOptions.knownHostsFile,
        workerPath: parsed.workerPath,
      });

      const client = new RemoteRuntimeClient({ command });
      state.client = client;
      await client.initialize(parsed.cwd, 15_000, "pi");
    } catch (err) {
      state.selected = true;
      state.connectionError = err instanceof Error ? err.message : String(err);
      if (state.client) {
        await state.client.close();
        state.client = undefined;
      }
    }
  }

  // Register remote_workspace_status tool
  pi.registerTool({
    name: "remote_workspace_status",
    label: "workspace status",
    description:
      "Report the current execution domain, remote working directory, and tool routing boundaries (local vs remote).",
    parameters: {} as unknown as Record<string, unknown>,
    execute: async () => {
      const status = buildPiWorkspaceStatus(state);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(status, null, 2),
          },
        ],
        details: status,
      } as any;
    },
  });

  pi.registerTool({
    name: "remote_connect",
    label: "Remote Connect",
    description:
      "Connect Pi Agent and AFT tools to a remote host over SSH. Target can be an SSH alias or user@host. When cwd is omitted, defaults to remote $HOME. Transparently routes all Pi workspace tools and AFT tools to the remote host.",
    parameters: {} as unknown as Record<string, unknown>,
    execute: async (_id: string, params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) => {
      if (state.selected && state.client && !state.client.isClosed) {
        throw new Error("Already connected to remote runtime. Call remote_exit first.");
      }
      const args = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      const target = typeof args.target === "string" ? args.target : "";
      if (!target) {
        throw new Error("Missing required 'target' parameter (SSH alias or user@host)");
      }
      const rawArgs = [target];
      if (typeof args.cwd === "string") rawArgs.push(args.cwd);
      if (typeof args.identity === "string") rawArgs.push("--identity", args.identity);
      if (typeof args.port === "number") rawArgs.push("--port", String(args.port));

      try {
        const localCwd = ctx?.cwd ?? process.cwd();
        const configuredHosts = await loadConfiguredSshHosts(localCwd);
        const parsed = parseConnectArgs(rawArgs.join(" "), configuredHosts);
        state.selected = true;
        state.connectOptions = parsed;
        state.connectionError = undefined;

        const remoteHome = await resolveRemoteHome({
          target: parsed.target,
          port: parsed.port,
          identityFile: parsed.identityFile,
          knownHostsFile: parsed.knownHostsFile,
        });
        const cwd = parsed.cwd ?? remoteHome;
        state.cwd = cwd;

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

        const command = buildSshWorkerCommand({
          target: parsed.target,
          port: parsed.port,
          identityFile: parsed.identityFile,
          knownHostsFile: parsed.knownHostsFile,
          workerPath: prepared.workerPath,
        });

        const client = new RemoteRuntimeClient({ command });
        state.client = client;
        await client.initialize(cwd, 15_000, "pi");

        process.env[PI_REMOTE_INHERIT_ENV] = JSON.stringify({
          connectOptions: parsed,
          workerPath: prepared.workerPath,
          cwd,
        });

        const reloadFn = (ctx as unknown as { reload?: () => Promise<void> })?.reload;
        if (typeof reloadFn === "function") {
          await reloadFn();
        }

        ctx?.ui?.notify?.(
          `Connected to remote Pi & AFT runtime on ${parsed.displayTarget} (cwd: ${cwd})`,
          "info",
        );

        const details = {
          success: true,
          mode: "remote",
          target: parsed.displayTarget,
          remoteCwd: cwd,
          wrappedTools: ALL_PI_REMOTE_TOOLS,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
        } as any;
      } catch (err) {
        state.selected = false;
        state.connectionError = err instanceof Error ? err.message : String(err);
        delete process.env[PI_REMOTE_INHERIT_ENV];
        if (state.client) {
          state.client.kill();
          state.client = undefined;
        }
        throw err;
      }
    },
  });

  pi.registerTool({
    name: "remote_exit",
    label: "Remote Exit",
    description:
      "Disconnect Pi Agent from the remote runtime and restore local native tools.",
    parameters: {} as unknown as Record<string, unknown>,
    execute: async (_id: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) => {
      if (!state.selected && !state.client) {
        return {
          content: [{ type: "text", text: "Remote runtime is already disconnected; local tools active." }],
          details: { success: true, mode: "local" },
        } as any;
      }
      state.selected = false;
      state.cwd = undefined;
      state.connectOptions = undefined;
      state.connectionError = undefined;
      delete process.env[PI_REMOTE_INHERIT_ENV];
      if (state.client) {
        await state.client.close();
        state.client = undefined;
      }
      const reloadFn = (ctx as unknown as { reload?: () => Promise<void> })?.reload;
      if (typeof reloadFn === "function") {
        await reloadFn();
      }
      ctx?.ui?.notify?.("Disconnected from remote runtime. Local tools restored.", "info");
      return {
        content: [{ type: "text", text: "Disconnected from remote runtime. Local tools restored." }],
        details: { success: true, mode: "local" },
      } as any;
    },
  });
  // Register remote commands
  pi.registerCommand("remote-connect", {
    description: "Connect Pi Agent to a remote host over SSH",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (state.selected && state.client && !state.client.isClosed) {
        ctx.ui?.notify?.("Already connected to remote runtime. Run /remote-exit first.", "warning");
        return;
      }
      try {
        const configuredHosts = await loadConfiguredSshHosts(ctx.cwd);
        const parsed = parseConnectArgs(args, configuredHosts);
        state.selected = true;
        state.connectOptions = parsed;
        state.connectionError = undefined;

        const remoteHome = await resolveRemoteHome({
          target: parsed.target,
          port: parsed.port,
          identityFile: parsed.identityFile,
          knownHostsFile: parsed.knownHostsFile,
        });
        const cwd = parsed.cwd ?? remoteHome;
        state.cwd = cwd;

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

        const command = buildSshWorkerCommand({
          target: parsed.target,
          port: parsed.port,
          identityFile: parsed.identityFile,
          knownHostsFile: parsed.knownHostsFile,
          workerPath: prepared.workerPath,
        });

        const client = new RemoteRuntimeClient({ command });
        state.client = client;
        await client.initialize(cwd, 15_000, "pi");

        // Export environment variable so any spawned subagents (pi-subagents) auto-inherit the connection
        process.env[PI_REMOTE_INHERIT_ENV] = JSON.stringify({
          connectOptions: parsed,
          workerPath: prepared.workerPath,
          cwd,
        });

        // Trigger session reload to apply remote wrappers with highest priority
        const reloadFn = (ctx as unknown as { reload?: () => Promise<void> }).reload;
        if (typeof reloadFn === "function") {
          await reloadFn();
        }

        ctx.ui?.notify?.(
          `Connected to remote Pi & AFT runtime on ${parsed.displayTarget} (cwd: ${cwd})`,
          "info",
        );
      } catch (err) {
        state.selected = false;
        state.connectionError = err instanceof Error ? err.message : String(err);
        delete process.env[PI_REMOTE_INHERIT_ENV];
        if (state.client) {
          await state.client.close();
          state.client = undefined;
        }
        ctx.ui?.notify?.(`Failed to connect: ${state.connectionError}`, "error");
      }
    },
  });

  pi.registerCommand("remote-exit", {
    description: "Disconnect from remote runtime and restore local Pi tools",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (!state.selected && !state.client) {
        ctx.ui?.notify?.("Not connected to any remote runtime.", "warning");
        return;
      }
      state.selected = false;
      state.cwd = undefined;
      state.connectOptions = undefined;
      state.connectionError = undefined;
      delete process.env[PI_REMOTE_INHERIT_ENV];
      if (state.client) {
        await state.client.close();
        state.client = undefined;
      }
      const reloadFn = (ctx as unknown as { reload?: () => Promise<void> }).reload;
      if (typeof reloadFn === "function") {
        await reloadFn();
      }
      ctx.ui?.notify?.("Disconnected from remote runtime. Local tools restored.", "info");
    },
  });

  pi.registerCommand("remote-status", {
    description: "Show current remote connection status",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const status = buildPiWorkspaceStatus(state);
      if (status.mode === "remote") {
        ctx.ui?.notify?.(`Connected to ${state.connectOptions?.displayTarget} (cwd: ${state.cwd})`, "info");
        return;
      }
      if (status.mode === "unavailable") {
        ctx.ui?.notify?.(`Disconnected with error: ${state.connectionError}`, "error");
        return;
      }
      ctx.ui?.notify?.("Disconnected (local tools active)", "info");
    },
  });

  // If connected, register transparent remote tool wrappers for ALL Pi & AFT tools
  if (state.selected && state.client && !state.client.isClosed) {
    for (const toolName of ALL_PI_REMOTE_TOOLS) {
      pi.registerTool({
        name: toolName,
        label: toolName,
        description: `[Remote on ${state.connectOptions?.displayTarget}] Transparent remote workspace tool (Pi & AFT)`,
        parameters: {} as unknown as Record<string, unknown>,
        execute: async (
          toolCallId: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: AgentToolUpdateCallback<unknown>,
          _ctx?: ExtensionContext,
        ) => {
          if (!state.client || state.client.isClosed) {
            state.connectionError = "Remote runtime connection lost (fail-closed protection)";
            throw new Error("Remote runtime disconnected. Tool execution aborted to prevent local corruption.");
          }
          const args = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
          if (typeof args.path === "string" && isInternalUri(args.path)) {
            throw new Error(`Internal URI ${args.path} is not supported on remote execution`);
          }
          const res = await state.client.execute(
            toolName as AnyRemoteToolName,
            toolCallId,
            args,
            signal,
            onUpdate ? (u: unknown) => onUpdate(u as any) : undefined,
          );
          return res as any;
        },
      });
    }
  }
}
