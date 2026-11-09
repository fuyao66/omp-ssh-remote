import { afterEach, expect, test } from "bun:test";
import { BroadcastChannel } from "node:worker_threads";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { getRemoteFamilyBroker } from "../src/family-broker.ts";
import { ThreadFamilyBridge, type ThreadFamilyDecision, type ThreadFamilySource, type ThreadMemberIdentity } from "../src/thread-family.ts";
import type { WorkerCommand } from "./fixtures/thread-family-worker.ts";

type ActiveDecision = Extract<ThreadFamilyDecision, { kind: "active" }>;
type Stats = { closeStarted: number; closeFinished: number };
type Reply = { id?: string; event?: string; value?: unknown; error?: string };
type WireFrame = Reply & { from: string; to: string; kind: string; request?: { op: string; identity?: ThreadMemberIdentity } };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
const cleanups: Array<() => Promise<void>> = [];

// Bun 1.4.4's rejects.toThrow defers Worker error-message delivery until the RPC
// watchdog fires; the identical raw-message probe settles immediately with
// ordinary await/catch. Await delivery first, then assert the error synchronously.
async function workerRejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the worker command to reject");
}

afterEach(async () => {
  const settled = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Thread-family fixture cleanup failed");
});

async function harness(options: { remote?: boolean; authority?: boolean } = {}) {
  const key = crypto.randomUUID();
  const channelName = `remote-thread-family-test-${key}`;
  const registry = AgentRegistry.global();
  const broker = getRemoteFamilyBroker<ThreadFamilySource>();
  const owner = `/tmp/remote-thread-family-${key}/owner.jsonl`;
  const sessionFile = owner.slice(0, -6) + "/child.jsonl";
  const instanceKey = crypto.randomUUID();
  const handle = { instanceKey, sessionManager: { getSessionFile: () => sessionFile } } as unknown as AgentSessionHandle;
  const input = { id: `thread-family-${key}`, displayName: "Thread family fixture", kind: "sub" as const,
    session: handle, sessionFile, status: "running" as const };
  const ref = registry.register(input);
  const identity: ThreadMemberIdentity = { agentId: ref.id, registryGeneration: ref.generation, instanceKey, sessionFile };
  const family: ThreadFamilySource = {
    ownerSessionFile: owner, members: new Set(), closing: false,
    localCwd: "/local/workspace", remoteCwd: "/remote/workspace",
    connection: { target: "worker.example.invalid", displayTarget: "fixture", cwd: "/remote/workspace", workerPath: "/remote/worker.mjs" },
  };
  if (options.remote !== false) broker.register(family);
  const authority = options.authority === false ? undefined : new ThreadFamilyBridge(channelName);
  const wire = new BroadcastChannel(channelName);
  const wirePending = new Map<string, Pending>();
  let peer: string | undefined;
  wire.onmessage = event => {
    const frame = event.data as WireFrame;
    if (frame.kind === "request" && frame.request?.op === "reserve" && frame.request.identity?.agentId === identity.agentId) peer = frame.from;
    if (frame.kind !== "reply" || !frame.id) return;
    const pending = wirePending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    wirePending.delete(frame.id);
    if (frame.error) pending.reject(new Error(frame.error)); else pending.resolve(frame.value);
  };
  const worker = new Worker(new URL("./fixtures/thread-family-worker.ts", import.meta.url).href, { type: "module" });
  const pending = new Map<string, Pending>();
  const ready = Promise.withResolvers<void>();
  const eventWaiters = new Map<string, Array<() => void>>();
  const events = new Map<string, number>();
  const eventTimers = new Set<NodeJS.Timeout>();
  // Watchdogs bound failed worker IPC only; successful tests await messages,
  // never a guessed elapsed duration or a sleep.
  const readyTimer = setTimeout(() => ready.reject(new Error("Thread-family worker did not start")), 5_000);
  worker.onmessage = event => {
    const reply = event.data as Reply;
    if (reply.event === "ready") { clearTimeout(readyTimer); ready.resolve(); return; }
    if (reply.event) {
      const waiter = eventWaiters.get(reply.event)?.shift();
      if (waiter) waiter(); else events.set(reply.event, (events.get(reply.event) ?? 0) + 1);
      return;
    }
    if (!reply.id) return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(reply.id);
    if (reply.error) entry.reject(new Error(reply.error)); else entry.resolve(reply.value);
  };
  worker.onerror = event => {
    const error = new Error(event.message || "Thread-family worker failed");
    ready.reject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    event.preventDefault();
  };
  function rpc<T = unknown>(command: WorkerCommand): Promise<T> {
    const id = crypto.randomUUID();
    const result = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { pending.delete(id); result.reject(new Error(`Worker command ${command.op} did not settle`)); }, 5_000);
    pending.set(id, { ...result, timer });
    worker.postMessage({ ...command, id });
    return result.promise as Promise<T>;
  }
  function nextEvent(name: string): Promise<void> {
    const count = events.get(name) ?? 0;
    if (count > 0) { events.set(name, count - 1); return Promise.resolve(); }
    const result = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      eventTimers.delete(timer);
      result.reject(new Error(`Worker event ${name} did not arrive`));
    }, 5_000);
    eventTimers.add(timer);
    const waiters = eventWaiters.get(name) ?? [];
    waiters.push(() => { clearTimeout(timer); eventTimers.delete(timer); result.resolve(); });
    eventWaiters.set(name, waiters);
    return result.promise;
  }
  function rawClose(token: string): Promise<unknown> {
    if (!peer) throw new Error("Worker peer was not observed on the control channel");
    const id = crypto.randomUUID();
    const result = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { wirePending.delete(id); result.reject(new Error("Duplicate close was not acknowledged")); }, 5_000);
    wirePending.set(id, { ...result, timer });
    wire.postMessage({ protocol: 1, from: "main", to: peer, id, kind: "request", request: { op: "close", token } });
    return result.promise;
  }
  cleanups.push(async () => {
    clearTimeout(readyTimer);
    registry.unregister(identity.agentId);
    authority?.reap();
    try {
      await authority?.dispose();
      await rpc({ op: "dispose" });
    } finally {
      worker.terminate();
      wire.close();
      for (const entry of [...pending.values(), ...wirePending.values()]) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Thread-family fixture stopped"));
      }
      pending.clear();
      wirePending.clear();
      for (const timer of eventTimers) clearTimeout(timer);
      eventTimers.clear();
      family.members.clear();
      family.lineage?.clear();
      broker.revoke(family);
    }
  });
  await ready.promise;
  await rpc({ op: "init", channelName });
  return { rpc, nextEvent, rawClose, authority, identity, family, broker, registry, ref, input,
    async active(): Promise<ActiveDecision> {
      const decision = await rpc<ThreadFamilyDecision>({ op: "reserve", identity });
      expect(decision.kind).toBe("active");
      if (decision.kind !== "active") throw new Error("Expected active family decision");
      return decision;
    } };
}

test("real worker reserve distinguishes local sessions from active remote families", async () => {
  const local = await harness({ remote: false });
  expect(await local.rpc<ThreadFamilyDecision>({ op: "reserve", identity: local.identity })).toEqual({ kind: "local" });
  const remote = await harness();
  const decision = await remote.active();
  expect(decision.token).toBeString();
  expect(decision.family).toMatchObject({ ownerSessionFile: remote.family.ownerSessionFile,
    localCwd: "/local/workspace", remoteCwd: "/remote/workspace", connection: remote.family.connection });
  expect(decision.family.revocation).toBeInstanceOf(SharedArrayBuffer);
  expect(Atomics.load(new Int32Array(decision.family.revocation), 0)).toBe(0);
  expect(remote.family.threadMembers?.size).toBe(1);
  await remote.rpc({ op: "commit", token: decision.token, generation: decision.family.generation, identity: remote.identity });
  await remote.rpc({ op: "detach", token: decision.token, identity: remote.identity });
  expect(remote.family.threadMembers?.size).toBe(0);
}, 15_000);

test("reserve rejects stale registry generation, instance identity, and transcript path", async () => {
  const h = await harness();
  const changed = [
    { ...h.identity, registryGeneration: h.identity.registryGeneration + 1 },
    { ...h.identity, instanceKey: crypto.randomUUID() },
    { ...h.identity, sessionFile: h.identity.sessionFile + ".other" },
  ];
  for (const identity of changed) {
    expect((await workerRejection(h.rpc({ op: "reserve", identity }))).message).toContain("session was replaced or detached");
    expect(h.family.threadMembers?.size ?? 0).toBe(0);
  }
}, 15_000);

test("commit rejects a stale family generation and a replaced registry ref", async () => {
  const h = await harness();
  const decision = await h.active();
  expect((await workerRejection(h.rpc({ op: "commit", token: decision.token, generation: "stale-family-generation", identity: h.identity }))).message).toContain("generation changed during attachment");
  const replacement = h.registry.register(h.input);
  expect(replacement.generation).not.toBe(h.identity.registryGeneration);
  expect((await workerRejection(h.rpc({ op: "commit", token: decision.token, generation: decision.family.generation, identity: h.identity }))).message).toContain("session was replaced or detached");
  expect(h.family.threadMembers?.size).toBe(0);
}, 15_000);

test("revocation rejects commit and reaches the worker lease without any close delivery", async () => {
  const h = await harness();
  const decision = await h.active();
  expect(await h.rpc<string>({ op: "lease" })).toBe("active");
  h.broker.revoke(h.family);
  expect(Atomics.load(new Int32Array(decision.family.revocation), 0)).toBe(1);
  expect((await workerRejection(h.rpc({ op: "lease" }))).message).toContain("revoked; local fallback is disabled");
  expect((await workerRejection(h.rpc({ op: "commit", token: decision.token, generation: decision.family.generation, identity: h.identity }))).message).toContain("revoked; local fallback is disabled");
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 0, closeFinished: 0 });
  expect(h.family.threadMembers?.size).toBe(1);
}, 15_000);

test("close ACK waits for native cleanup, and duplicate close with no callback is harmless", async () => {
  const h = await harness();
  const decision = await h.active();
  const control = [...h.family.threadMembers!][0]!;
  await h.rpc({ op: "hold-close" });
  const started = h.nextEvent("closing");
  let acknowledged = false;
  const closing = control.close().then(() => { acknowledged = true; });
  await started;
  expect(acknowledged).toBe(false);
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 1, closeFinished: 0 });
  await h.rpc({ op: "release-close" });
  await closing;
  expect(h.family.threadMembers?.size).toBe(0);
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 1, closeFinished: 1 });
  await h.rawClose(decision.token);
  await control.close();
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 1, closeFinished: 1 });
}, 15_000);

test("silent native registry detach is reaped and subsequent detach is idempotent", async () => {
  const h = await harness();
  const decision = await h.active();
  const control = [...h.family.threadMembers!][0]!;
  expect(h.registry.detachSession(h.identity.agentId, h.ref)).toBe(true);
  expect(h.family.threadMembers?.size).toBe(1);
  h.authority!.reap();
  expect(h.family.threadMembers?.size).toBe(0);
  await control.close();
  await h.rpc({ op: "detach", token: decision.token, identity: h.identity });
  await h.rpc({ op: "detach", token: decision.token, identity: h.identity });
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 0, closeFinished: 0 });
}, 15_000);

test("membership-consuming close reaps a silently detached registry ref before sending", async () => {
  const h = await harness();
  await h.active();
  const control = [...h.family.threadMembers!][0]!;
  expect(h.registry.detachSession(h.identity.agentId, h.ref)).toBe(true);
  await control.close();
  expect(h.family.threadMembers?.size).toBe(0);
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 0, closeFinished: 0 });
}, 15_000);

test("authority disposal revokes the shared lease and awaits worker cleanup", async () => {
  const h = await harness();
  const decision = await h.active();
  await h.authority!.dispose();
  expect(Atomics.load(new Int32Array(decision.family.revocation), 0)).toBe(1);
  expect(await h.rpc<Stats>({ op: "stats" })).toEqual({ closeStarted: 1, closeFinished: 1 });
  expect(h.family.threadMembers?.size).toBe(0);
  expect((await workerRejection(h.rpc({ op: "lease" }))).message).toContain("revoked; local fallback is disabled");
}, 15_000);

test("an absent authority times out fail-closed without a ten-second hard wait", async () => {
  const h = await harness({ authority: false, remote: false });
  expect((await workerRejection(h.rpc({ op: "fast-timeout", identity: h.identity }))).message).toContain("Remote family control timed out; local fallback is disabled");
}, 15_000);
