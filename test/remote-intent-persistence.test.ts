import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage, type SessionStorageWriter, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { persistRemoteIntent, REMOTE_INTENT_ENTRY } from "../src/remote-intent.ts";

class FaultStorage extends FileSessionStorage {
  fault?: "append" | "write" | "flush";
  readonly failure = new Error("Injected native session storage failure");
  appendCalls = 0;
  writeCalls = 0;
  flushCalls = 0;
  drainCalls = 0;
  beforeDrain?: () => Promise<void>;

  override async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
    this.writeCalls++;
    if (this.fault === "write") throw this.failure;
    await super.writeTextAtomic(file, content, options);
  }

  override openWriter(file: string, options?: { flags?: "a" | "w"; onError?: (error: Error) => void }): SessionStorageWriter {
    const native = super.openWriter(file, options);
    return {
      append: async line => {
        this.appendCalls++;
        if (this.fault === "append") throw this.failure;
        await native.append(line);
      },
      appendSync: line => {
        this.appendCalls++;
        if (this.fault === "append") throw this.failure;
        native.appendSync!(line);
      },
      flush: async () => {
        this.flushCalls++;
        if (this.fault === "flush") throw this.failure;
        await native.flush();
      },
      flushSync: () => native.flushSync?.(),
      isOpen: () => native.isOpen(),
      close: () => native.close(),
      getError: () => native.getError(),
    };
  }

  override async drain(): Promise<void> {
    this.drainCalls++;
    await this.beforeDrain?.();
    await super.drain();
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const settled = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Native persistence fixture cleanup failed");
});

async function nativeSession() {
  const root = await mkdtemp(join(tmpdir(), "remote-intent-persistence-"));
  const storage = new FaultStorage();
  const manager = SessionManager.create(root, join(root, "sessions"), storage);
  cleanups.push(async () => {
    storage.fault = undefined;
    storage.beforeDrain = undefined;
    try {
      try { await manager.close(); }
      catch (error) {
        // Native managers intentionally keep the original disk failure latched.
        if (error !== storage.failure) throw error;
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  return { manager, storage, file: manager.getSessionFile()! };
}

function append(manager: SessionManager, remote: boolean): void {
  manager.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote });
}

async function persistedIntent(file: string): Promise<unknown> {
  const parsed = parseSessionContent(await readFile(file, "utf8"));
  expect(parsed.invalidHeader).toBe(false);
  expect(parsed.malformedRecords).toBe(0);
  return parsed.entries.filter(entry => entry.type === "custom" && entry.customType === REMOTE_INTENT_ENTRY).at(-1);
}

test("native durability barriers create a fresh metadata-only session before resolving", async () => {
  const h = await nativeSession();
  expect(await Bun.file(h.file).exists()).toBe(false);
  expect(h.manager.getEntries()).toHaveLength(0);
  await persistRemoteIntent(() => append(h.manager, true), h.manager);
  expect(h.manager.getSessionFile()).toBe(h.file);
  expect(h.manager.getEntries().some(entry => entry.type === "message")).toBe(false);
  expect(await persistedIntent(h.file)).toMatchObject({ type: "custom", customType: REMOTE_INTENT_ENTRY,
    data: { version: 1, remote: true } });
  expect(h.storage.writeCalls).toBeGreaterThan(0);
  expect(h.storage.drainCalls).toBeGreaterThan(0);
});

test("a later explicit local intent is durably appended before resolving", async () => {
  const h = await nativeSession();
  await persistRemoteIntent(() => append(h.manager, true), h.manager);
  await persistRemoteIntent(() => append(h.manager, false), h.manager);
  expect(await persistedIntent(h.file)).toMatchObject({ data: { version: 1, remote: false } });
  expect(h.storage.appendCalls).toBeGreaterThan(0);
  expect(h.storage.flushCalls).toBeGreaterThan(0);
});

test("fresh-session native atomic-write failure rejects the persistence operation", async () => {
  const h = await nativeSession();
  h.storage.fault = "write";
  let appendReturned = false;
  let resolved = false;
  const pending = persistRemoteIntent(() => {
    append(h.manager, true);
    appendReturned = true;
  }, h.manager).then(() => { resolved = true; });
  await expect(pending).rejects.toBe(h.storage.failure);
  expect(appendReturned).toBe(true);
  expect(resolved).toBe(false);
  expect(h.storage.writeCalls).toBeGreaterThan(0);
  expect(await Bun.file(h.file).exists()).toBe(false);
});

test("native append errors swallowed by appendCustomEntry reject through the barrier", async () => {
  const h = await nativeSession();
  await persistRemoteIntent(() => append(h.manager, false), h.manager);
  h.storage.fault = "append";
  let appendReturned = false;
  let resolved = false;
  const pending = persistRemoteIntent(() => {
    append(h.manager, true);
    appendReturned = true;
  }, h.manager).then(() => { resolved = true; });
  await expect(pending).rejects.toBe(h.storage.failure);
  expect(appendReturned).toBe(true);
  expect(resolved).toBe(false);
  expect(h.storage.appendCalls).toBeGreaterThan(0);
  expect(await persistedIntent(h.file)).toMatchObject({ data: { version: 1, remote: false } });
});

test("native writer flush failure rejects even after the intent reached the file", async () => {
  const h = await nativeSession();
  await persistRemoteIntent(() => append(h.manager, false), h.manager);
  h.storage.fault = "flush";
  let resolved = false;
  const pending = persistRemoteIntent(() => append(h.manager, true), h.manager).then(() => { resolved = true; });
  await expect(pending).rejects.toBe(h.storage.failure);
  expect(resolved).toBe(false);
  expect(h.storage.flushCalls).toBeGreaterThan(0);
  expect(await persistedIntent(h.file)).toMatchObject({ data: { version: 1, remote: true } });
});

test("persistence remains pending until the native storage drain has completed", async () => {
  const h = await nativeSession();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.storage.beforeDrain = async () => { entered.resolve(); await release.promise; };
  let resolved = false;
  const pending = persistRemoteIntent(() => append(h.manager, true), h.manager).then(() => { resolved = true; });
  try {
    await entered.promise;
    expect(resolved).toBe(false);
    expect(await persistedIntent(h.file)).toMatchObject({ data: { version: 1, remote: true } });
  } finally { release.resolve(); }
  await pending;
  expect(resolved).toBe(true);
});

test("in-memory sessions reject before invoking append", async () => {
  const manager = SessionManager.inMemory("/project");
  let called = false;
  await expect(persistRemoteIntent(() => { called = true; }, manager)).rejects.toThrow("requires a persistent session");
  expect(called).toBe(false);
  expect(manager.getEntries()).toHaveLength(0);
});

test("append callback failures reject before forcing a native disk write", async () => {
  const h = await nativeSession();
  const failure = new Error("Append callback failed");
  await expect(persistRemoteIntent(() => { throw failure; }, h.manager)).rejects.toBe(failure);
  expect(h.storage.writeCalls).toBe(0);
  expect(h.storage.drainCalls).toBe(0);
});

test("a changed session path at the flush boundary cannot report successful persistence", async () => {
  const h = await nativeSession();
  const getSessionFile = spyOn(h.manager, "getSessionFile");
  h.storage.beforeDrain = async () => { getSessionFile.mockReturnValue(h.file + ".replaced"); };
  try {
    await expect(persistRemoteIntent(() => append(h.manager, true), h.manager))
      .rejects.toThrow("Session changed while persisting remote workspace intent");
  } finally { getSessionFile.mockRestore(); }
});
