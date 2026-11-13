import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getRemoteFamilyBroker, sessionBelongsToFamily } from "../src/family-broker.ts";
import type * as BrokerExports from "../src/family-broker.ts";
import type * as ExtensionExports from "../src/extension.ts";
import type { RemoteWorkspaceStatus } from "../src/extension.ts";

type ExtensionModule = typeof ExtensionExports;
type Family = Parameters<ExtensionModule["closeRemoteFamily"]>[0];
type Member = Family["members"] extends Set<infer State> ? State : never;
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

async function extensionHarness(module: ExtensionModule, sessionFile: string) {
  const hooks = new Map<string, Hook>();
  const tools = new Map<string, ToolDefinition>();
  const manager = SessionManager.inMemory("/local/workspace");
  const agent = { id: `family-fixture-${crypto.randomUUID()}`, name: "family fixture", kind: "sub" as const, depth: 1 };
  const sessionManager = {
    getSessionFile: () => sessionFile, getSessionId: () => manager.getSessionId(),
    getBranch: () => manager.getBranch(), getEntries: () => manager.getEntries(),
    ensureOnDisk: () => manager.ensureOnDisk(), flush: () => manager.flush(),
  };
  const session = {
    instanceKey: `main:${crypto.randomUUID()}`, sessionManager, settings: Settings.isolated(),
    getToolByName: () => undefined, getAdvisorStats: () => ({ configured: false, advisors: [] }),
    async runToolRegistryMutation(mutate: () => Promise<void>) { await mutate(); },
  } as unknown as AgentSessionHandle;
  const registry = AgentRegistry.global();
  const ref = registry.register({ id: agent.id, displayName: agent.name, kind: agent.kind, session, sessionFile });
  const ctx = {
    cwd: "/local/workspace",
    agent, sessionManager,
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  await module.default({
    registerCommand() {},
    appendEntry(customType: string, data?: unknown) { manager.appendCustomEntry(customType, data); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, handler: Hook) { hooks.set(name, handler); },
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  return {
    async emit(name: string, event: Record<string, unknown> = {}) {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`Missing extension hook: ${name}`);
      try { return await hook(event, ctx); }
      finally { if (name === "session_shutdown") registry.unregister(agent.id, ref); }
    },
    async status(): Promise<RemoteWorkspaceStatus> {
      const tool = tools.get("remote_workspace_status");
      if (!tool) throw new Error("Missing status tool");
      return (await tool.execute("family-status", {}, undefined, undefined, ctx)).details as RemoteWorkspaceStatus;
    },
  };
}

function makeFamily(ownerSessionFile: string): Family {
  return {
    ownerSessionFile,
    root: ownerSessionFile.slice(0, -".jsonl".length),
    localCwd: "/local/workspace",
    remoteCwd: "/remote/workspace",
    connection: {
      target: "test@example.invalid", displayTarget: "test-remote", cwd: "/remote/workspace", workerPath: "/remote/worker.mjs",
    },
    members: new Set(),
    lspEnabled: true, closing: false,
  };
}

function makeMember(family: Family, sessionFile: string, owner = false): Member {
  return {
    binding: crypto.randomUUID(), sessionFile, localCwd: family.localCwd, remoteCwd: family.remoteCwd,
    selected: true, owner, family, wrappedTools: new Set(), proposalSources: [], activeToolNames: () => [],
  };
}

function descendant(sessionFile: string, name: string): string {
  return `${sessionFile.slice(0, -".jsonl".length)}/subagent/${name}.jsonl`;
}

describe("process-global remote family lifecycle", () => {
  test("cache-busted broker modules share one lifecycle owner and the legacy active Map", async () => {
    // Bun preserves query identities for native paths, not file: URL hrefs.
    // Static imports cannot exercise the cache-busted module loading boundary.
    const modulePath = fileURLToPath(new URL("../src/family-broker.ts", import.meta.url));
    const first = await import(`${modulePath}?instance=family-first`) as typeof BrokerExports;
    const second = await import(`${modulePath}?instance=family-second`) as typeof BrokerExports;
    expect(first.getRemoteFamilyBroker).not.toBe(second.getRemoteFamilyBroker);
    const broker = first.getRemoteFamilyBroker<Family>();
    expect(second.getRemoteFamilyBroker<Family>()).toBe(broker);
    const family = makeFamily(`/tmp/broker-shared-${crypto.randomUUID()}.jsonl`);
    const child = makeMember(family, descendant(family.ownerSessionFile, "child"));
    const other = makeFamily(`/tmp/broker-other-${crypto.randomUUID()}.jsonl`);
    const otherChild = makeMember(other, descendant(other.ownerSessionFile, "child"));
    const legacy = (globalThis as unknown as Record<symbol, Map<string, Family>>)[Symbol.for("omp-ssh-remote/session-families")]!;
    // A pre-existing module may still hold and mutate this original Map.
    legacy.set(family.ownerSessionFile, family);
    broker.register(other);
    broker.attach(family, child);
    broker.attach(other, otherChild);
    try {
      expect(broker.hasOwner(family.ownerSessionFile)).toBe(true);
      expect(broker.find(child.sessionFile!)).toBe(family);
      second.getRemoteFamilyBroker<Family>().revoke(family);
      expect(legacy.has(family.ownerSessionFile)).toBe(false);
      expect(broker.find(descendant(child.sessionFile!, "grandchild"))).toBe(family);
      expect(broker.find(child.sessionFile!)).toBe(family);
      expect(broker.find(otherChild.sessionFile!)).toBe(other);
      expect(broker.hasOwner(other.ownerSessionFile)).toBe(true);
      broker.revoke(other);
      expect(broker.find(descendant(otherChild.sessionFile!, "grandchild"))).toBe(other);
      second.getRemoteFamilyBroker<Family>().detach(family, child);
      expect(broker.find(descendant(child.sessionFile!, "grandchild"))).toBe(family);
      expect(broker.hasOwner(other.ownerSessionFile)).toBe(false);
      expect(broker.find(descendant(otherChild.sessionFile!, "grandchild"))).toBe(other);
    } finally {
      broker.detach(family, child);
      broker.revoke(family);
      broker.detach(other, otherChild);
      broker.revoke(other);
    }
  });

  test("revoked descendants in two extension instances stay unavailable after the final member shuts down", async () => {
    // Use the extension loader's native-path query form: Bun collapses file:
    // URL query imports. Static imports would hide the module loading boundary.
    const modulePath = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
    const first = await import(`${modulePath}?instance=family-first`) as ExtensionModule;
    const second = await import(`${modulePath}?instance=family-second`) as ExtensionModule;
    expect(first.default).not.toBe(second.default);
    expect(first.closeRemoteFamily).not.toBe(second.closeRemoteFamily);
    const broker = getRemoteFamilyBroker<Family>();
    const family = makeFamily(`/tmp/family-cross-module-${crypto.randomUUID()}.jsonl`);
    const childFile = descendant(family.ownerSessionFile, "child");
    const owner = makeMember(family, family.ownerSessionFile, true);
    const child = makeMember(family, childFile);
    broker.attach(family, owner);
    broker.attach(family, child);
    broker.register(family);
    const same = await extensionHarness(first, descendant(childFile, "same-module"));
    const crossFile = descendant(childFile, "cross-module");
    const cross = await extensionHarness(second, crossFile);
    const unrelated = await extensionHarness(second, `${family.root}-unrelated/subagent/child.jsonl`);
    const retained = await extensionHarness(first, descendant(crossFile, "retained"));
    const harnesses = [same, cross, unrelated, retained];
    try {
      // Only the transport boundary is absent; close, inheritance, status,
      // blocking and shutdown all execute the production extension lifecycle.
      await first.closeRemoteFamily(family);
      expect(owner.selected).toBe(false);
      expect(child.selected).toBe(true);
      expect(child.connectionError).toContain("local fallback is disabled");
      for (const harness of [same, cross]) {
        await harness.emit("session_start");
        expect(await harness.status()).toMatchObject({
          mode: "unavailable", transport: "unavailable", sessionRole: "subagent",
          connectionError: expect.stringContaining("revoked"),
        });
        expect(await harness.emit("tool_call", { toolName: "task", input: { task: "continue" } }))
          .toMatchObject({ block: true, reason: expect.stringContaining("cannot fall back locally") });
      }
      await unrelated.emit("session_start");
      expect(await unrelated.status()).toMatchObject({ mode: "local", transport: "not-selected" });
      broker.detach(family, child);
      await cross.emit("session_shutdown");
      // Revoked lineage outlives every transport: a parked child must never
      // become local merely because the final live member shut down.
      await retained.emit("session_start");
      expect((await retained.status()).mode).toBe("unavailable");
      await same.emit("session_shutdown");
      expect(family.members.size).toBe(1);
      expect(broker.find(descendant(childFile, "still-revoked"))).toBe(family);
      await retained.emit("session_shutdown");
      expect(family.members.size).toBe(0);
      expect(broker.find(descendant(childFile, "same-module"))).toBe(family);
      expect(broker.find(descendant(crossFile, "retained"))).toBe(family);
      for (const module of [first, second]) {
        const afterShutdown = await extensionHarness(module, descendant(childFile, "after-shutdown"));
        try {
          await afterShutdown.emit("session_start");
          expect((await afterShutdown.status()).mode).toBe("unavailable");
        } finally {
          await afterShutdown.emit("session_shutdown");
        }
      }
    } finally {
      broker.detach(family, child);
      for (const harness of harnesses) await harness.emit("session_shutdown");
      broker.detach(family, owner);
      broker.revoke(family);
    }
  });

  test("family matching is segment-safe and selects the deepest registered root", () => {
    const broker = getRemoteFamilyBroker<Family>();
    const outer = makeFamily(`/tmp/family-path-${crypto.randomUUID()}.jsonl`);
    const inner = makeFamily(descendant(outer.ownerSessionFile, "inner"));
    broker.register(outer);
    broker.register(inner);
    try {
      expect(broker.find(descendant(inner.ownerSessionFile, "child"))).toBe(inner);
      expect(broker.find(`${outer.root}-unrelated/subagent/child.jsonl`)).toBeUndefined();
      expect(sessionBelongsToFamily(outer.ownerSessionFile, outer.ownerSessionFile)).toBe(false);
    } finally {
      broker.revoke(inner);
      broker.revoke(outer);
    }
  });
});
