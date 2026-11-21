import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { currentThreadId } from "@oh-my-pi/pi-coding-agent/thread/identity";
import extension from "../../src/extension.ts";

if (isMainThread || !parentPort) throw new Error("This fixture requires an actual worker thread");
const { directory, sessionFile } = workerData as { directory: string; sessionFile: string };
const manager = await SessionManager.open(sessionFile, dirname(sessionFile), undefined, {
  initialCwd: directory, suppressBreadcrumb: true,
});
const agent = { kind: "sub", id: "child", name: "child", depth: 1, parentId: "Main" } as const;
const ctx = {
  cwd: directory, agent, sessionManager: manager, ui: { notify() {} },
  async invokeTool(params: { path: string; content: string }) {
    await writeFile(join(directory, params.path), params.content);
    return { content: [{ type: "text", text: "local write" }] };
  },
} as unknown as ExtensionContext;
const registry = AgentRegistry.global();
const session = {
  instanceKey: `${currentThreadId()}:${crypto.randomUUID()}`,
  sessionManager: manager,
  settings: Settings.isolated({ "task.workerThreads": 0 }),
  getToolByName: () => ({ name: "write" }),
  async runToolRegistryMutation(mutate: () => Promise<void>) { await mutate(); },
} as unknown as AgentSessionHandle;
const ref = registry.register({ ...agent, session, sessionFile, displayName: agent.name, status: "running" });
const tools = new Map<string, ToolDefinition>();
const hooks = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();

try {
  await extension({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (name: string, hook: (event: unknown, context: ExtensionContext) => unknown) => hooks.set(name, hook),
    getActiveTools: () => ["write"],
    getAllTools: () => [{ name: "write", parameters: { type: "object" }, sourceInfo: { source: "builtin" } }],
  } as unknown as ExtensionAPI);
  await hooks.get("session_start")!({}, ctx);
  const execute = (name: string, input: Record<string, unknown>) =>
    tools.get(name)!.execute(name, input, undefined, undefined, ctx);
  const errorFrom = async (name: string, input: Record<string, unknown>) => {
    try { await execute(name, input); return null; }
    catch (error) { return (error as Error).message; }
  };
  const status = (await execute("remote_workspace_status", {})).details;
  const writeError = await errorFrom("write", { path: "local-marker", content: "local write" });
  // Intentionally invalid target: removing the worker-thread guard still cannot run SSH.
  const connectError = await errorFrom("remote_connect", { target: "invalid ssh target" });
  const reconnectError = await errorFrom("remote_reconnect", {});
  await hooks.get("session_shutdown")!({}, ctx);
  parentPort.postMessage({ isMainThread, status, writeError, connectError, reconnectError });
} finally {
  registry.unregister(agent.id, ref);
  await manager.close();
}
