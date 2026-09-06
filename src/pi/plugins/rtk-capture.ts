import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type RtkRoute = "local" | "remote" | "unavailable" | "connecting" | "closing";
export type RtkServiceName = "config" | "status" | "verify" | "stats" | "clear-stats";
type RtkConfig = Record<string, unknown>;
type RuntimeStatus = Record<string, unknown>;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface UpstreamRtkModules {
  loadRtkIntegrationConfig(): { config: RtkConfig };
  saveRtkIntegrationConfig(config: RtkConfig): { success: boolean; error?: string };
  getRtkIntegrationConfigPath(): string;
  getOutputMetricsSummary(): string;
  clearOutputMetrics(): void;
  resolveRtkExecutable(pi: ExtensionAPI): Promise<{ command: string; resolvedPath?: string; resolver: string; warning?: string }>;
}

async function sourceModule(path: string): Promise<unknown> {
  const entry = createRequire(import.meta.url).resolve("pi-rtk-optimizer");
  return import(new URL(path, pathToFileURL(entry)).href);
}
const loadRtkExtension = () => (process.env.PI_RTK_BUNDLED === "true"
  ? import("omp-rtk-entry") : sourceModule("./index.js")) as Promise<{ default: (pi: ExtensionAPI) => void }>;

async function loadUpstream(): Promise<UpstreamRtkModules> {
  const [configStore, metrics, resolver] = await Promise.all([
    process.env.PI_RTK_BUNDLED === "true" ? import("omp-rtk-config-store") : sourceModule("./src/config-store.js"),
    process.env.PI_RTK_BUNDLED === "true" ? import("omp-rtk-output-metrics") : sourceModule("./src/output-metrics.js"),
    process.env.PI_RTK_BUNDLED === "true" ? import("omp-rtk-executable-resolver") : sourceModule("./src/rtk-executable-resolver.js"),
  ]);
  return Object.assign({}, configStore, metrics, resolver) as UpstreamRtkModules;
}

export interface ManagedRtkHandle {
  getConfigSnapshot(): Record<string, unknown>;
  service(name: RtkServiceName, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  suspend(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ManagedRtkOptions {
  config?: Record<string, unknown>;
  getRoute?: () => RtkRoute;
  remoteService?: (name: RtkServiceName, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  workerMode?: boolean;
}

/** Captures the published RTK extension while preventing local hook execution when remote owns the workspace. */
export async function createManagedRtk(pi: ExtensionAPI, options: ManagedRtkOptions = {}): Promise<ManagedRtkHandle> {
  const upstream = await loadUpstream();
  if (options.config) {
    const saved = upstream.saveRtkIntegrationConfig(options.config);
    if (!saved.success) throw new Error(saved.error ?? "Could not write RTK worker configuration");
  }
  let closed = false;
  let suspended = false;
  const route = () => options.getRoute?.() ?? "local";
  const requireLocal = () => {
    if (closed || suspended || route() !== "local") throw new Error("RTK workspace unavailable; local fallback is blocked");
  };
  const service = async (name: RtkServiceName, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) throw new Error("RTK service aborted");
    if (route() === "remote") {
      if (!options.remoteService) throw new Error("RTK remote service unavailable");
      return options.remoteService(name, args, signal);
    }
    requireLocal();
    if (name === "config") return { config: upstream.loadRtkIntegrationConfig().config, path: upstream.getRtkIntegrationConfigPath() };
    if (name === "stats") return { summary: upstream.getOutputMetricsSummary() };
    if (name === "clear-stats") {
      upstream.clearOutputMetrics();
      return { cleared: true };
    }
    try {
      const resolution = await upstream.resolveRtkExecutable(pi);
      const result = await pi.exec(resolution.command, ["--version"], { timeout: 5000 });
      const status: RuntimeStatus = result.code === 0
        ? { rtkAvailable: true, lastCheckedAt: Date.now(), rtkExecutablePath: resolution.resolvedPath, rtkExecutableCommand: resolution.command, rtkExecutableResolver: resolution.resolver, rtkExecutableResolutionWarning: resolution.warning }
        : { rtkAvailable: false, lastCheckedAt: Date.now(), lastError: `${result.stderr || result.stdout || `exit ${result.code}`}`.trim(), rtkExecutablePath: resolution.resolvedPath, rtkExecutableCommand: resolution.command, rtkExecutableResolver: resolution.resolver, rtkExecutableResolutionWarning: resolution.warning };
      return name === "verify" ? { status, version: result.stdout.trim() } : status;
    } catch (error) {
      const status = { rtkAvailable: false, lastCheckedAt: Date.now(), lastError: error instanceof Error ? error.message : String(error) };
      return name === "verify" ? { status, version: "" } : status;
    }
  };
  const facade = {
    ...pi,
    registerCommand(name: string, command: Command) {
      pi.registerCommand(name, {
        ...command,
        async handler(args, ctx) {
          if (route() === "local" && !closed && !suspended) return command.handler(args, ctx);
          const action = args.trim() as RtkServiceName | "show" | "path";
          if (action === "show" || action === "config") {
            const result = await service("config", {}, ctx.signal) as { config: unknown; path?: string };
            ctx.ui.notify(`Remote RTK configuration: ${JSON.stringify(result.config)}${result.path ? ` (${result.path})` : ""}`, "info");
            return;
          }
          if (action === "path") {
            const result = await service("config", {}, ctx.signal) as { path?: string };
            ctx.ui.notify(result.path ? `Remote RTK config: ${result.path}` : "Remote RTK config path unavailable", "info");
            return;
          }
          if (action === "verify" || action === "status" || action === "stats" || action === "clear-stats") {
            const result = await service(action === "status" ? "status" : action, {}, ctx.signal);
            ctx.ui.notify(`Remote RTK ${action}: ${typeof result === "string" ? result : JSON.stringify(result)}`, "info");
            return;
          }
          throw new Error("Exit the remote workspace before changing RTK settings; reconnect to negotiate the new assembly");
        },
      });
    },
    on(name: string, handler: Handler) {
      if (options.workerMode && !["session_start", "session_shutdown", "tool_call", "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_result"].includes(name)) return;
      (pi.on as (event: string, listener: Handler) => void)(name, async (event, ctx) => {
        if (closed || suspended || route() !== "local") return {};
        return handler(event, ctx);
      });
    },
  } as ExtensionAPI;
  (await loadRtkExtension()).default(facade);
  return {
    getConfigSnapshot: () => ({ ...upstream.loadRtkIntegrationConfig().config }),
    service,
    async suspend() { suspended = true; },
    async shutdown() { closed = true; suspended = true; },
  };
}

export function createWorkerManagedRtkFactory(config: Record<string, unknown> | undefined, onHandle: (handle: ManagedRtkHandle) => void): ExtensionFactory {
  return async (pi) => onHandle(await createManagedRtk(pi, { config, workerMode: true }));
}
