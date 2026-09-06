import fffExtension from "@ff-labs/pi-fff/src/index.ts";
import { loadConfig } from "@ff-labs/pi-fff/src/config.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { validateFffAssemblyConfig } from "./fff.ts";
import { type FffServiceName, type ManagedFffHandle } from "./fff-services.ts";
export type FffRoute = "local" | "remote" | "unavailable" | "connecting" | "closing";
export interface ManagedFffOptions {
  config?: Record<string, unknown>;
  agentDir?: string;
  getRoute?: () => FffRoute;
  remoteExecute?: (tool: string, id: string, args: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void) => Promise<unknown>;
  remoteService?: (name: FffServiceName, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  mutateEnv?: boolean;
}
type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type ProviderFactory = (provider: AutocompleteProvider) => AutocompleteProvider;
const FLAGS: Record<string, { key: string; env: string; fallback: unknown }> = {
  "fff-mode": { key: "mode", env: "PI_FFF_MODE", fallback: "tools-and-ui" },
  "fff-enable-root-scan": { key: "enableFsRootScanning", env: "FFF_ENABLE_ROOT_SCAN", fallback: false },
  "fff-enable-home-scan": { key: "enableHomeDirScanning", env: "FFF_ENABLE_HOME_SCAN", fallback: true },
  "fff-warn-home-scan": { key: "warnOnHomeDirScan", env: "FFF_WARN_HOME_SCAN", fallback: true },
  "fff-follow-symlinks": { key: "followSymlinks", env: "FFF_FOLLOW_SYMLINKS", fallback: true },
};

/** Explicit host integration: the upstream factory still owns every search and index operation. */
export function createManagedFff(pi: ExtensionAPI, options: ManagedFffOptions = {}): ManagedFffHandle {
  if (options.config) validateFffAssemblyConfig(options.config);
  const file = loadConfig(options.agentDir);
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const hooks = new Map<string, Handler[]>();
  let providerFactory: ProviderFactory | undefined;
  let context: ExtensionContext | undefined;
  let suspended = false;
  let closed = false;
  let snapshot: Record<string, unknown> = {};
  const route = () => options.getRoute?.() ?? "local";
  const effectiveConfig = (ctx?: ExtensionContext): Record<string, unknown> => {
    const config: Record<string, unknown> = {};
    for (const [flag, spec] of Object.entries(FLAGS)) {
      const fromFlag = pi.getFlag(flag);
      const fromEnv = process.env[spec.env];
      const raw = options.config?.[spec.key] ?? fromFlag ?? fromEnv;
      const parsed = spec.key === "mode"
        ? (["tools-and-ui", "tools-only", "override"].includes(String(raw)) ? raw : undefined)
        : typeof raw === "boolean" ? raw : raw === "true" || raw === "1" ? true : raw === "false" || raw === "0" ? false : undefined;
      config[spec.key] = parsed ?? file[spec.key as keyof typeof file] ?? spec.fallback;
    }
    if (!options.config) {
      const saved = ctx?.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "fff-mode").at(-1);
      if (saved?.type === "custom" && saved.data && typeof saved.data === "object" && "mode" in saved.data) config.mode = saved.data.mode;
    }
    config.multiGrep = options.config?.multiGrep ?? process.env.PI_FFF_MULTIGREP === "1";
    validateFffAssemblyConfig(config);
    return config;
  };
  const emit = async (name: string, event: unknown, ctx: ExtensionContext) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  const requireContext = (): ExtensionContext => {
    if (!context) throw new Error("FFF session has not initialized");
    return context;
  };
  const installProvider = (ctx: ExtensionContext, factory?: ProviderFactory) => {
    ctx.ui.addAutocompleteProvider?.((base) => {
      const local = factory?.(base) ?? base;
      return {
        ...local,
        applyCompletion: local.applyCompletion.bind(local),
        shouldTriggerFileCompletion: local.shouldTriggerFileCompletion?.bind(local),
        async getSuggestions(lines, cursorLine, cursorCol, request) {
          if (route() === "local") return suspended ? null : local.getSuggestions(lines, cursorLine, cursorCol, request);
          // At-mentions are workspace inputs. Never delegate them to a local fallback.
          const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
          if (!/(?:^|\s)@[^\n]*$/.test(prefix)) return base.getSuggestions(lines, cursorLine, cursorCol, request);
          if (route() !== "remote" || !options.remoteService) return null;
          try {
            const result = await options.remoteService("completion", { lines, cursorLine, cursorCol, force: request.force }, request.signal);
            if (request.signal.aborted) return null;
            if (result && typeof result === "object" && "items" in result && "prefix" in result && Array.isArray(result.items) && typeof result.prefix === "string") {
              return { prefix: result.prefix, items: result.items };
            }
            return null;
          } catch { return null; }
        },
      };
    });
  };
  const facade = {
    ...pi,
    getFlag(name: string) {
      const spec = FLAGS[name];
      if (spec && options.config) return options.config[spec.key] as string | boolean | undefined;
      return pi.getFlag(name);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
      pi.registerTool({ ...tool, async execute(id, args, signal, update, ctx) {
        if (closed) throw new Error("FFF session is closed");
        if (route() === "remote" && options.remoteExecute) {
          const onUpdate = update ? (value: unknown) => update(value as AgentToolResult<unknown>) : undefined;
          return await options.remoteExecute(tool.name, id, args as Record<string, unknown>, signal, onUpdate) as AgentToolResult<unknown>;
        }
        if (route() !== "local" || suspended) throw new Error("FFF workspace unavailable; local fallback is blocked");
        return tool.execute(id, args, signal, update, ctx);
      } });
    },
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
      commands.set(name, command);
      pi.registerCommand(name, { ...command, async handler(args, ctx) {
        if (route() === "local") {
          await command.handler(args, ctx);
          // Name-changing mode changes are applied by upstream on /reload, not now.
          if (name === "fff-mode" && ["tools-and-ui", "tools-only"].includes(args.trim()) && snapshot.mode !== "override") snapshot.mode = args.trim();
          return;
        }
        if (name === "fff-mode") {
          if (!args.trim()) { ctx.ui.notify(`Current remote FFF mode: ${snapshot.mode}`, "info"); return; }
          throw new Error("Exit the remote workspace before changing FFF mode; reconnect to negotiate the new assembly");
        }
        if (route() !== "remote" || !options.remoteService) throw new Error("FFF workspace unavailable; local fallback is blocked");
        const service = name === "fff-health" ? "health" : name === "fff-rescan" ? "rescan" : undefined;
        if (!service) throw new Error(`Unadmitted FFF command ${name}`);
        const result = await options.remoteService(service, {}, ctx.signal);
        if (result && typeof result === "object" && "message" in result && typeof result.message === "string") ctx.ui.notify(result.message, "info");
      } });
    },
    on(name: string, handler: Handler) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
      if (name === "session_start") {
        pi.on("session_start", async (event, ctx) => {
          context = ctx;
          snapshot = effectiveConfig(ctx);
          if (route() !== "local") {
            installProvider(ctx);
            return;
          }
          const capturedContext = { ...ctx, ui: { ...ctx.ui, addAutocompleteProvider(factory: ProviderFactory) {
            providerFactory = factory;
            installProvider(ctx, factory);
          } } };
          await handler(event, capturedContext);
        });
      } else if (name === "before_agent_start") {
        // The worker executes real tool calls, not model turns; session_start is
        // its only lifecycle initialization point.
        return;
      } else if (name === "session_shutdown") {
        pi.on("session_shutdown", async (event, ctx) => { closed = true; suspended = true; await handler(event, ctx); });
      } else {
        (pi.on as (name: string, handler: Handler) => void)(name, async (event, ctx) => {
          if (!context) { context = ctx; snapshot = effectiveConfig(ctx); }
          return handler(event, ctx);
        });
      }
    },
  } as ExtensionAPI;
  const oldMulti = process.env.PI_FFF_MULTIGREP;
  if (options.mutateEnv) process.env.PI_FFF_MULTIGREP = options.config?.multiGrep ? "1" : "0";
  try { fffExtension(facade); } finally {
    if (options.mutateEnv) {
      if (oldMulti === undefined) delete process.env.PI_FFF_MULTIGREP;
      else process.env.PI_FFF_MULTIGREP = oldMulti;
    }
  }
  snapshot = effectiveConfig();
  return {
    getRegisteredTools: () => [...tools.values()],
    getConfigSnapshot: () => ({ ...snapshot }),
    async service(name, args = {}, signal) {
      if (closed || suspended || route() !== "local") throw new Error("FFF native service unavailable");
      if (signal?.aborted) throw new Error("FFF service aborted");
      if (name === "completion") {
        if (!providerFactory) throw new Error("FFF completion provider was not initialized");
        const provider = providerFactory({ getSuggestions: async () => null, applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) });
        if (!Array.isArray(args.lines) || !args.lines.every((line) => typeof line === "string") || !Number.isInteger(args.cursorLine) || !Number.isInteger(args.cursorCol)) throw new Error("Invalid FFF completion input");
        const lines = args.lines as string[];
        const cursorLine = args.cursorLine as number;
        const cursorCol = args.cursorCol as number;
        if (cursorLine < 0 || cursorLine >= lines.length || cursorCol < 0 || cursorCol > lines[cursorLine]!.length) throw new Error("FFF completion cursor out of bounds");
        return await provider.getSuggestions(lines, cursorLine, cursorCol, { signal: signal ?? new AbortController().signal, force: args.force === true }) ?? { items: [], prefix: "" };
      }
      const command = commands.get(name === "health" ? "fff-health" : name === "rescan" ? "fff-rescan" : "");
      if (!command) throw new Error(`Unknown FFF service ${name}`);
      const ctx = requireContext();
      const messages: string[] = [];
      const commandContext = { ...ctx, ui: { ...ctx.ui, notify(message: string) { messages.push(message); } } };
      // These captured native commands only use ExtensionContext, not command actions.
      await command.handler("", commandContext as ExtensionCommandContext);
      return { message: messages.join("\n") };
    },
    async suspend() {
      if (suspended || closed) return;
      suspended = true;
      await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, requireContext());
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      suspended = true;
      await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, requireContext());
    },
  };
}
export function createWorkerManagedFffFactory(options: ManagedFffOptions, setHandle: (handle: ManagedFffHandle) => void): ExtensionFactory {
  return (pi) => { setHandle(createManagedFff(pi, options)); };
}
