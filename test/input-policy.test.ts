import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@oh-my-pi/pi-coding-agent";
import { extractFileMentions } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { parseLoopArgs } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import remoteRuntimeExtension, { closeRemoteFamily } from "../src/extension.ts";

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
  const ctx = {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [], getCwd: () => cwd },
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); }, setStatus() {} },
  } as unknown as ExtensionContext;
  await remoteRuntimeExtension({
    registerCommand() {}, registerTool() {},
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
    async close() { await handlers.get("session_shutdown")!({}, ctx); },
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
});
