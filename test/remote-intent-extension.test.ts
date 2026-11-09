import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import extension, { type RemoteWorkspaceStatus } from "../src/extension.ts";
import { REMOTE_INTENT_ENTRY } from "../src/remote-intent.ts";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
function intent(remote: boolean): SessionEntry {
  return { type: "custom", customType: REMOTE_INTENT_ENTRY, data: { version: 1, remote },
    id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString() };
}

async function harness(entries: SessionEntry[], branch = entries) {
  const hooks = new Map<string, Hook>(), tools = new Map<string, ToolDefinition>();
  const sessionFile = `/tmp/remote-intent-extension-${crypto.randomUUID()}.jsonl`;
  const manager = {
    getSessionFile: () => sessionFile, getEntries: () => entries, getBranch: () => branch,
    async ensureOnDisk() {}, async flush() {},
  };
  const ctx = {
    cwd: "/local/workspace", agent: { id: `intent-${crypto.randomUUID()}`, kind: "main", depth: 0 },
    sessionManager: manager,
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  const registry = AgentRegistry.global();
  const ref = registry.register({
    id: ctx.agent.id, displayName: "intent fixture", kind: "main", sessionFile,
    session: { sessionManager: manager, getToolByName() {}, async runToolRegistryMutation(fn: () => Promise<void>) { await fn(); } } as unknown as NonNullable<Parameters<AgentRegistry["register"]>[0]["session"]>,
  });
  await extension({
    registerCommand() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, hook: Hook) { hooks.set(name, hook); },
    getActiveTools: () => [], getAllTools: () => [],
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data, id: crypto.randomUUID(), parentId: null,
        timestamp: new Date().toISOString() });
    },
  } as unknown as ExtensionAPI);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    try { return await hooks.get(name)!(event, ctx); }
    finally { if (name === "session_shutdown") registry.unregister(ctx.agent.id, ref); }
  };
  const execute = async (name: string, args: Record<string, unknown> = {}) => await tools.get(name)!.execute("intent", args, undefined, undefined, ctx);
  return { emit, execute, status: async () => (await execute("remote_workspace_status")).details as RemoteWorkspaceStatus };
}

test("restored remote intent blocks workspace fallback until explicit owner exit", async () => {
  const entries = [intent(true)], host = await harness(entries);
  try {
    await host.emit("session_start");
    expect(await host.status()).toMatchObject({ mode: "unavailable", transport: "unavailable", sessionRole: "owner" });
    expect(await host.emit("tool_call", { toolName: "read", input: { path: "/workspace/file" } }))
      .toMatchObject({ block: true });
    await expect(host.execute("remote_reconnect")).rejects.toThrow(/exit remote mode.*connect again/i);
    await host.execute("remote_exit");
    expect((await host.status()).mode).toBe("local");
    expect(entries.at(-1)).toMatchObject({ customType: REMOTE_INTENT_ENTRY, data: { version: 1, remote: false } });
    expect(await host.emit("tool_call", { toolName: "read", input: { path: "/workspace/file" } })).toBeUndefined();
  } finally { await host.emit("session_shutdown"); }
});

test.each(["remote", "unavailable"])("legacy %s history restores unavailable until explicit exit, never connection settings", async mode => {
  const entries: SessionEntry[] = [{
    type: "custom_message", customType: "remote-workspace-binding", content: "Old workspace binding", display: false,
    details: { mode, target: "old.example.invalid", cwd: "/old/workspace" },
    id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(),
  }];
  const host = await harness(entries);
  try {
    await host.emit("session_start");
    const status = await host.status();
    expect(status).toMatchObject({ mode: "unavailable", transport: "unavailable", remoteCwd: null });
    expect(JSON.stringify(status)).not.toContain("old.example.invalid");
    expect(await host.emit("tool_call", { toolName: "read", input: { path: "/workspace/file" } })).toMatchObject({ block: true });
    await expect(host.execute("remote_reconnect")).rejects.toThrow(/exit remote mode.*connect again/i);
    await host.execute("remote_exit");
    expect((await host.status()).mode).toBe("local");
  } finally { await host.emit("session_shutdown"); }
  const resumed = await harness(entries);
  try {
    await resumed.emit("session_start");
    expect((await resumed.status()).mode).toBe("local");
  } finally { await resumed.emit("session_shutdown"); }
});

test("rewound conversation does not discard later durable remote selection", async () => {
  const entries = [intent(false), intent(true)], host = await harness(entries, entries.slice(0, 1));
  try {
    await host.emit("session_start");
    expect((await host.status()).mode).toBe("unavailable");
    await host.emit("session_shutdown");
    expect(entries.at(-1)).toMatchObject({ data: { remote: true } });
  } finally { await host.emit("session_shutdown"); }
});

test("explicit local exit wins even when conversation rewinds to an older remote marker", async () => {
  const entries = [intent(true), intent(false)], host = await harness(entries, entries.slice(0, 1));
  try {
    await host.emit("session_start");
    expect((await host.status()).mode).toBe("local");
  } finally { await host.emit("session_shutdown"); }
});

test("shutdown cancels startup admission before any late restored binding can publish", async () => {
  const host = await harness([intent(true)]);
  const starting = host.emit("session_start");
  await host.emit("session_shutdown");
  await expect(starting).rejects.toThrow(/cancel|abort|changed/i);
  expect((await host.status()).mode).toBe("local");
});
