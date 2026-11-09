import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@oh-my-pi/pi-coding-agent";
import { extractFileMentions } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { parseLoopArgs } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import remoteRuntimeExtension, { closeRemoteFamily } from "../src/extension.ts";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { z } from "@oh-my-pi/omptype/zod";
import { handleTodoAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import { executeSearchRepos, resolveSearchRepoScope } from "@oh-my-pi/pi-coding-agent/tools/gh-search";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

type Family = Parameters<typeof closeRemoteFamily>[0];
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

async function harness(selected: boolean, bareSlashCommands = false, cwd = "/local/workspace") {
  const handlers = new Map<string, Hook>();
  const notifications: { message: string; level: string }[] = [];
  const ownerFile = `/tmp/input-policy-${crypto.randomUUID()}.jsonl`;
  const settings = Settings.isolated({ "input.bareSlashCommands": bareSlashCommands });
  const root = ownerFile.slice(0, -".jsonl".length);
  const sessionFile = `${root}/subagent/child.jsonl`;
  const family: Family = {
    ownerSessionFile: ownerFile, root, localCwd: "/local/workspace", remoteCwd: "/remote/workspace",
    connection: { target: "fixture.invalid", displayTarget: "fixture", cwd: "/remote/workspace", workerPath: "/remote/worker" },
    members: new Set(), closing: true,
  };
  const families = (globalThis as unknown as Record<symbol, Map<string, Family>>)[Symbol.for("omp-ssh-remote/session-families")]!;
  const manager = await SessionManager.open(sessionFile, dirname(sessionFile), undefined, { initialCwd: cwd, suppressBreadcrumb: true });
  const ctx = {
    cwd,
    agent: { kind: "main", id: "owner", name: "owner", depth: 0 },
    sessionManager: manager,
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); }, setStatus() {} },
  } as unknown as ExtensionContext;
  const registry = AgentRegistry.global();
  const session = {
    instanceKey: `main:${crypto.randomUUID()}`, sessionManager: manager, settings,
    getToolByName: () => undefined, getAdvisorStats: () => ({ configured: false, advisors: [] }),
    async runToolRegistryMutation(mutate: () => Promise<void>) { await mutate(); },
  } as unknown as AgentSessionHandle;
  const ref = registry.register({
    id: ctx.agent.id, displayName: ctx.agent.name, kind: ctx.agent.kind, session, sessionFile,
  });
  await remoteRuntimeExtension({
    registerCommand() {}, registerTool() {},
    appendEntry(customType: string, data?: unknown) { manager.appendCustomEntry(customType, data); },
    on(name: string, handler: Hook) { handlers.set(name, handler); },
    getActiveTools: () => [], getAllTools: () => [],
  } as unknown as ExtensionAPI);
  if (selected) families.set(ownerFile, family);
  try {
    // A revoked family selects remote mode without starting a transport. Input
    // protection must also hold when the selected runtime is unavailable.
    await handlers.get("session_start")!({}, ctx);
  } finally {
    families.delete(ownerFile);
  }
  expect(handlers.has("input"), "extension must register the native input hook").toBe(true);
  notifications.length = 0;
  return {
    notifications,
    async submit(text: string, source: InputEvent["source"] = "interactive") {
      return await withActiveSettings(settings, () => handlers.get("input")!({ type: "input", text, source }, ctx)) as InputEventResult | undefined;
    },
    async tool(toolName: string, input: unknown = {}, agentId?: string) {
      const toolCtx = agentId ? { ...ctx, agent: { kind: "sub", id: agentId, name: agentId, depth: 0, parentId: "owner" } } as ExtensionContext : ctx;
      return await handlers.get("tool_call")!({ type: "tool_call", toolName, input }, toolCtx);
    },
    async advisorDispatch() {
      // Owner-wrapper availability must not authorize the separate advisor slate.
      for (const member of family.members) member.wrappedTools.add("read");
      const extension = { path: "remote-fixture", handlers: new Map([["tool_call", [handlers.get("tool_call")!]]]) };
      const runner = new ExtensionRunner([extension] as never, {} as never, cwd, ctx.sessionManager as never, {} as never);
      let executed = false;
      const tool = new ExtensionToolWrapper({ name: "read", label: "read", description: "fixture", parameters: z.object({ path: z.string() }), approval: "read",
        async execute() { executed = true; return { content: [{ type: "text" as const, text: "local secret" }] }; },
      }, runner, { kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId: "owner" });
      await tool.execute("advisor-direct-cursor-exec", { path: "README.md" });
      return executed;
    },
    async close() {
      try { await handlers.get("session_shutdown")!({}, ctx); }
      finally {
        registry.unregister(ref.id, ref);
        await manager.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

const commands = ["/git", "/security", "/wt", "/move", "/add-dir", "/remove-dir", "/review", "/annotate"];

describe("remote native input policy", () => {
  for (const selected of [false, true]) {
    test.each(commands)(`%s with arguments while ${selected ? "remote" : "local"}`, async command => {
      const h = await harness(selected);
      try {
        expect(await h.submit(`${command} argument`)).toEqual(selected ? { handled: true } : undefined);
        expect(h.notifications).toHaveLength(selected ? 1 : 0);
        if (selected) expect(h.notifications[0]).toMatchObject({
          level: "warning", message: expect.stringContaining(`${command} would act on the local machine while bound to remote`),
        });
      } finally { await h.close(); }
    });
  }

  test.each(commands)("rejects exact bare %s but not command prefixes", async command => {
    const h = await harness(true);
    try {
      expect(await h.submit(command)).toEqual({ handled: true });
      expect(await h.submit(`${command}x`)).toBeUndefined();
      expect(await h.submit(`Discuss ${command}`)).toBeUndefined();
      expect(h.notifications).toHaveLength(1);
    } finally { await h.close(); }
  });

  for (const selected of [false, true]) {
    test.each(["/worktree", ...commands.filter(command => !["/review", "/annotate"].includes(command)).map(command => `${command}:argument`), "/worktree:argument"])(
      `native alias and colon syntax %s while ${selected ? "remote" : "local"}`, async text => {
        const h = await harness(selected);
        try {
          expect(await h.submit(text)).toEqual(selected ? { handled: true } : undefined);
          expect(h.notifications).toHaveLength(selected ? 1 : 0);
        } finally { await h.close(); }
      },
    );
  }

  test("native registry exposes worktree alias and case-sensitive command names", () => {
    expect(lookupBuiltinSlashCommand("worktree")?.name).toBe("wt");
    for (const command of commands) {
      const name = command.slice(1);
      expect(lookupBuiltinSlashCommand(name.toUpperCase())).toBeUndefined();
      expect(parseSlashCommand(`${command}:argument`)).toMatchObject({ name, args: "argument" });
    }
    expect(lookupBuiltinSlashCommand("sec")).toBeUndefined();
  });

  test.each([...commands.map(command => command.toUpperCase()), "/WORKTREE", "/sec", "/review:argument", "/annotate:argument"])("preserves native non-command %s", async text => {
    const h = await harness(true);
    try {
      expect(await h.submit(text)).toBeUndefined();
      expect(h.notifications).toEqual([]);
    } finally { await h.close(); }
  });

  for (const selected of [false, true]) {
    for (const enabled of [false, true]) {
      test.each([...commands.map(command => command.slice(1)), "worktree", "WT", "GIT", "WORKTREE"])(
        `bare %s while selected=${selected} and input.bareSlashCommands=${enabled}`, async text => {
          const h = await harness(selected, enabled);
          try {
            expect(await h.submit(text)).toEqual(selected && enabled ? { handled: true } : undefined);
            expect(h.notifications).toHaveLength(selected && enabled ? 1 : 0);
          } finally { await h.close(); }
        },
      );
    }
  }

  test.each([" git", "git ", "git diff", "WT argument", "gitx", "sec"])("bare mode preserves prompt %s", async text => {
    const h = await harness(true, true);
    try { expect(await h.submit(text)).toBeUndefined(); }
    finally { await h.close(); }
  });

  test.each(["rpc", "extension"] as const)("bare mode does not reinterpret %s input", async source => {
    const h = await harness(true, true);
    try { expect(await h.submit("git", source)).toBeUndefined(); }
    finally { await h.close(); }
  });

  for (const selected of [false, true]) {
    test.each(["/loop --until 'bun test' fix tests", "/loop 10 --while 'test -e pending' continue", "/loop 10m --until='bun test' fix tests", "/loop --while='bun test' continue", "/loop:--until='bun test' fix tests", "/loop:10 --while='bun test' continue"])(
      `conditional %s while ${selected ? "remote" : "local"}`, async text => {
        const h = await harness(selected);
        try {
          expect(await h.submit(text)).toEqual(selected ? { handled: true } : undefined);
          expect(h.notifications).toHaveLength(selected ? 1 : 0);
          if (selected) expect(h.notifications[0]!.message).toContain("/loop would act on the local machine while bound to remote");
        } finally { await h.close(); }
      },
    );
  }

  test.each(["/loop", "/loop 5", "/loop 10m improve tests", "/loop --untilx", "/loop fix this --until 'bun test'", "/loop --until", "/loop --until=''", "/gitx", "git diff"])("allows %s remotely", async text => {
    const h = await harness(true);
    try {
      expect(await h.submit(text)).toBeUndefined();
      expect(h.notifications).toEqual([]);
    } finally { await h.close(); }
  });

  test.each(["-u 'bun test'", "-w 'bun test'", "-u='bun test'", "-w='bun test'", "--UNTIL 'bun test'", "--WHILE='bun test'", "--untilx 'bun test'"])("native loop parser does not treat %s as a condition", async args => {
    const parsed = parseLoopArgs(args);
    expect(typeof parsed === "string" || parsed.condition === undefined).toBe(true);
    const h = await harness(true);
    try { expect(await h.submit(`/loop ${args}`)).toBeUndefined(); }
    finally { await h.close(); }
  });

  test.each(["--until 'bun test'", "--while 'bun test'", "--until='bun test'", "--while='bun test'"])("native loop parser recognizes %s as a condition", args => {
    const parsed = parseLoopArgs(args);
    expect(typeof parsed).toBe("object");
    expect(typeof parsed !== "string" && parsed.condition?.command).toBe("bun test");
  });

  for (const selected of [false, true]) {
    test.each(["Inspect @src/index.ts", 'Inspect @"a file.ts"', "Inspect (@src/index.ts).", "Contact a@b.c", "An ordinary @", "Empty @''"])(
      `native mention parity for %s while ${selected ? "remote" : "local"}`, async text => {
        const h = await harness(selected);
        try {
          const blocked = selected && (await generateFileMentionMessages(extractFileMentions(text), "/local/workspace")).length > 0;
          expect(await h.submit(text)).toEqual(blocked ? { handled: true } : undefined);
          expect(h.notifications).toHaveLength(blocked ? 1 : 0);
          if (blocked) {
            expect(h.notifications[0]!.message).toContain("@path");
            expect(h.notifications[0]!.message).toContain("Drop @ and use remote read");
          }
        } finally { await h.close(); }
      },
    );
  }

  test("allows nonexistent native mentions, model aliases and prose while remote", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-mention-prose-"));
    const h = await harness(true, false, cwd);
    try {
      for (const text of ["/switch @vision", "/switch @default", "Use @pytest.mark", "Inspect @missing.ts", "Inspect @prefix"]) {
        await writeFile(join(cwd, "prefix-extra.ts"), "not an exact mention");
        expect(await generateFileMentionMessages(extractFileMentions(text), cwd)).toEqual([]);
        expect(await h.submit(text)).toBeUndefined();
      }
      expect(h.notifications).toEqual([]);
    } finally { await h.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  test.each(["interactive", "rpc"] as const)("native consumed switch bypasses existing mentions for %s input", async source => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-switch-mention-"));
    const h = await harness(true, false, cwd);
    try {
      await writeFile(join(cwd, "vision"), "host secret");
      await writeFile(join(cwd, "default"), "another host secret");
      for (const text of ["/switch @vision", "/switch @default", "/switch:@vision"]) {
        expect(await h.submit(text, source)).toBeUndefined();
      }
      expect(h.notifications).toEqual([]);
      expect(await h.submit("read @vision", source)).toEqual({ handled: true });
      expect(await h.submit("/switchx @vision", source)).toEqual({ handled: true });
    } finally { await h.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("rejects only native-resolvable host mentions against the session cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-mention-files-"));
    const h = await harness(true, false, cwd);
    try {
      await writeFile(join(cwd, "a file.ts"), "host secret");
      await mkdir(join(cwd, "directory"));
      await symlink("a file.ts", join(cwd, "alias.ts"));
      await symlink("missing.ts", join(cwd, "dangling.ts"));
      for (const text of ['Inspect @"a file.ts"', "Inspect @alias.ts", "Inspect (@directory).", `Inspect @"${join(cwd, "a file.ts")}"`]) {
        expect((await generateFileMentionMessages(extractFileMentions(text), cwd)).length).toBeGreaterThan(0);
        expect(await h.submit(text)).toEqual({ handled: true });
      }
      expect(await h.submit("Inspect @dangling.ts")).toBeUndefined();
    } finally { await h.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  test.each(["interactive", "rpc", "extension"] as const)("protects native %s input events", async source => {
    const h = await harness(true);
    try { expect(await h.submit("/review", source)).toEqual({ handled: true }); }
    finally { await h.close(); }
  });

  test.each([false, true])("autoresearch command and tools remain local-only while selected=%s", async selected => {
    const h = await harness(selected);
    try {
      expect(await h.submit("/autoresearch optimize")).toEqual(selected ? { handled: true } : undefined);
      expect(await h.submit("/autoresearchx optimize")).toBeUndefined();
      for (const toolName of ["init_experiment", "run_experiment", "log_experiment", "update_notes"]) {
        expect(await h.tool(toolName)).toEqual(selected ? { block: true, reason: expect.stringMatching(/autoresearch.*local/i) } : undefined);
      }
    } finally { await h.close(); }
  });

  test.each([false, true])("todo file transfers alone are blocked while selected=%s", async selected => {
    const h = await harness(selected);
    try {
      for (const text of ["/todo export", "/todo import notes.md", "/todo:EXPORT notes.md", "/todo Import"]) {
        expect(await h.submit(text)).toEqual(selected ? { handled: true } : undefined);
      }
      for (const text of ["/todo", "/todo copy", "/todo append read README.md", "/todo done task", "/todo exportx"]) {
        expect(await h.submit(text)).toBeUndefined();
      }
    } finally { await h.close(); }
  });

  test.each(["interactive", "rpc"] as const)("todo append consumes literal mentions for %s input", async source => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-todo-mention-"));
    const h = await harness(true, false, cwd);
    try {
      await writeFile(join(cwd, "README.md"), "host secret");
      expect(await h.submit("/todo append Review @README.md", source)).toBeUndefined();
      expect(await h.submit("/todo:APPEND Review @README.md", source)).toBeUndefined();
      expect(await h.submit("/todo append Review @README.md", "extension")).toEqual({ handled: true });
      expect(await h.submit("/todo unknown @README.md", source)).toEqual({ handled: true });
      expect(await h.submit("read @README.md", source)).toEqual({ handled: true });
    } finally { await h.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("repository-scoped GitHub searches cannot infer the local checkout", async () => {
    const h = await harness(true);
    try {
      for (const op of ["search_issues", "search_prs", "search_code", "search_commits"]) {
        expect(await h.tool("github", { op, query: "needle" })).toEqual({ block: true, reason: expect.stringContaining("explicit repo") });
        expect(await h.tool("write", { path: "xd://github", content: JSON.stringify({ op, query: "needle" }) })).toEqual({ block: true, reason: expect.stringContaining("explicit repo") });
        expect(await h.tool("github", { op, repo: "example/project", query: "needle" })).toBeUndefined();
        for (const scope of ["repo:example/project", "org:example", "user:example", "owner:example", "-repo:example/excluded"]) {
          expect(await h.tool("github", { op, query: `${scope} needle` })).toBeUndefined();
        }
        expect(await h.tool("github", { op, query: '"needle-repo:example/project"' })).toEqual({ block: true, reason: expect.stringContaining("explicit repo") });
      }
      expect(await h.tool("github", { op: "search_repos", query: "needle" })).toBeUndefined();
    } finally { await h.close(); }
  });

  test.each([false, true])("advisor workspace calls cannot use the owner wrappers while selected=%s", async selected => {
    const h = await harness(selected);
    try {
      for (const toolName of ["read", "write", "edit", "bash", "grep", "glob", "lsp", "ast_grep", "ast_edit", "eval", "debug"]) {
        expect(await h.tool(toolName, {}, "advisor")).toEqual(selected ? {
          block: true, reason: expect.stringMatching(/advisor tools run locally.*not routed/i),
        } : undefined);
      }
      expect(await h.tool("web_search", {}, "advisor")).toBeUndefined();
    } finally { await h.close(); }
  });

  test("native advisor direct execution preserves advisor identity at the registered gate", async () => {
    const h = await harness(true);
    try { await expect(h.advisorDispatch()).rejects.toThrow(/advisor tools run locally.*not routed/i); }
    finally { await h.close(); }
  });

  test("native todo append stores mentions literally while export and import use local files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-native-todo-"));
    let phases: unknown[] = [];
    const runtime = {
      sessionManager: { getBranch: () => [], getCwd: () => cwd, appendCustomEntry() {} },
      session: { getTodoPhases: () => phases, commitTodoPhases(next: unknown[]) { phases = next; } },
      async output() {},
    };
    const run = (args: string) => handleTodoAcp(parseSlashCommand(`/todo ${args}`)!, runtime as never);
    try {
      expect(await run("append Review @README.md")).toEqual({ consumed: true });
      expect(JSON.stringify(phases)).toContain("@README.md");
      await run("export tasks.md");
      expect(await Bun.file(join(cwd, "tasks.md")).text()).toContain("@README.md");
      phases = [];
      await run("import tasks.md");
      expect(JSON.stringify(phases)).toContain("@README.md");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("native GitHub explicit scopes bypass cwd and repository search stays global", async () => {
    const requests: string[][] = [];
    const transport = spyOn(github, "json").mockImplementation(async (_cwd, args) => { requests.push(args); return { items: [] } as never; });
    try {
      expect(await resolveSearchRepoScope("/missing/checkout", "example/project", "needle", undefined)).toBe("example/project");
      for (const qualifier of ["repo:example/project", "org:example", "user:example", "owner:example", "-repo:example/project"]) {
        expect(await resolveSearchRepoScope("/missing/checkout", undefined, `${qualifier} needle`, undefined)).toBeUndefined();
      }
      await executeSearchRepos({ cwd: "/missing/checkout" } as never, { op: "search_repos", query: "needle" }, undefined);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.join(" ")).not.toContain("repo:");
    } finally { transport.mockRestore(); }
  });
});
