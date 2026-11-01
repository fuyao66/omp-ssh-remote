import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspDiagnosticRevisions } from "../src/omp/lsp-revisions.ts";
import { RemoteLspDiagnostics } from "../src/omp/lsp-diagnostics.ts";
import type { DeferredDiagnosticsEntry } from "@oh-my-pi/pi-coding-agent/tools";

test("exact committed revisions preserve no-op/navigation/unrelated writes, invalidate LSP/AST and partial failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lsp-revision-"));
  const path = join(cwd, "file.ts"); const other = join(cwd, "other.ts");
  const versions = new Map<string, number>(); const delivered: string[] = [];
  const revisions = new LspDiagnosticRevisions(p => versions.get(p) ?? 0,
    p => versions.set(p, (versions.get(p) ?? 0) + 1), e => delivered.push(e.summary));
  const entry = (version: number, summary: string): DeferredDiagnosticsEntry => ({ path, summary, messages: [summary], errored: true,
    isStale: () => versions.get(path) !== version });
  try {
    await writeFile(path, "old");
    revisions.begin(); versions.set(path, 1); revisions.bumped(path, 1);
    await writeFile(path, "new"); revisions.end();
    // Late result belongs to post-commit bytes, not the old bytes at begin().
    revisions.begin(); revisions.diagnostics(entry(1, "new error"));
    await writeFile(other, "unrelated"); revisions.end();
    expect(delivered).toEqual(["new error"]);
    revisions.begin(); revisions.diagnostics(entry(1, "hover/no-op")); revisions.end();
    expect(delivered).toEqual(["new error", "hover/no-op"]);
    // Native LSP and AST commits do not call bumpFileMutationVersion.
    revisions.begin(); revisions.diagnostics(entry(1, "obsolete"));
    await writeFile(path, "renamed symbol"); revisions.end();
    expect(versions.get(path)).toBe(2);
    expect(delivered).not.toContain("obsolete");
    revisions.begin(); versions.set(path, 3); revisions.bumped(path, 3); await writeFile(path, "fresh"); revisions.end();
    revisions.begin(); revisions.diagnostics(entry(3, "partial apply obsolete"));
    try { await writeFile(path, "partial"); throw new Error("later apply failed"); } catch {} finally { revisions.end(); }
    expect(versions.get(path)).toBe(4); expect(delivered).not.toContain("partial apply obsolete");
  } finally { revisions.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("host RPC completion cannot release the authoritative worker mutation fence", async () => {
  const queued: DeferredDiagnosticsEntry[] = [];
  const owner = { yieldQueue: { enqueueWithReceipt<P>(_kind: string, entry: P) { queued.push(entry as DeferredDiagnosticsEntry); return Promise.resolve(); } } };
  const channel = new RemoteLspDiagnostics(owner, "owner", "binding", () => true);
  const event = { sessionId: "owner", resourceBinding: "binding", path: "/a.ts", version: 1,
    summary: "error", messages: ["error"], errored: true };
  channel.mutation(event);
  const endRpc = channel.beginMutation();
  channel.operation({ sessionId: "owner", resourceBinding: "binding", id: 1 }, "begin");
  channel.diagnostics(event); endRpc();
  expect(queued).toHaveLength(0);
  channel.operation({ sessionId: "owner", resourceBinding: "binding", id: 1 }, "end");
  expect(queued).toHaveLength(1);
  channel.close();
});
