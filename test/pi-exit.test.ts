import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { getPiRemoteStateForSession, installPiRemoteExtension } from "../src/pi/host-extension.ts";
import { resolvePiRuntimeAssembly } from "../src/pi/assembly.ts";
import { workspaceBinding } from "../src/pi/workspace-binding.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-exit-lifecycle-"));
  const definition = createBashToolDefinition(cwd);
  const assembly = await resolvePiRuntimeAssembly({ tools: [{ ...definition, sourceInfo: { source: "builtin", path: "<builtin:bash>", scope: "temporary", origin: "top-level" } }], hostVersion: "0.85.1" });
  let initialized = false;
  let closed = false;
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [async (pi) => {
      if (!initialized) {
        initialized = true;
        const binding = workspaceBinding(pi.events);
        const scope = { get isClosed() { return closed; }, async close() { closed = true; }, async execute() { return { content: [{ type: "text", text: "REMOTE" }] }; } };
        binding.commit(scope as never, await binding.begin());
        Object.assign(getPiRemoteStateForSession(pi.events), { selected: true, ownershipVerified: true, scope, assembly, cwd, ready: { tools: assembly.tools } });
      }
      await installPiRemoteExtension(pi);
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ["bash", "remote_exit", "remote_workspace_status"] });
  const idle = Promise.withResolvers<void>();
  let busy = true;
  let skipReload = false;
  await session.bindExtensions({ mode: "print", commandContextActions: {
    waitForIdle: () => busy ? idle.promise : Promise.resolve(),
    newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
    // The interactive host returns without reloading when busy; void is not an acknowledgement.
    reload: async () => { if (!busy && !skipReload) await session.reload(); },
  } });
  return { session, get closed() { return closed; }, idle() { busy = false; idle.resolve(); }, skipReload(value: boolean) { skipReload = value; }, async dispose() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}
async function bash(session: Awaited<ReturnType<typeof fixture>>["session"]) {
  const result = await session.getToolDefinition("bash")!.execute("local-check", { command: "printf LOCAL_AFTER_EXIT" }, undefined, undefined, session.extensionRunner.createContext());
  return result.content.map((item) => item.type === "text" ? item.text : "").join("");
}

test("exit waits for host idle before closing and restores executable local bash", async () => {
  const f = await fixture();
  try {
    expect(await bash(f.session)).toBe("REMOTE");
    const exit = f.session.prompt("/remote-exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closedWhileBusy = f.closed;
    f.idle();
    await exit;
    expect(closedWhileBusy).toBe(false);
    expect(f.closed).toBe(true);
    expect(await bash(f.session)).toBe("LOCAL_AFTER_EXIT");
  } finally { f.idle(); await f.dispose(); }
});

test("skipped reload cannot report local mode and explicit exit can recover", async () => {
  const f = await fixture();
  try {
    f.idle(); f.skipReload(true);
    await f.session.prompt("/remote-exit");
    const status = await f.session.getToolDefinition("remote_workspace_status")!.execute("status", {}, undefined, undefined, f.session.extensionRunner.createContext());
    expect(JSON.stringify(status.content)).toContain('unavailable');
    f.skipReload(false);
    await f.session.prompt("/remote-exit");
    expect(await bash(f.session)).toBe("LOCAL_AFTER_EXIT");
  } finally { await f.dispose(); }
});

test("model exit returns before idle and blocks workspace calls until restoration", async () => {
  const f = await fixture();
  try {
    const result = await f.session.getToolDefinition("remote_exit")!.execute("exit", {}, undefined, undefined, f.session.extensionRunner.createContext());
    expect(result.details).toMatchObject({ queued: true });
    const gate = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "blocked", input: { command: "touch forbidden" } });
    expect(gate?.block).toBe(true);
    f.idle();
    for (let n = 0; n < 100 && f.session.getToolDefinition("bash")!.description.startsWith("[Remote"); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await bash(f.session)).toBe("LOCAL_AFTER_EXIT");
  } finally { f.idle(); await f.dispose(); }
});
