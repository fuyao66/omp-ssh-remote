import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanConflictLines } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { RemoteConflictHistory } from "../src/omp/conflict-resources.ts";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { isRecord } from "../src/protocol.ts";

const conflict = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";

function register(history: RemoteConflictHistory, path: string) {
  const block = scanConflictLines(conflict.trimEnd().split("\n"), 1)[0]!;
  return history.register({ ...block, absolutePath: path, displayPath: path });
}

function conflictIds(result: unknown): number[] | undefined {
  if (!isRecord(result) || !isRecord(result.details) || !isRecord(result.details.remoteResources)) return undefined;
  return result.details.remoteResources.conflictIds as number[] | undefined;
}

describe("read-owned conflict registrations", () => {
  test("does not infer resources from text or registrations outside this read", async () => {
    const history = new RemoteConflictHistory();
    register(history, "unrelated");
    const original = { content: [{ type: "text", text: "conflict://1\nResolve conflicts with write({ path: 'conflict://1', content: '...' })" }], details: { conflictCount: 1 } };
    expect(await history.captureRead(async () => original)).toBe(original);
  });

  test("captures re-used ids exactly once and preserves result metadata/content", async () => {
    const history = new RemoteConflictHistory();
    const entry = register(history, "first");
    const original = { content: [{ type: "text", text: "untouched" }], details: { count: 7, remoteResources: { other: "kept" } } };
    const result = await history.captureRead(async () => {
      register(history, "first");
      register(history, "first");
      return original;
    });
    expect(conflictIds(result)).toEqual([entry.id]);
    expect(result.content).toBe(original.content);
    expect(result.details).toMatchObject({ count: 7, remoteResources: { other: "kept", conflictIds: [entry.id] } });
    expect(original.details.remoteResources).toEqual({ other: "kept" });
  });

  test("recursive native read wrappers retain registrations on the outer result", async () => {
    const history = new RemoteConflictHistory();
    const original = { content: [], details: { batch: true } };
    const result = await history.captureRead(async () => {
      for (const path of ["one", "two"]) {
        const child = await history.captureRead(async () => {
          register(history, path);
          return { content: [], details: {} };
        });
        // Like ReadTool's batch assembler, intentionally discard child details.
        expect(conflictIds(child)).toBeUndefined();
      }
      return original;
    });
    expect(conflictIds(result)).toEqual(history.entries().map(entry => entry.id));
    expect(conflictIds(result)).toHaveLength(2);
    expect(result.content).toBe(original.content);
  });

  test("overlapping async reads own only their own native registrations", async () => {
    const history = new RemoteConflictHistory();
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const result = { content: [], details: {} };
    const first = history.captureRead(async () => {
      register(history, "first-before-await");
      entered();
      await released;
      register(history, "first-after-await");
      return result;
    });
    await started;
    const second = await history.captureRead(async () => {
      register(history, "second");
      release();
      await Promise.resolve();
      return result;
    });
    const firstResult = await first;
    const entries = history.entries();
    expect(conflictIds(firstResult)).toEqual(entries.filter(entry => entry.absolutePath.startsWith("first-")).map(entry => entry.id));
    expect(conflictIds(second)).toEqual(entries.filter(entry => entry.absolutePath === "second").map(entry => entry.id));
    expect(await history.captureRead(async () => result)).toBe(result);
  });

  test("failed reads do not leak ownership into subsequent reads", async () => {
    const history = new RemoteConflictHistory();
    await expect(history.captureRead(async () => {
      register(history, "failed");
      throw new Error("read failed");
    })).rejects.toThrow("read failed");
    const original = { content: [] };
    register(history, "outside");
    expect(await history.captureRead(async () => original)).toBe(original);
  });

  test("native runtime emits structured ids for multi-path, concurrent and repeated reads only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-read-conflicts-"));
    const runtime = await createNativeWorkerRuntime(cwd, "test");
    try {
      for (const file of ["one.txt", "two.txt", "three.txt", "four.txt"]) await writeFile(join(cwd, file), conflict);
      await writeFile(join(cwd, "literal.txt"), "conflict://999 is documentation, not a native registration\n");
      const multi = await runtime.tools.read.execute("multi", { path: "one.txt;two.txt" });
      const history = runtime.session.conflictHistory!;
      const multiIds = history.entries().filter(entry => ["one.txt", "two.txt"].includes(entry.displayPath)).map(entry => entry.id);
      expect(multiIds).toHaveLength(2);
      expect([...(conflictIds(multi) ?? [])].sort((a, b) => a - b)).toEqual([...multiIds].sort((a, b) => a - b));
      const repeat = await runtime.tools.read.execute("repeat", { path: "one.txt" });
      expect(conflictIds(repeat)).toEqual([history.entries().find(entry => entry.displayPath === "one.txt")!.id]);
      const paths = ["three.txt", "four.txt"];
      const concurrent = await Promise.all(paths.map(path => runtime.tools.read.execute(path, { path })));
      concurrent.forEach((result, index) => expect(conflictIds(result)).toEqual([history.entries().find(entry => entry.displayPath === paths[index])!.id]));
      const literal = await runtime.tools.read.execute("literal", { path: "literal.txt" });
      expect(conflictIds(literal)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
