import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import remoteRuntimeExtension, {
  closeRemoteFamily,
  consumedResolution,
  type RemoteWorkspaceStatus,
} from "../src/extension.ts";

type Family = Parameters<typeof closeRemoteFamily>[0];
type Member = Family["members"] extends Set<infer State> ? State : never;
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

async function extensionHarness(
  sessionFile: string,
  manager = SessionManager.inMemory("/local/workspace"),
  activeTools: string[] = [],
  invokeTool?: (params: Record<string, unknown>) => Promise<AgentToolResult>,
) {
  const handlers = new Map<string, Hook>();
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    cwd: "/local/workspace",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => manager.getBranch(),
    },
    ui: { notify() {}, setStatus() {} },
    invokeTool,
  } as unknown as ExtensionContext;
  const api = {
    registerCommand() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: Hook) { handlers.set(event, handler); },
    getActiveTools: () => activeTools,
    getAllTools: () => activeTools.map((name) => ({
      name,
      description: `Native ${name}`,
      parameters: {},
      sourceInfo: { source: "builtin" },
    })),
  };
  await remoteRuntimeExtension(api as unknown as ExtensionAPI);
  return {
    handlers,
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
      return await handler(event, ctx);
    },
    async status(): Promise<RemoteWorkspaceStatus> {
      const tool = tools.get("remote_workspace_status");
      if (!tool) throw new Error("Missing remote_workspace_status tool");
      const result = await tool.execute("architecture-status", {}, undefined, undefined, ctx);
      return result.details as RemoteWorkspaceStatus;
    },
  };
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

  test.each(["legacy", "native"])("corrects restored %s remote history only after native acceptance", async (kind) => {
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
            mode: "local",
            target: null,
            cwd: "/local/workspace",
          },
          content: expect.stringContaining("Workspace binding: local; local host;"),
        },
      });
      // A cancelled first attempt never entered native history: retry it.
      const retry = await harness.emit("before_agent_start");
      expect(retry).toMatchObject({ message: { details: { mode: "local", target: null, cwd: "/local/workspace" } } });
      harness.accept(retry);
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      expect(await harness.emit("before_agent_start")).toBeUndefined();
      expect(manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "remote-workspace-binding")).toHaveLength(kind === "native" ? 2 : 1);
      expect(manager.getBranch().at(-1)).toMatchObject({ type: "custom_message", details: { mode: "local" } });
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("hot switch and native branch navigation do not inherit a previous notice decision", async () => {
    const manager = SessionManager.inMemory("/local/workspace");
    const remoteId = manager.appendCustomMessageEntry("remote-workspace-binding", "Remote history", false, {
      binding: "previous-remote", mode: "remote", target: "old-host", cwd: "/old/remote",
    });
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

  test("native proc root aliases merge local listings with remote services, never specific ids", async () => {
    const ownerFile = `/tmp/proc-family-${crypto.randomUUID()}.jsonl`;
    const root = ownerFile.slice(0, -".jsonl".length);
    const childFile = `${root}/subagent/child.jsonl`;
    const family: Family = {
      ownerSessionFile: ownerFile, root, localCwd: "/local/workspace", remoteCwd: "/remote/workspace",
      connection: { target: "test@example.invalid", displayTarget: "test-remote", cwd: "/remote/workspace", workerPath: "/remote/worker.mjs" },
      members: new Set(), closing: true,
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
      // Attach without opening SSH; substitute only the transport boundary.
      await harness.emit("session_start");
      const state = [...family.members][0]!;
      state.connectionError = undefined;
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

  test("revoked child artifact trees keep new descendants unavailable until shutdown", async () => {
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
      closing: false,
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
      // Remove only the seeded fake child; the real descendant shutdown removes
      // the last live member and exercises production tombstone cleanup.
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
      expect((await afterShutdown.status()).mode).toBe("local");
      expect(await afterShutdown.emit("tool_call", { toolName: "task", input: { task: "local" } }))
        .toBeUndefined();
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
