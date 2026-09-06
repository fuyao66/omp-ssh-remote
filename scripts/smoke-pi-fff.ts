import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { restoreSessionContext } from "../src/pi/session-context.ts";
import { workspaceBinding } from "../src/pi/workspace-binding.ts";

const target = process.env.REMOTE_TARGET;
const remoteCwd = process.env.REMOTE_CWD;
if (!target || !remoteCwd) throw new Error("REMOTE_TARGET and REMOTE_CWD are required");
const withRtk = process.env.PI_WORKSPACE_RTK === "1";
const searchTool = process.env.PI_FFF_MODE === "override" ? "grep" : "ffgrep";
const root = await mkdtemp("/tmp/pi-fff-workspace-smoke-");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await Promise.all([mkdir(agentDir), mkdir(cwd)]);
const probeName = `fff-boundary-${Date.now()}.txt`;
await writeFile(join(cwd, probeName), "LOCAL_ONLY_WORKSPACE_MARKER\n");
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  additionalExtensionPaths: [
    new URL("../packages/pi/dist/pi-extension.js", import.meta.url).pathname,
    new URL("../packages/pi/dist/pi-fff-extension.js", import.meta.url).pathname,
    ...(withRtk ? [new URL("../packages/pi/dist/pi-rtk-extension.js", import.meta.url).pathname] : []),
  ],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await resourceLoader.reload();
const errors = resourceLoader.getExtensions().errors;
if (errors.length) throw new Error(JSON.stringify(errors));
const { session } = await createAgentSession({
  cwd, agentDir, settingsManager, resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
  tools: ["read", "write", "edit", "bash", "find", "grep", "ls", "fffind", "ffgrep", "remote_connect", "remote_exit", "remote_workspace_status"],
});
let provider: AutocompleteProvider = {
  getSuggestions: async () => ({ prefix: "@", items: [{ value: "@LOCAL_FALLBACK", label: "LOCAL_FALLBACK" }] }),
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};
const uiContext = session.extensionRunner.createContext().ui;
await session.bindExtensions({ mode: "print", uiContext: { ...uiContext,
  addAutocompleteProvider(factory) { provider = factory(provider); },
}, commandContextActions: {
  waitForIdle: () => session.waitForIdle(), newSession: async () => ({ cancelled: true }),
  fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }),
  switchSession: async () => ({ cancelled: true }), reload: async () => {
    if (!session.isStreaming && !session.isCompacting) await session.reload();
  },
}});
const text = (value: unknown): string => {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("Tool returned a malformed result");
  }
  return value.content.map((item) => item && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : "").join("\n");
};
const execute = async (name: string, args: Record<string, unknown>) => {
  const tool = session.getToolDefinition(name);
  if (!tool) throw new Error(`Missing ${name}`);
  const toolCallId = `workspace-smoke-${name}-${crypto.randomUUID()}`;
  const runner = session.extensionRunner;
  const call = await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId, input: args } as never);
  if (call?.block) throw new Error(call.reason ?? `Blocked ${name}`);
  const result = await tool.execute(toolCallId, args, undefined, undefined, runner.createContext());
  const transformed = await runner.emitToolResult({ type: "tool_result", toolName: name, toolCallId, input: args, content: result.content, details: result.details, isError: !!(result as { isError?: boolean }).isError } as never);
  return transformed ? { ...result, ...transformed } : result;
};
let connected = false;
try {
  const local = text(await execute(searchTool, { pattern: "LOCAL_ONLY_WORKSPACE_MARKER" }));
  if (!local.includes(probeName)) throw new Error(`Local native FFF failed: ${local}`);
  const localTool = session.getToolDefinition(searchTool)!;
  await execute("remote_connect", { target, cwd: remoteCwd });
  connected = true;
  const remoteHost = text(await execute("bash", { command: "hostname" })).trim();
  if (!remoteHost || remoteHost === hostname()) throw new Error(`Not remote: ${remoteHost}`);
  const failedCommand = await execute("bash", { command: "exit 7" }) as { isError?: boolean };
  if (!failedCommand.isError) throw new Error("Remote bash failure was marked successful by local Pi");
  if (withRtk) {
    const binding = workspaceBinding(restoreSessionContext(session.extensionRunner.createContext(), {}));
    const services = binding.scope!.ready.capabilities?.workspaceServices as Record<string, unknown>;
    if (!Array.isArray(services?.["pi-rtk-optimizer"])) throw new Error("RTK workspace services were not admitted");
    const status = await binding.service("pi-rtk-optimizer", "verify", {}) as { status: { rtkAvailable: boolean }; version?: string };
    if (process.env.PI_RTK_REQUIRE_BINARY === "1" && !status.status.rtkAvailable) throw new Error("RTK executable is missing from the remote worker PATH");
    if (status.status.rtkAvailable) {
      const rewritten = text(await execute("bash", { command: "ls -1 /" }));
      const explicit = text(await execute("bash", { command: "rtk ls -1 /" }));
      const raw = text(await execute("bash", { command: "rtk proxy ls -1 /" }));
      if (rewritten !== explicit || rewritten === raw) throw new Error("Automatic command output did not match RTK or remained raw");
      console.log(JSON.stringify({ remoteRtkRewrite: rewritten }));
    }
    const longOutput = await execute("bash", { command: "printf '\\033[31mREMOTE_RTK_OUTPUT\\033[0m\\n'; python3 -c 'print(\"x\" * 13000)'" });
    if (!text(longOutput).includes("REMOTE_RTK_OUTPUT") || text(longOutput).includes("\u001b[31m") || text(longOutput).length >= 13000) {
      throw new Error(`Remote RTK result hooks did not compact the actual command output: ${JSON.stringify({ length: text(longOutput).length, prefix: text(longOutput).slice(0, 180), details: (longOutput as {details?: unknown}).details, status })}`);
    }
    const metadata = (longOutput as { details?: { rtkCompaction?: unknown } }).details;
    console.log(JSON.stringify({ rtkRemoteCompaction: true, details: metadata }));
    await session.prompt("/rtk show");
    await session.prompt("/rtk verify");
    await session.prompt("/rtk stats");
    const stats = await binding.service("pi-rtk-optimizer", "stats", {});
    if (!(stats as { summary?: string }).summary?.includes("bash:")) throw new Error("Remote RTK stats did not account for workspace output");
    console.log(JSON.stringify({ remoteRtk: status, remoteStats: stats }));
  }
  await execute("write", { path: probeName, content: "REMOTE_INITIAL_WORKSPACE_MARKER\n" });
  await execute("edit", { path: probeName, oldText: "REMOTE_INITIAL_WORKSPACE_MARKER", newText: "REMOTE_ONLY_WORKSPACE_MARKER" });
  if (!text(await execute("read", { path: probeName })).includes("REMOTE_ONLY_WORKSPACE_MARKER")) throw new Error("Remote edit/read did not observe written content");
  const remoteTool = session.getToolDefinition(searchTool)!;
  if (remoteTool.renderCall !== localTool.renderCall || remoteTool.renderResult !== localTool.renderResult) {
    throw new Error("FFF native renderer identity was lost");
  }
  await session.prompt("/fff-rescan");
  let result = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    result = text(await execute(searchTool, { pattern: "REMOTE_ONLY_WORKSPACE_MARKER" }));
    if (result.includes(probeName)) break;
    await delay(100);
  }
  if (!result.includes(probeName)) throw new Error(`Remote FFF search failed: ${result}`);
  const wrongDomain = text(await execute(searchTool, { pattern: "LOCAL_ONLY_WORKSPACE_MARKER" }));
  if (wrongDomain.includes(probeName)) throw new Error("Remote search leaked local workspace");
  await session.prompt("/fff-health");
  await session.reload();
  const afterReload = text(await execute(searchTool, { pattern: "REMOTE_ONLY_WORKSPACE_MARKER" }));
  if (!afterReload.includes(probeName)) throw new Error(`Remote reload lost FFF: ${afterReload}`);
  const completionInput = `@${probeName.slice(0, -4)}`;
  const completion = await provider.getSuggestions([completionInput], 0, completionInput.length, { signal: new AbortController().signal });
  if (!completion?.items.some((item) => item.value.includes(probeName)) || completion.items.some((item) => item.value.includes("LOCAL_FALLBACK"))) {
    throw new Error(`Remote completion failed: ${JSON.stringify(completion)}`);
  }
  await execute("bash", { command: `rm -- ${probeName}` });
  const key = restoreSessionContext(session.extensionRunner.createContext(), {});
  workspaceBinding(key).scope!.client.kill();
  let blocked = false;
  try { await execute(searchTool, { pattern: "LOCAL_ONLY_WORKSPACE_MARKER" }); } catch { blocked = true; }
  if (!blocked) throw new Error("Disconnected FFF fell back locally");
  const disconnectedCompletion = await provider.getSuggestions([completionInput], 0, completionInput.length, { signal: new AbortController().signal });
  if (disconnectedCompletion?.items.length) throw new Error("Disconnected completion returned local candidates");
  await session.prompt("/remote-exit");
  connected = false;
  const restored = text(await execute(searchTool, { pattern: "LOCAL_ONLY_WORKSPACE_MARKER" }));
  if (!restored.includes(probeName)) throw new Error(`Local FFF not restored: ${restored}`);
  const restoredHost = text(await execute("bash", { command: "hostname" })).trim();
  if (restoredHost !== hostname()) throw new Error(`Local bash not restored: ${restoredHost}`);
  if (!text(await execute("read", { path: probeName })).includes("LOCAL_ONLY_WORKSPACE_MARKER")) throw new Error("Local read not restored");
  await execute("write", { path: probeName, content: "LOCAL_AFTER_EXIT\n" });
  await execute("edit", { path: probeName, edits: [{ oldText: "LOCAL_AFTER_EXIT", newText: "LOCAL_AFTER_EDIT" }] });
  if (!text(await execute("read", { path: probeName })).includes("LOCAL_AFTER_EDIT")) throw new Error("Local write/edit not restored");
  if (withRtk) {
    const auto = text(await execute("bash", { command: "ls -1 /" }));
    const explicit = text(await execute("bash", { command: "rtk ls -1 /" }));
    const raw = text(await execute("bash", { command: "rtk proxy ls -1 /" }));
    if (auto !== explicit || auto === raw) throw new Error("Local RTK rewrite not restored");
  }
  await execute("remote_connect", { target, cwd: remoteCwd });
  connected = true;
  if (text(await execute("bash", { command: "hostname" })).trim() !== remoteHost) throw new Error("Reconnect did not restore remote execution");
  await session.prompt("/remote-exit");
  connected = false;
  if (text(await execute("bash", { command: "hostname" })).trim() !== hostname()) throw new Error("Healthy exit did not restore local bash");
  console.log(JSON.stringify({ remoteHost, local, remote: result, restored, nativeRenderers: true, remoteReload: true }));
} finally {
  if (connected) {
    try { await execute("bash", { command: `rm -f -- ${probeName}` }); } catch {}
    try { await session.prompt("/remote-exit --force"); } catch {}
  }
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  await rm(root, { recursive: true, force: true });
}
