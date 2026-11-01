import { describe, expect, test } from "bun:test";
import { RemoteLspDiagnostics, mayMutateLsp, parseLspEvent, type LspDiagnostics } from "../src/omp/lsp-diagnostics.ts";
import type { DeferredDiagnosticsEntry } from "@oh-my-pi/pi-coding-agent/tools";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { DeferredDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/deferred-diagnostics";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";

function harness() {
  const pending: { entry: DeferredDiagnosticsEntry; resolve(): void; reject(error: Error): void }[] = [];
  const delivered: DeferredDiagnosticsEntry[] = [];
  let current = true;
  const owner = { yieldQueue: {
    enqueueWithReceipt<P>(_kind: string, value: P): Promise<void> {
      const receipt = Promise.withResolvers<void>();
      pending.push({ entry: value as DeferredDiagnosticsEntry, ...receipt });
      return receipt.promise;
    },
  } };
  const channel = new RemoteLspDiagnostics(owner, "owner", "binding", () => current);
  const event = (version = 1): LspDiagnostics => ({ sessionId: "owner", resourceBinding: "binding", path: "/project/a.ts",
    version, summary: "1 error", messages: ["type error"], errored: true });
  const flush = () => {
    for (const item of pending.splice(0)) {
      if (item.entry.isStale()) item.reject(new Error("stale"));
      else { delivered.push(item.entry); item.resolve(); }
    }
  };
  return { channel, event, delivered, pending, flush, detach: () => { current = false; } };
}

describe("owned remote late diagnostics", () => {
  test("native queue receives structured diagnostics without a follow-up renderer", () => {
    const h = harness(); h.channel.mutation(h.event()); h.channel.diagnostics(h.event());
    expect(h.delivered).toHaveLength(0); h.flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.messages).toEqual(["type error"]);
  });
  test("cross-tool mutation invalidates an entry at actual lazy consumption", () => {
    const h = harness(); h.channel.mutation(h.event()); h.channel.diagnostics(h.event());
    h.channel.mutation(h.event(2)); h.flush(); expect(h.delivered).toHaveLength(0);
    h.channel.diagnostics(h.event(2)); h.flush(); expect(h.delivered).toHaveLength(1);
  });
  test("in-flight mutation stages late results and preserves a no-op mutation", async () => {
    const h = harness(); h.channel.mutation(h.event()); h.channel.diagnostics(h.event());
    const end = h.channel.beginMutation(); h.flush(); expect(h.delivered).toHaveLength(0);
    end(); end(); await Promise.resolve(); h.flush(); expect(h.delivered).toHaveLength(1);
  });
  test("a mutation bump suppresses a staged entry instead of replaying old content", async () => {
    const h = harness(); h.channel.mutation(h.event());
    const end = h.channel.beginMutation(); h.channel.diagnostics(h.event());
    h.channel.mutation(h.event(2)); end(); await Promise.resolve(); h.flush();
    expect(h.delivered).toHaveLength(0);
  });
  test("close, detach and owner/binding mismatch never reach another native session", () => {
    for (const invalidate of ["close", "detach", "owner", "binding"] as const) {
      const h = harness(); h.channel.mutation(h.event());
      const entry = h.event();
      if (invalidate === "owner") entry.sessionId = "child";
      if (invalidate === "binding") entry.resourceBinding = "old";
      h.channel.diagnostics(entry);
      if (invalidate === "close") h.channel.close();
      if (invalidate === "detach") h.detach();
      h.flush(); expect(h.delivered).toHaveLength(0);
    }
  });
  test("malformed payloads and nonadvancing mutation stream fail closed", () => {
    const h = harness();
    expect(() => parseLspEvent({ ...h.event(), version: -1 }, true)).toThrow("version");
    expect(() => parseLspEvent({ ...h.event(), messages: [1] }, true)).toThrow("diagnostics");
    h.channel.mutation(h.event()); expect(() => h.channel.mutation(h.event())).toThrow("advance");
  });
  test("only mutation-capable calls hold diagnostics", () => {
    expect(mayMutateLsp("edit", {})).toBe(true);
    expect(mayMutateLsp("write", {})).toBe(true);
    expect(mayMutateLsp("lsp", { action: "rename" })).toBe(true);
    expect(mayMutateLsp("lsp", { action: "diagnostics" })).toBe(false);
    expect(mayMutateLsp("eval", {})).toBe(false);
  });
});

test("actual native write/edit producers share ordered versions and suppress old delivery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "remote-lsp-producer-"));
  const received: LspDiagnostics[] = [];
  const order: string[] = [];
  const runtime = await createNativeWorkerRuntime(cwd, "18.15.0", {
    sessionId: "native-owner", resourceBinding: "native-binding",
    settings: { "lsp.diagnosticsDeduplicate": false },
    onLspMutation: event => order.push(`mutation:${event.version}`),
    onDeferredDiagnostics: event => { order.push(`diagnostics:${event.version}`); received.push(event); },
  });
  try {
    const path = join(cwd, "file.ts");
    const edit = new DeferredDiagnostics(runtime.session).begin(path);
    const write = new DeferredDiagnostics(runtime.session).begin(path);
    const result = { messages: ["type error"], summary: "1 error", errored: true };
    edit.onDeferredDiagnostics(result);
    write.onDeferredDiagnostics(result);
    expect(order).toEqual(["mutation:1", "mutation:2", "diagnostics:2"]);
    expect(received).toEqual([{ sessionId: "native-owner", resourceBinding: "native-binding", path,
      version: 2, ...result }]);
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("native YieldQueue rejects held lazy entries and requeues unchanged diagnostics once", async () => {
  const queue = new YieldQueue({ isStreaming: () => true, injectIdle: async () => {}, scheduleIdleFlush() {} });
  queue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
    isStale: entry => entry.isStale(),
    build: entries => ({ role: "custom", customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
      content: entries.map(entry => entry.summary).join("\n"), display: true, timestamp: Date.now() }),
  });
  const channel = new RemoteLspDiagnostics({ yieldQueue: queue }, "owner", "binding", () => true);
  const event = { sessionId: "owner", resourceBinding: "binding", path: "/project/a.ts", version: 1,
    summary: "1 error", messages: ["native late error"], errored: true };
  channel.mutation(event); channel.diagnostics(event);
  const end = channel.beginMutation();
  // Peeking must not create a second queued copy. Lazy injection rejects the
  // original receipt when our predicate temporarily holds the native entry.
  expect(queue.hasDeliverable(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE)).toBe(false);
  expect(queue.hasDeliverable(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE)).toBe(false);
  const held = queue.drainLazy(); expect(held).toHaveLength(1); expect(held[0]!()).toBeNull();
  await Promise.resolve(); end();
  const delivered = queue.drainLazy(); expect(delivered).toHaveLength(1);
  expect(delivered[0]!()).toMatchObject({ content: "1 error" });
  expect(queue.drainLazy()).toHaveLength(0);
  channel.close();
});
