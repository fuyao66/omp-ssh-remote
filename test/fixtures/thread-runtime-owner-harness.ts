import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { ThreadRuntime, ThreadRuntimeOwner, type ThreadRuntimeConnection } from "../../src/thread-runtime.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../../src/omp/runtime-contract.ts";

type Identity = { pid: number; start: string; parent: number; acknowledged?: boolean };
const root = process.env.TEST_THREAD_SOCKET_ROOT;
if (!root) throw new Error("Missing isolated thread socket fixture directory");
const connection: ThreadRuntimeConnection = { target: "socket-fixture.invalid", workerPath: "/fixture/worker", cwd: "/fixture/workspace" };

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  // Only a failure deadline: fake timers cannot drive a real SSH child or worker's socket.
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), 8_000);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

async function currentIdentity(pid: number): Promise<(Identity & { state: string }) | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    return { pid, start: fields[19]!, parent: Number(fields[1]), state: fields[0]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertLive(identity: Identity): Promise<void> {
  const current = await currentIdentity(identity.pid);
  assert.equal(current?.start, identity.start, "the announced companion identity must still be live");
  assert.notEqual(current?.state, "Z", "a zombie is not a live companion");
  assert.equal(current?.parent, process.pid, "the main owner, not the worker, must own the SSH child");
}

async function assertExited(identity: Identity): Promise<void> {
  const current = await currentIdentity(identity.pid);
  assert.notEqual(current?.start, identity.start, "owner disposal must reap the exact companion, not merely close its protocol");
}

async function facade(): Promise<unknown> {
  let revoked = false;
  let disposed = 0;
  const owner = await ThreadRuntimeOwner.create(() => connection, () => {
    if (revoked) throw new Error("fixture family revoked");
  }, () => { disposed++; });
  let runtime: ThreadRuntime | undefined;
  const release = Promise.withResolvers<void>();
  try {
    runtime = await ThreadRuntime.connect(owner.address);
    const client = await runtime.createClient(connection);
    await client.initialize(connection.cwd, OMP_RUNTIME_HANDSHAKE);
    const identity = await client.execute("read", "event-before-activation", {}) as Identity;
    await assertLive(identity);
    assert.equal(identity.acknowledged, false);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    client.onEvent(async event => { first.push(event); firstEntered.resolve(); await release.promise; });
    // A round-trip after the early event proves registration alone is not activation.
    await client.execute("read", "one-listener-barrier", {});
    assert.deepEqual(first, []);
    client.onEvent(event => { second.push(event); secondEntered.resolve(); });
    assert.equal(typeof client.activateEvents, "function");
    client.activateEvents!();
    await deadline(Promise.all([firstEntered.promise, secondEntered.promise]), "both event listeners");
    assert.equal(first.length, 1);
    assert.deepEqual(first, second);
    const held = await client.execute("read", "held-event-ack", {}) as Identity;
    assert.equal(held.acknowledged, false, "ACK must wait for every activated listener");
    release.resolve();
    const acknowledged = await deadline(client.execute("read", "all-listeners-settled", { waitForAck: true }), "event ACK") as Identity;
    assert.equal(acknowledged.acknowledged, true);

    revoked = true;
    await assert.rejects(runtime.createClient(connection), /fixture family revoked/);
    await assert.rejects(client.execute("read", "revoked-execute", {}), /fixture family revoked/);
    await assert.rejects(client.initialize(connection.cwd, OMP_RUNTIME_HANDSHAKE), /fixture family revoked/);
    await assert.rejects(client.stopService("fixture", "instance"), /fixture family revoked/);
    await assert.rejects(runtime.prepare(), /fixture family revoked/);
    const exit = client.waitForExit();
    void exit.catch(() => {});
    const closing = client.close();
    assert.equal(client.close(), closing);
    await deadline(closing, "revoked client close");
    assert.equal(await deadline(exit, "revoked client waitForExit"), 0);
    assert.equal(client.isClosed, true);
    await assertExited(identity);
    const disposal = runtime.dispose();
    assert.equal(runtime.dispose(), disposal);
    await deadline(disposal, "revoked facade disposal");
    await owner.dispose();
    await owner.dispose();
    assert.equal(disposed, 1);
    const records = (await readFile(join(root!, "companions.jsonl"), "utf8")).trim().split("\n");
    assert.equal(records.length, 1, "revoked createClient must not launch a replacement process");
    return { listeners: [first.length, second.length], acknowledged: true, revoked: true, disposed, identity };
  } finally {
    release.resolve();
    await runtime?.dispose().catch(() => {});
    await owner.dispose();
  }
}

async function probeMainSurvival(): Promise<Identity> {
  const owner = await ThreadRuntimeOwner.create(() => connection, () => {});
  let runtime: ThreadRuntime | undefined;
  try {
    runtime = await ThreadRuntime.connect(owner.address);
    const client = await runtime.createClient(connection);
    client.activateEvents?.();
    await client.initialize(connection.cwd, OMP_RUNTIME_HANDSHAKE);
    const identity = await client.execute("read", "main-still-owns-processes", { waitForAck: true }) as Identity;
    await assertLive(identity);
    await client.close();
    assert.equal(await client.waitForExit(), 0);
    await assertExited(identity);
    return identity;
  } finally {
    await runtime?.dispose().catch(() => {});
    await owner.dispose();
  }
}

async function disappear(mode: "exit" | "terminate"): Promise<unknown> {
  const disposed = Promise.withResolvers<void>();
  const owner = await ThreadRuntimeOwner.create(() => connection, () => {}, disposed.resolve);
  let worker: Worker | undefined;
  let exited = false;
  try {
    worker = new Worker(new URL("./thread-runtime-socket-peer.ts", import.meta.url), {
      workerData: { address: owner.address, connection },
    });
    const ready = Promise.withResolvers<{ ready: true; guardRejected: true; identity: Identity }>();
    void ready.promise.catch(() => {});
    worker.on("message", message => { if (message?.ready) ready.resolve(message); });
    worker.on("error", ready.reject);
    worker.on("exit", code => { exited = true; ready.reject(new Error(`peer exited before readiness (${code})`)); });
    const workerExit = once(worker, "exit");
    void workerExit.catch(() => {});
    const peer = await deadline(ready.promise, "worker's initialized socket facade");
    assert.equal(peer.guardRejected, true);
    await assertLive(peer.identity);
    if (mode === "exit") worker.postMessage("exit");
    else await deadline(worker.terminate(), "abrupt worker termination");
    await deadline(workerExit, "peer worker exit");
    await deadline(disposed.promise, "socket-owned main cleanup");
    await assertExited(peer.identity);
    assert.equal(await readFile(join(root!, `shutdown-${peer.identity.pid}-${peer.identity.start}`), "utf8"), "shutdown received");
    // The same main process must remain capable of native child ownership after
    // the peer dies; successful protocol closure alone does not establish this.
    const survivor = await probeMainSurvival();
    return { mode, mainPid: process.pid, peer: peer.identity, survivor, disposed: true, guardRejected: true };
  } finally {
    try { if (worker && !exited) await deadline(worker.terminate(), "peer cleanup"); }
    finally { await owner.dispose(); }
  }
}

const mode = process.argv[2];
const report = mode === "facade" ? await facade()
  : mode === "exit" || mode === "terminate" ? await disappear(mode)
  : (() => { throw new Error(`Unknown socket ownership scenario: ${mode}`); })();
process.stdout.write(`${JSON.stringify(report)}\n`);
