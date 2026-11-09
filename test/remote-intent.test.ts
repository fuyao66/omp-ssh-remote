import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { inheritedRemoteIntent, latestRemoteIntent, REMOTE_INTENT_ENTRY } from "../src/remote-intent.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "remote-intent-"));
  roots.push(root);
  return root;
}

function session(remote?: boolean): SessionManager {
  const manager = SessionManager.inMemory("/project");
  if (remote !== undefined) manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote });
  return manager;
}

async function transcript(file: string, manager: SessionManager): Promise<string> {
  const body = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  return body;
}

test("latest native custom record preserves both boolean states", () => {
  const manager = session();
  expect(latestRemoteIntent(manager.getEntries())).toBeUndefined();
  manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: true });
  expect(latestRemoteIntent(manager.getEntries())).toBe(true);
  manager.appendCustomEntry("unrelated-extension", { version: 1, remote: true });
  manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: false });
  expect(latestRemoteIntent(manager.getEntries())).toBe(false);
});

test("only native custom entries with this custom type are intent records", () => {
  const manager = session();
  manager.appendCustomEntry("other-intent", { version: 1, remote: true });
  manager.appendCustomMessageEntry(REMOTE_INTENT_ENTRY, "not an intent", false, { version: 1, remote: true });
  expect(latestRemoteIntent(manager.getEntries())).toBeUndefined();
});

test("rewinding conversation cannot undo a remote selection or explicit local exit", () => {
  for (const remote of [true, false]) {
    const manager = session(!remote);
    const oldId = manager.getLeafId()!;
    manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote });
    manager.branch(oldId);
    expect(latestRemoteIntent(manager.getEntries())).toBe(remote);
  }
});

test.each(["remote", "unavailable"])("legacy %s notices prohibit local execution without restoring connection settings", mode => {
  for (const kind of ["custom", "custom_message"]) {
    const manager = session();
    if (kind === "custom") manager.appendCustomEntry("remote-workspace-context-v1", { mode, target: "old.example.invalid", cwd: "/old/workspace" });
    else manager.appendCustomMessageEntry("remote-workspace-binding", "Old workspace", false, { mode, target: "old.example.invalid", cwd: "/old/workspace" });
    expect(latestRemoteIntent(manager.getEntries())).toBe(true);
    manager.appendCustomMessageEntry("remote-workspace-binding", "Old automatic local correction", false, { mode: "local" });
    expect(latestRemoteIntent(manager.getEntries())).toBe(true);
    manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: false });
    expect(latestRemoteIntent(manager.getEntries())).toBe(false);
  }
});

test("an explicit v1 local intent wins even over a later legacy remote notice", () => {
  const manager = session(false);
  manager.appendCustomMessageEntry("remote-workspace-binding", "Non-authoritative old notice", false, { mode: "remote" });
  expect(latestRemoteIntent(manager.getEntries())).toBe(false);
});

test("legacy local notices alone do not select a remote workspace", () => {
  const manager = session();
  manager.appendCustomEntry("remote-workspace-context-v1", { mode: "local" });
  manager.appendCustomMessageEntry("remote-workspace-binding", "Local workspace", false, { mode: "local" });
  expect(latestRemoteIntent(manager.getEntries())).toBeUndefined();
});

test("malformed matching intent records fail closed instead of coercing local execution", () => {
  for (const data of [undefined, null, [], true, {}, { remote: true }, { version: 2, remote: true },
    { version: "1", remote: true }, { version: 1, remote: "false" }, { version: 1, remote: 0 }]) {
    const manager = session(true);
    manager.appendCustomEntry(REMOTE_INTENT_ENTRY, data);
    expect(() => latestRemoteIntent(manager.getEntries())).toThrow("Persisted remote workspace intent is invalid");
  }
});

test("a newer explicit intent supersedes an older malformed record", () => {
  const manager = session();
  manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: "invalid" });
  manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: false });
  expect(latestRemoteIntent(manager.getEntries())).toBe(false);
});

test("restored child inherits durable remote intent without opening or modifying its parent", async () => {
  const root = await temporaryRoot();
  const parent = join(root, "parent.jsonl");
  const original = await transcript(parent, session(true));
  const child = join(root, "parent", "child.jsonl");
  expect(await inheritedRemoteIntent(child, [])).toBe(true);
  expect(await readFile(parent, "utf8")).toBe(original);
});

test("a restored child inherits only a prohibition from a legacy remote ancestor", async () => {
  const root = await temporaryRoot(), manager = session();
  manager.appendCustomMessageEntry("remote-workspace-binding", "Old remote workspace", false, { mode: "remote", target: "old.example.invalid", cwd: "/old/workspace" });
  manager.appendCustomMessageEntry("remote-workspace-binding", "Old local correction", false, { mode: "local" });
  const parent = join(root, "parent.jsonl"), original = await transcript(parent, manager);
  expect(await inheritedRemoteIntent(join(root, "parent", "child.jsonl"), [])).toBe(true);
  expect(await readFile(parent, "utf8")).toBe(original);
});

test("nested child finds the root ancestor through a missing immediate transcript", async () => {
  const root = await temporaryRoot();
  await transcript(join(root, "parent.jsonl"), session(true));
  const child = join(root, "parent", "subagent", "child.jsonl");
  expect(await inheritedRemoteIntent(child, [])).toBe(true);
});

test("nearest explicit ancestor state overrides a more distant remote ancestor", async () => {
  const root = await temporaryRoot();
  await transcript(join(root, "parent.jsonl"), session(true));
  await transcript(join(root, "parent", "subagent.jsonl"), session(false));
  expect(await inheritedRemoteIntent(join(root, "parent", "subagent", "child.jsonl"), [])).toBe(false);
});

test("a child explicitly returned to local mode overrides a remote ancestor", async () => {
  const root = await temporaryRoot();
  await transcript(join(root, "parent.jsonl"), session(true));
  expect(await inheritedRemoteIntent(join(root, "parent", "child.jsonl"), session(false).getEntries())).toBe(false);
});

test("explicit child intent does not inspect an unreadable ancestor", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, "parent.jsonl"));
  expect(await inheritedRemoteIntent(join(root, "parent", "child.jsonl"), session(false).getEntries())).toBe(false);
  expect(await inheritedRemoteIntent(join(root, "parent", "child.jsonl"), session(true).getEntries())).toBe(true);
});

test("missing ancestors and in-memory sessions have no inferred intent", async () => {
  const root = await temporaryRoot();
  expect(await inheritedRemoteIntent(join(root, "absent", "child.jsonl"), [])).toBeUndefined();
  expect(await inheritedRemoteIntent(undefined, [])).toBeUndefined();
  expect(await inheritedRemoteIntent(undefined, session(false).getEntries())).toBe(false);
});

test("an ancestor without intent does not hide a remote root ancestor", async () => {
  const root = await temporaryRoot();
  await transcript(join(root, "parent.jsonl"), session(true));
  await transcript(join(root, "parent", "subagent.jsonl"), session());
  expect(await inheritedRemoteIntent(join(root, "parent", "subagent", "child.jsonl"), [])).toBe(true);
});

test("ancestor intent remains chronological despite native activeLeafId rewind markers", async () => {
  const root = await temporaryRoot();
  for (const remote of [true, false]) {
    const manager = session(!remote);
    const oldId = manager.getLeafId()!;
    manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote });
    manager.getEntries().at(-1)!.activeLeafId = oldId;
    await transcript(join(root, "parent.jsonl"), manager);
    expect(await inheritedRemoteIntent(join(root, "parent", "child.jsonl"), [])).toBe(remote);
  }
});

test("malformed existing ancestors fail closed with no transcript or path disclosure", async () => {
  const root = await temporaryRoot();
  const file = join(root, "private-parent.jsonl");
  const child = join(root, "private-parent", "child.jsonl");
  const malformedIntent = session();
  malformedIntent.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: "private-secret" });
  const valid = await transcript(file, session(true));
  const cases = ["", "private-secret not json\n", "{}\n", `${valid}private-secret\n`,
    `${JSON.stringify({ type: "session", id: "missing-header-fields" })}\n`,
    `${valid}${JSON.stringify(session().getHeader())}\n`,
    [malformedIntent.getHeader(), ...malformedIntent.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n"];
  for (const body of cases) {
    await writeFile(file, body);
    let failure: unknown;
    try {
      await inheritedRemoteIntent(child, []);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("Cannot restore ancestor remote workspace intent");
    expect(message).not.toContain(root);
    expect(message).not.toContain("private-secret");
    expect((failure as Error).cause).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(body);
  }
});

test("unreadable existing ancestor is not treated as a missing transcript", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, "parent.jsonl"));
  await expect(inheritedRemoteIntent(join(root, "parent", "child.jsonl"), []))
    .rejects.toThrow("Cannot read ancestor remote workspace intent");
});
