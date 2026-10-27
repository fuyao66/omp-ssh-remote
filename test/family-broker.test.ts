import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
  const ctx = {
    cwd: "/local/workspace",
    sessionManager: { getSessionFile: () => sessionFile, getBranch: () => manager.getBranch() },
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  await module.default({
    registerCommand() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, handler: Hook) { hooks.set(name, handler); },
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  return {
    async emit(name: string, event: Record<string, unknown> = {}) {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`Missing extension hook: ${name}`);
      return await hook(event, ctx);
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
    closing: false,
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
      expect(broker.find(otherChild.sessionFile!)).toBe(other);
      expect(broker.hasOwner(other.ownerSessionFile)).toBe(true);
      broker.revoke(other);
      expect(broker.find(descendant(otherChild.sessionFile!, "grandchild"))).toBe(other);
      second.getRemoteFamilyBroker<Family>().detach(family, child);
      expect(broker.find(descendant(child.sessionFile!, "grandchild"))).toBeUndefined();
      expect(broker.hasOwner(other.ownerSessionFile)).toBe(false);
      expect(broker.find(descendant(otherChild.sessionFile!, "grandchild"))).toBe(other);
    } finally {
      broker.detach(family, child);
      broker.revoke(family);
      broker.detach(other, otherChild);
      broker.revoke(other);
    }
  });

  test("revoked descendants in two extension instances stay unavailable until the final member shuts down", async () => {
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
      // A departed descendant's root is retained while any family member is
      // alive: shutdown order cannot reopen its subtree to local execution.
      await retained.emit("session_start");
      expect((await retained.status()).mode).toBe("unavailable");
      await same.emit("session_shutdown");
      expect(family.members.size).toBe(1);
      expect(broker.find(descendant(childFile, "still-revoked"))).toBe(family);
      await retained.emit("session_shutdown");
      expect(family.members.size).toBe(0);
      expect(broker.find(descendant(childFile, "same-module"))).toBeUndefined();
      expect(broker.find(descendant(crossFile, "retained"))).toBeUndefined();
      for (const module of [first, second]) {
        const afterShutdown = await extensionHarness(module, descendant(childFile, "after-shutdown"));
        try {
          await afterShutdown.emit("session_start");
          expect((await afterShutdown.status()).mode).toBe("local");
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
