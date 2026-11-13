import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, spyOn, test } from "bun:test";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { nestedDispatchScope } from "../src/nested-dispatch.ts";
import * as ssh from "../src/ssh.ts";
import * as identity from "../src/omp/host-identity.ts";
import { SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";
import { createNativeWorkerRuntime, type RemoteNativeTool } from "../src/runtime.ts";
import remoteRuntimeExtension, {
  closeRemoteFamily,
  consumedResolution,
  type RemoteWorkspaceStatus,
} from "../src/extension.ts";

type Family = Parameters<typeof closeRemoteFamily>[0];
type Member = Family["members"] extends Set<infer State> ? State : never;
type NativeToolMetadata = Pick<RemoteNativeTool, "name" | "description" | "parameters" | "customFormat" | "customWireName" | "concurrency">;
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

async function extensionHarness(
  sessionFile: string,
  manager = SessionManager.inMemory("/local/workspace"),
  activeTools: string[] = [],
  invokeTool?: (params: Record<string, unknown>) => Promise<AgentToolResult>,
) {
  const handlers = new Map<string, Hook>();
  const tools = new Map<string, ToolDefinition>();
  let nativeMetadata: { name: string; description: string; parameters: unknown; sourceInfo: { source: string } }[] | undefined;
  let nativeTools: Readonly<Partial<Record<string, NativeToolMetadata>>> = {};
  const agent = { id: `architecture-fixture-${crypto.randomUUID()}`, name: "architecture fixture", kind: "sub" as const, depth: 1 };
  const ctx = {
    cwd: "/local/workspace",
    agent,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => manager.getBranch(),
      getSessionId: () => manager.getSessionId(),
      getEntries: () => manager.getEntries(),
      ensureOnDisk: () => manager.ensureOnDisk(),
      flush: () => manager.flush(),
    },
    ui: { notify() {}, setStatus() {} },
    invokeTool,
  } as unknown as ExtensionContext;
  const session = {
    instanceKey: `main:${crypto.randomUUID()}`, sessionManager: ctx.sessionManager, settings: Settings.isolated(),
    getToolByName: (name: string) => nativeTools[name], getAdvisorStats: () => ({ configured: false, advisors: [] }),
    async runToolRegistryMutation(mutate: () => Promise<void>) { await mutate(); },
  } as unknown as AgentSessionHandle;
  const registry = AgentRegistry.global();
  const ref = registry.register({ id: agent.id, displayName: agent.name, kind: agent.kind, session, sessionFile });
  const api = {
    registerCommand() {},
    appendEntry(customType: string, data?: unknown) { manager.appendCustomEntry(customType, data); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: Hook) { handlers.set(event, handler); },
    getActiveTools: () => activeTools,
    getAllTools: () => nativeMetadata ?? activeTools.map((name) => ({
      name,
      description: `Native ${name}`,
      parameters: {},
      sourceInfo: { source: "builtin" },
    })),
  };
  await remoteRuntimeExtension(api as unknown as ExtensionAPI);
  return {
    ctx,
    handlers,
    getNativeTool(name: string) { return nativeTools[name]; },
    useNativeTools(next: Readonly<Record<string, NativeToolMetadata>>) {
      nativeTools = next;
      nativeMetadata = Object.values(next).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: { source: "builtin" },
      }));
    },
    useSession(next: SessionManager) { manager = next; },
    accept(result: unknown) {
      const { message } = result as { message: CustomMessage };
      return manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
    async executeTool(name: string, input: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool: ${name}`);
      return tool.execute("architecture-call", input, undefined, undefined, ctx);
    },
    async emit(name: string, event: Record<string, unknown> = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing extension event: ${name}`);
      try { return await handler(event, ctx); }
      finally { if (name === "session_shutdown") registry.unregister(agent.id, ref); }
    },
    async status(): Promise<RemoteWorkspaceStatus> {
      const tool = tools.get("remote_workspace_status");
      if (!tool) throw new Error("Missing remote_workspace_status tool");
      const result = await tool.execute("architecture-status", {}, undefined, undefined, ctx);
      return result.details as RemoteWorkspaceStatus;
    },
  };
}

/** Admit an active family through the real lifecycle; replace only its SSH process. */
async function admitFixtureMember(harness: Awaited<ReturnType<typeof extensionHarness>>, family: Family): Promise<Member> {
  Object.assign(harness.ctx, { cwd: import.meta.dir });
  family.localCwd = import.meta.dir;
  const native = await createNativeWorkerRuntime(import.meta.dir);
  try {
    harness.useNativeTools(native.tools);
  } finally { await native.dispose(); }
  const transport = spyOn(ssh, "buildSshWorkerCommand")
    .mockReturnValue([process.execPath, join(import.meta.dir, "../src/worker.ts")]);
  const hostIdentity = spyOn(identity, "resolveOmpHostVersion").mockResolvedValue(SUPPORTED_SDK_VERSION);
  try {
    await harness.emit("session_start");
    const state = [...family.members].find(member => member.sessionFile === harness.ctx.sessionManager.getSessionFile())!;
    expect(state.connectionError).toBeUndefined();
    expect(state.client?.isClosed).toBe(false);
    // Dispatch tests install their own transport after native admission settles.
    await state.client!.close();
    await state.client!.waitForExit();
    return state;
  } finally { hostIdentity.mockRestore(); transport.mockRestore(); }
}

describe("extension workspace architecture", () => {
  test("registers no context projection and emits no notice for a fresh local session", async () => {
    const harness = await extensionHarness(`/tmp/local-${crypto.randomUUID()}.jsonl`);
    try {
      expect(harness.handlers.has("context")).toBe(false);
      expect(harness.handlers.has("before_agent_start")).toBe(true);
      await harness.emit("session_start");
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      expect(await harness.status()).toMatchObject({ mode: "local", transport: "not-selected" });
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test.each(["legacy", "native"])("restores %s remote history as unavailable until an explicit intent clears migration", async (kind) => {
    const manager = SessionManager.inMemory("/local/workspace");
    if (kind === "legacy") manager.appendCustomEntry("remote-workspace-context-v1", { mode: "remote", target: "old-host", cwd: "/old/remote" });
    else manager.appendCustomMessageEntry("remote-workspace-binding", "Previous remote binding", false, {
      binding: "old-remote", mode: "remote", target: "old-host", cwd: "/old/remote",
    });
    const harness = await extensionHarness(`/tmp/restored-${crypto.randomUUID()}.jsonl`, manager);
    try {
      await harness.emit("session_start");
      expect(harness.handlers.has("context")).toBe(false);
      const first = await harness.emit("before_agent_start");
      expect(first).toMatchObject({
        message: {
          role: "custom",
          customType: "remote-workspace-binding",
          display: false,
          details: {
            mode: "unavailable",
            target: null,
            cwd: null,
          },
          content: expect.stringContaining("Remote execution is unavailable; no local fallback."),
        },
      });
      // A cancelled first attempt never entered native history: retry it.
      const retry = await harness.emit("before_agent_start");
      expect(retry).toMatchObject({ message: { details: { mode: "unavailable", target: null, cwd: null } } });
      harness.accept(retry);
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      expect(manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "remote-workspace-binding")).toHaveLength(kind === "native" ? 2 : 1);
      expect(manager.getBranch().at(-1)).toMatchObject({ type: "custom_message", details: { mode: "unavailable" } });
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("hot switch and branch navigation preserve explicit local intent despite previous remote notices", async () => {
    const manager = SessionManager.inMemory("/local/workspace");
    const remoteId = manager.appendCustomMessageEntry("remote-workspace-binding", "Remote history", false, {
      binding: "previous-remote", mode: "remote", target: "old-host", cwd: "/old/remote",
    });
    manager.appendCustomEntry("remote-workspace-intent-v1", { version: 1, remote: false });
    const harness = await extensionHarness(`/tmp/navigation-${crypto.randomUUID()}.jsonl`, manager);
    try {
      await harness.emit("session_start");
      const localId = harness.accept(await harness.emit("before_agent_start"));
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      await harness.emit("session_before_branch");
      manager.branch(remoteId);
      expect(await harness.emit("before_agent_start")).toMatchObject({ message: { details: { mode: "local" } } });
      manager.branch(localId);
      expect(await harness.emit("before_agent_start")).toBeUndefined();

      await harness.emit("session_before_switch");
      const restored = SessionManager.inMemory("/local/workspace");
      restored.appendCustomMessageEntry("remote-workspace-binding", "Other session remote history", false, {
        binding: "another-remote", mode: "remote", target: "other-host", cwd: "/other/remote",
      });
      restored.appendCustomEntry("remote-workspace-intent-v1", { version: 1, remote: false });
      harness.useSession(restored);
      const correction = await harness.emit("before_agent_start");
      expect(correction).toMatchObject({ message: { details: { mode: "local" } } });
      expect(await harness.emit("before_agent_start")).toMatchObject({ message: { details: { mode: "local" } } });
      harness.accept(correction);
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      harness.useSession(SessionManager.inMemory("/local/workspace"));
      expect(await harness.emit("before_agent_start")).toBeUndefined();
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("native worker image questions explain direct reads without changing JSON queries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-read-query-"));
    const client = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
    const ownerFile = `${cwd}/owner.jsonl`, root = ownerFile.slice(0, -".jsonl".length);
    const family: Family = {
      ownerSessionFile: ownerFile, root, localCwd: "/local/workspace", remoteCwd: cwd,
      connection: { target: "fixture.invalid", displayTarget: "fixture", cwd, workerPath: "/fixture/worker" },
      members: new Set(), lspEnabled: true, closing: false,
    };
    const harness = await extensionHarness(`${root}/subagent/child.jsonl`, undefined, ["read"]);
    const broker = (globalThis as unknown as Record<symbol, Map<string, Family>>)[Symbol.for("omp-ssh-remote/session-families")]!;
    broker.set(ownerFile, family);
    try {
      await writeFile(join(cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=", "base64"));
      await writeFile(join(cwd, "data.json"), '{"a":42}');
      await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE);
      const state = await admitFixtureMember(harness, family);
      // Keep the real worker transport, including its serialized ToolError reconstruction.
      state.client = client;
      const json = await harness.executeTool("read", { path: "data.json?q=.a" });
      expect(json.content).toEqual([{ type: "text", text: "42" }]);
      await expect(harness.executeTool("read", { path: "pixel.png?q=Describe" })).rejects.toThrow(
        `Remote read failed (${cwd}): Remote image questions (?q=) are not supported. Read the image without ?q= and the model receives its pixels directly.`,
      );
      const image = await harness.executeTool("read", { path: "pixel.png" });
      expect(image.content.some(part => part.type === "image")).toBe(true);
    } finally {
      await harness.emit("session_shutdown");
      broker.delete(ownerFile);
      await client.close();
      await client.waitForExit();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("native proc root aliases merge local listings with remote services, never specific ids", async () => {
    const ownerFile = `/tmp/proc-family-${crypto.randomUUID()}.jsonl`;
    const root = ownerFile.slice(0, -".jsonl".length);
    const childFile = `${root}/subagent/child.jsonl`;
    const family: Family = {
      ownerSessionFile: ownerFile, root, localCwd: "/local/workspace", remoteCwd: import.meta.dir,
      connection: { target: "test@example.invalid", displayTarget: "test-remote", cwd: import.meta.dir, workerPath: "/remote/worker.mjs" },
      members: new Set(), lspEnabled: true, closing: false,
    };
    const reader = new ReadTool({
      cwd: "/local/workspace", settings: Settings.isolated({ "launch.enabled": false }), hasUI: false,
      asyncJobManager: new AsyncJobManager({ onJobComplete() {} }),
      getAgentId: () => "Main", getSessionId: () => "local-proc",
      getSessionFile: () => null, getSessionSpawns: () => "",
    });
    const localPaths: unknown[] = [];
    const remotePaths: unknown[] = [];
    const harness = await extensionHarness(childFile, undefined, ["read"], async (input) => {
      const params = input as { path: string };
      localPaths.push(params.path);
      return reader.execute("native-local-proc", params);
    });
    const key = Symbol.for("omp-ssh-remote/session-families");
    const broker = (globalThis as unknown as Record<symbol, Map<string, Family>>)[key]!;
    broker.set(ownerFile, family);
    try {
      const state = await admitFixtureMember(harness, family);
      state.client = {
        isClosed: false,
        async execute(_name: string, _id: string, params: Record<string, unknown>) {
          remotePaths.push(params.path);
          return {
            content: [{ type: "text", text: "remote-web ready" }],
            details: { proc: { jobs: [], agents: [], daemons: [{ name: "remote-web" }] } },
          };
        },
        async close() {},
      } as unknown as Member["client"];
      for (const path of ["proc://", "proc:///", "PROC://", "PROC:///", "proc:///:raw"]) {
        const result = await harness.executeTool("read", { path });
        expect(result.details).toMatchObject({ proc: { daemons: [{ name: "remote-web" }] }, local: { proc: {} }, remote: { proc: {} } });
        expect(localPaths.at(-1)).toBe(path);
        expect(remotePaths.at(-1)).toBe(path);
      }
      expect(localPaths).toHaveLength(5);
      await harness.executeTool("read", { path: "proc://remote-web" });
      expect(localPaths).toHaveLength(5);
      expect(remotePaths.at(-1)).toBe("proc://remote-web");
    } finally {
      await harness.emit("session_shutdown");
      broker.delete(ownerFile);
    }
  });

  test("registered dispatch never sends mixed bound conflicts and local jobs to either host", async () => {
    const ownerFile = `/tmp/resource-owner-${crypto.randomUUID()}.jsonl`;
    const root = ownerFile.slice(0, -".jsonl".length);
    const childFile = `${root}/subagent/child.jsonl`;
    const family: Family = {
      ownerSessionFile: ownerFile, root, localCwd: "/local/workspace", remoteCwd: import.meta.dir,
      connection: { target: "test@example.invalid", displayTarget: "test-remote", cwd: import.meta.dir, workerPath: "/remote/worker.mjs" },
      members: new Set(), lspEnabled: true, closing: false,
    };
    const localPaths: unknown[] = [];
    const remotePaths: unknown[] = [];
    const harness = await extensionHarness(childFile, undefined, ["read"], async input => {
      localPaths.push(input.path);
      return { content: [{ type: "text", text: "native local" }] };
    });
    const broker = (globalThis as unknown as Record<symbol, Map<string, Family>>)[Symbol.for("omp-ssh-remote/session-families")]!;
    broker.set(ownerFile, family);
    const registry = spyOn(AgentRegistry, "global").mockReturnValue({ list: () => [
      { id: "Main", sessionFile: childFile, session: {
        instanceKey: `main:${crypto.randomUUID()}`,
        sessionManager: harness.ctx.sessionManager,
        settings: Settings.isolated(),
        getToolByName: (name: string) => harness.getNativeTool(name),
        runToolRegistryMutation: async <T>(mutation: () => Promise<T>): Promise<T> => await mutation(),
        asyncJobManager: { getAllJobs: () => [{ id: "bg_1" }] },
      } },
      { id: "Scout" },
    ] } as never);
    try {
      const state = await admitFixtureMember(harness, family);
      state.client = {
        isClosed: false,
        async execute(_name: string, _id: string, params: Record<string, unknown>) {
          remotePaths.push(params.path);
          return { content: [{ type: "text", text: "native remote" }] };
        },
        async close() {},
      } as unknown as Member["client"];
      const conflict = `remote-conflict://${encodeURIComponent(state.binding)}/1`;
      for (const proc of ["proc://bg_1", "PROC://%62g_1:1-5", "proc://Scout"]) {
        for (const path of [`${conflict};${proc}`, `${proc};${conflict}`]) {
          await expect(harness.executeTool("read", { path })).rejects.toThrow("Mixed local and remote");
        }
      }
      expect(localPaths).toHaveLength(0);
      expect(remotePaths).toHaveLength(0);
      for (const path of [`${conflict};PROC://%77eb`, `PROC://%77eb;${conflict}`]) {
        await harness.executeTool("read", { path });
        expect(remotePaths.at(-1)).toBe(path.replace(conflict, "conflict://1"));
      }
      expect(remotePaths).toHaveLength(2);
      await expect(harness.executeTool("read", { path: "remote-conflict://stale/1;proc://bg_1" })).rejects.toThrow("stale workspace binding");
      expect(remotePaths).toHaveLength(2);
      await harness.executeTool("read", { path: "PROC://%62g_1:1-5" });
      expect(localPaths).toEqual(["PROC://%62g_1:1-5"]);
      state.selected = false;
      await expect(harness.executeTool("read", { path: conflict })).rejects.toThrow("stale workspace binding");
      await harness.executeTool("read", { path: "proc://web;proc://bg_1" });
      expect(localPaths.at(-1)).toBe("proc://web;proc://bg_1");
      expect(remotePaths).toHaveLength(2);
    } finally {
      registry.mockRestore();
      await harness.emit("session_shutdown");
      broker.delete(ownerFile);
    }
  });

  test("registered nested reply writes use native local fallback without opening other host resources", async () => {
    const ownerFile = `/tmp/reply-owner-${crypto.randomUUID()}.jsonl`;
    const root = ownerFile.slice(0, -".jsonl".length);
    const childFile = `${root}/subagent/child.jsonl`;
    const family: Family = {
      ownerSessionFile: ownerFile, root, localCwd: "/local/workspace", remoteCwd: import.meta.dir,
      connection: { target: "test@example.invalid", displayTarget: "test-remote", cwd: import.meta.dir, workerPath: "/remote/worker.mjs" },
      members: new Set(), lspEnabled: true, closing: false,
    };
    const localPaths: unknown[] = [];
    const harness = await extensionHarness(childFile, undefined, ["write"], async input => {
      localPaths.push(input.path);
      return { content: [{ type: "text", text: "Shown to the user." }] };
    });
    const broker = (globalThis as unknown as Record<symbol, Map<string, Family>>)[Symbol.for("omp-ssh-remote/session-families")]!;
    broker.set(ownerFile, family);
    const registry = spyOn(AgentRegistry, "global").mockReturnValue({ list: () => [{
      id: "Main", sessionFile: childFile, session: {
        instanceKey: `main:${crypto.randomUUID()}`,
        settings: Settings.isolated(), sessionManager: harness.ctx.sessionManager,
        getToolByName: (name: string) => harness.getNativeTool(name),
        runToolRegistryMutation: async <T>(mutation: () => Promise<T>): Promise<T> => await mutation(),
      },
    }] } as never);
    try {
      const state = await admitFixtureMember(harness, family);
      state.client = { isClosed: false, async close() {}, execute() { throw new Error("Reply reached remote filesystem"); } } as unknown as Member["client"];
      await nestedDispatchScope.run({ assertCurrent() {} }, () => harness.executeTool("write", { path: "out://", content: "reply" }));
      expect(localPaths).toEqual(["out://"]);
      await expect(nestedDispatchScope.run({ assertCurrent() {} }, () => harness.executeTool("write", { path: "local://private.txt", content: "no" })))
        .rejects.toThrow("host resource unavailable from the remote runtime");
      expect(localPaths).toEqual(["out://"]);
    } finally {
      registry.mockRestore();
      await harness.emit("session_shutdown");
      broker.delete(ownerFile);
    }
  });

  test("revoked child artifact trees keep new descendants unavailable after shutdown", async () => {
    const ownerFile = `/tmp/remote-family-${crypto.randomUUID()}.jsonl`;
    const root = ownerFile.slice(0, -".jsonl".length);
    const childFile = `${root}/subagent/child.jsonl`;
    const grandchildFile = `${childFile.slice(0, -".jsonl".length)}/subagent/grandchild.jsonl`;
    const closed: string[] = [];
    const family: Family = {
      ownerSessionFile: ownerFile,
      root,
      localCwd: "/local/workspace",
      remoteCwd: "/remote/workspace",
      connection: {
        target: "test@example.invalid",
        displayTarget: "test-remote",
        cwd: "/remote/workspace",
        workerPath: "/remote/worker.mjs",
      },
      members: new Set(),
      lspEnabled: true, closing: false,
    };
    const member = (sessionFile: string, owner: boolean): Member => ({
      binding: crypto.randomUUID(),
      sessionFile,
      localCwd: family.localCwd,
      remoteCwd: family.remoteCwd,
      selected: true,
      owner,
      family,
      wrappedTools: new Set(),
      proposalSources: [],
      activeToolNames: () => [],
      client: {
        isClosed: false,
        async close() { closed.push(owner ? "owner" : "child"); },
      } as unknown as Member["client"],
    });
    const owner = member(ownerFile, true);
    const child = member(childFile, false);
    family.members.add(owner);
    family.members.add(child);
    const key = Symbol.for("omp-ssh-remote/session-families");
    const broker = (globalThis as unknown as Record<symbol, Map<string, Family>>)[key]!;
    const grandchild = await extensionHarness(grandchildFile, undefined, ["read", "write"]);
    broker.set(ownerFile, family);
    try {
      await closeRemoteFamily(family);
      await grandchild.emit("session_start");
      expect(closed.sort()).toEqual(["child", "owner"]);
      expect(broker.has(ownerFile)).toBe(false);
      expect(owner.selected).toBe(false);
      expect(child.selected).toBe(true);
      expect(child.client).toBeUndefined();
      expect(child.family).toBe(family);
      expect(child.connectionError).toContain("local fallback is disabled");
      expect(await grandchild.status()).toMatchObject({
        mode: "unavailable",
        transport: "unavailable",
        sessionRole: "subagent",
        remoteCwd: "/remote/workspace",
        connectionError: expect.stringContaining("revoked"),
      });
      expect(await grandchild.emit("tool_call", { toolName: "task", input: { task: "continue" } }))
        .toMatchObject({ block: true, reason: expect.stringContaining("cannot fall back locally") });
      const notice = await grandchild.emit("before_agent_start");
      expect(notice).toMatchObject({
        message: { details: { mode: "unavailable" }, content: expect.stringContaining("no local fallback") },
      });
      grandchild.accept(notice);
      expect(await grandchild.emit("before_agent_start")).toBeUndefined();

      for (const op of ["pr_checkout", "pr_push", "pr_create", "unknown_operation"]) {
        const params = { op, repo: "owner/repo" };
        for (const call of [
          { toolName: "github", input: params },
          { toolName: "write", input: { path: "xd://github", content: JSON.stringify(params) } },
        ]) {
          expect(await grandchild.emit("tool_call", call)).toMatchObject({
            block: true,
            reason: expect.stringContaining("not remote-adapted"),
          });
        }
      }
      for (const call of [
        { toolName: "github", input: { op: "repo_view" } },
        { toolName: "write", input: { path: "xd://github", content: JSON.stringify({ op: "repo_view" }) } },
      ]) {
        expect(await grandchild.emit("tool_call", call)).toMatchObject({ block: true });
      }
      expect(await grandchild.emit("tool_call", { toolName: "read", input: { path: "xd://github" } }))
        .toBeUndefined();
      expect(await grandchild.emit("tool_call", {
        toolName: "github",
        input: { op: "repo_view", repo: "owner/repo" },
      })).toBeUndefined();
      expect(await grandchild.emit("tool_call", {
        toolName: "write",
        input: { path: "xd://github", content: JSON.stringify({ op: "repo_view", repo: "owner/repo" }) },
      })).toBeUndefined();
      expect((await grandchild.status()).mode).toBe("unavailable");
      expect(child.selected).toBe(true);
    } finally {
      // Remove only the seeded fake child; the descendant shutdown removes the
      // last live member, but must not erase its revoked lineage.
      family.members.delete(child);
      child.selected = false;
      child.family = undefined;
      await grandchild.emit("session_shutdown");
      broker.delete(ownerFile);
    }
    expect(family.members.size).toBe(0);
    expect((await grandchild.status()).mode).toBe("local");
    const afterShutdown = await extensionHarness(grandchildFile);
    try {
      await afterShutdown.emit("session_start");
      expect(await afterShutdown.status()).toMatchObject({
        mode: "unavailable", connectionError: expect.stringContaining("revoked"),
      });
      expect(await afterShutdown.emit("tool_call", { toolName: "task", input: { task: "continue" } }))
        .toMatchObject({ block: true, reason: expect.stringContaining("cannot fall back locally") });
      await expect(afterShutdown.executeTool("remote_exit", { force: true }))
        .rejects.toThrow("Only the owning OMP session can disconnect");
      expect((await afterShutdown.status()).mode).toBe("unavailable");
    } finally {
      await afterShutdown.emit("session_shutdown");
    }
  });
});

describe("native resolution consumption", () => {
  test("returned apply/discard details consume pending entries even for business errors", () => {
    for (const [tool, action] of [["resolve", "apply"], ["reject", "discard"]]) {
      for (const isError of [false, true]) {
        expect(consumedResolution({
          content: [],
          isError,
          details: { xdev: { tool, inner: { action, sourceToolName: "ast_edit" } } },
        })).toBe(true);
      }
    }
  });

  test("help, empty queues, incomplete details, and unrelated devices do not consume", () => {
    for (const result of [
      { content: [] },
      { content: [], details: { xdev: { tool: "resolve", inner: { action: "help" } } } },
      { content: [], details: { xdev: { tool: "reject", inner: { action: "none", pending: 0 } } } },
      { content: [], isError: true, details: { xdev: { tool: "resolve", inner: {} } } },
      { content: [], details: { xdev: { tool: "resolve", inner: { action: "apply" } } } },
      { content: [], details: { xdev: { tool: "ast_edit", inner: { action: "apply", sourceToolName: "ast_edit" } } } },
    ]) {
      expect(consumedResolution(result)).toBe(false);
    }
  });
});
