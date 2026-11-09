import assert from "node:assert/strict";
import { mock } from "bun:test";
import type { PreparedRemoteWorker, RemoteWorkerCacheAudit, RemoteWorkerPreparation } from "../../src/deploy.ts";
import type { ThreadRuntime as ThreadRuntimeFacade, ThreadRuntimeConnection } from "../../src/thread-runtime.ts";

const outcome = process.argv[2];
assert.ok(outcome === "commit-resolve" || outcome === "commit-reject");
const commitEntered = Promise.withResolvers<void>();
const releaseCommit = Promise.withResolvers<RemoteWorkerCacheAudit>();
const disposeEntered = Promise.withResolvers<void>();
const audit: RemoteWorkerCacheAudit = {
  observedAt: "fixture-observation", available: false, warning: "isolated commit settlement fixture",
};
let commitCalls = 0;
let disposeCalls = 0;
const prepared: PreparedRemoteWorker = {
  workerPath: "/fixture/prepared-worker", home: "/fixture/home", signal: new AbortController().signal,
  cacheAudit: audit,
  commitUsage() {
    commitCalls++;
    commitEntered.resolve();
    return releaseCommit.promise;
  },
  async dispose() { disposeCalls++; disposeEntered.resolve(); },
};
// Only the external deployment boundary is replaced. The real owner, native
// RpcLink, socket carrier and facade retain their normal public implementations.
// This process exits after one scenario, so module mocking cannot leak to tests.
mock.module(new URL("../../src/deploy.ts", import.meta.url).pathname, () => ({
  startRemoteWorkerPreparation(): RemoteWorkerPreparation {
    return { ready: Promise.resolve(prepared), settled: Promise.resolve() };
  },
}));
// Intentional module-loading boundary: a static import would run the real
// deployment module before the isolated replacement above is installed.
const { ThreadRuntime, ThreadRuntimeOwner } = await import("../../src/thread-runtime.ts");
const connection: ThreadRuntimeConnection = {
  target: "commit-fixture.invalid", cwd: "/fixture/workspace", workerPath: "/fixture/worker",
};
let revoked = false;
let ownerDisposed = 0;
const owner = await ThreadRuntimeOwner.create(() => connection, () => {
  if (revoked) throw new Error("fixture family revoked");
}, () => { ownerDisposed++; });
let runtime: ThreadRuntimeFacade | undefined;

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  // Failure deadline only: fake time cannot advance the real socket's replies.
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), 8_000);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

try {
  runtime = await ThreadRuntime.connect(owner.address);
  const remotePrepared = await runtime.prepare();
  const commit = remotePrepared.commitUsage();
  const commitResult = Promise.allSettled([commit]); // Consume rejection before releasing either outcome.
  await deadline(commitEntered.promise, "owner commit entry");
  revoked = true;
  let ownerClosed = false;
  let facadeClosed = false;
  const closing = owner.close().then(() => { ownerClosed = true; });
  const disposing = runtime.dispose().then(() => { facadeClosed = true; });
  void closing.catch(() => {});
  void disposing.catch(() => {});
  await deadline(disposeEntered.promise, "prepared lease disposal entry");
  // Every other mocked producer/disposer is already settled. An event-loop
  // fence drains their Promise continuations; without commit tracking the local
  // owner.close() would have fulfilled before this fence, independent of I/O.
  const fence = Promise.withResolvers<void>();
  setImmediate(fence.resolve);
  await fence.promise;
  assert.equal(ownerClosed, false, "owner.close must await the already admitted commit after revocation");
  assert.equal(facadeClosed, false, "the close RPC must not ACK before commit settlement");
  await assert.rejects(remotePrepared.commitUsage(), /owner is closing/);
  assert.equal(commitCalls, 1, "closing cannot admit another cache commit");
  if (outcome === "commit-reject") releaseCommit.reject(new Error("fixture commit failed"));
  else releaseCommit.resolve(audit);
  const result = (await deadline(commitResult, "in-flight commit settlement"))[0]!;
  if (outcome === "commit-reject") {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(result.reason.message, /fixture commit failed/);
  } else {
    assert.equal(result.status, "fulfilled");
    assert.deepEqual(remotePrepared.cacheAudit, audit);
  }
  await deadline(Promise.all([closing, disposing]), "post-commit close acknowledgements");
  await owner.dispose();
  assert.equal(ownerDisposed, 1);
  assert.ok(disposeCalls >= 1);
  process.stdout.write(`${JSON.stringify({ disposed: ownerDisposed, revoked, commitCalls, ownerClosed, facadeClosed, outcome })}\n`);
} finally {
  releaseCommit.resolve(audit);
  await runtime?.dispose().catch(() => {});
  await owner.dispose();
}
