import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "bun:test";
import type { RemoteRuntimeClientApi } from "../../src/client.ts";
import type { PreparedRemoteWorker, RemoteWorkerCacheAudit, RemoteWorkerPreparation } from "../../src/deploy.ts";
import type { ThreadRuntime as ThreadRuntimeFacade, ThreadRuntimeConnection } from "../../src/thread-runtime.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../../src/omp/runtime-contract.ts";

const root = process.env.TEST_THREAD_SOCKET_ROOT;
if (!root) throw new Error("Missing isolated thread socket fixture directory");
const firstController = new AbortController();
const secondController = new AbortController();
const firstDisposeEntered = Promise.withResolvers<void>();
const releaseFirstDispose = Promise.withResolvers<void>();
const audit: RemoteWorkerCacheAudit = {
  observedAt: "fixture-observation", available: false, warning: "isolated lease identity fixture",
};
// Both leases deliberately identify the exact same artifact tuple. Even a full
// worker/LSP path comparison cannot select the initialization cancellation owner.
const artifacts = {
  workerPath: "/fixture/shared-worker",
  pythonLspPack: "/fixture/packs/python",
  typescriptLspPack: "/fixture/packs/typescript",
  cppLspPack: "/fixture/packs/cpp",
};
const firstPrepared: PreparedRemoteWorker = {
  ...artifacts, home: "/fixture/home", signal: firstController.signal, cacheAudit: audit,
  async commitUsage() { return audit; },
  dispose() { firstDisposeEntered.resolve(); return releaseFirstDispose.promise; },
};
let secondDisposed = false;
const secondPrepared: PreparedRemoteWorker = {
  ...artifacts, home: "/fixture/home", signal: secondController.signal, cacheAudit: audit,
  async commitUsage() { return audit; },
  async dispose() { secondDisposed = true; },
};
let preparationCalls = 0;
// Replace only preparation delivery, in this subprocess. Clients still launch
// the existing fake SSH companion through the real owner and native socket RPC.
mock.module(new URL("../../src/deploy.ts", import.meta.url).pathname, () => ({
  startRemoteWorkerPreparation(): RemoteWorkerPreparation {
    const prepared = [firstPrepared, secondPrepared][preparationCalls++];
    assert.ok(prepared, "fixture permits exactly two preparations");
    return { ready: Promise.resolve(prepared), settled: Promise.resolve() };
  },
}));
// Intentional module-loading boundary: install the isolated preparation mock
// before the runtime's static deployment import is evaluated.
const { ThreadRuntime, ThreadRuntimeOwner } = await import("../../src/thread-runtime.ts");
const authoritative: ThreadRuntimeConnection = {
  target: "lease-fixture.invalid", workerPath: "/fixture/authoritative-worker", cwd: "/fixture/workspace",
};
let ownerDisposed = 0;
const owner = await ThreadRuntimeOwner.create(() => authoritative, () => {}, () => { ownerDisposed++; });
let runtime: ThreadRuntimeFacade | undefined;
let client: RemoteRuntimeClientApi | undefined;
let firstDisposal: Promise<void> | undefined;

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  // Failure deadline only: fake time cannot drive real socket replies or child exit.
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), 8_000);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

async function currentIdentity(pid: number): Promise<{ start: string; parent: number; state: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    return { start: fields[19]!, parent: Number(fields[1]), state: fields[0]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

try {
  runtime = await ThreadRuntime.connect(owner.address);
  const first = await runtime.prepare();
  const firstAborted = Promise.withResolvers<void>();
  first.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
  firstController.abort(new Error("first preparation lease revoked"));
  await deadline(firstAborted.promise, "first lease abort mirrored to facade");
  assert.equal(first.signal.aborted, true);
  let firstDisposalSettled = false;
  firstDisposal = first.dispose().then(() => { firstDisposalSettled = true; });
  void firstDisposal.catch(() => {});
  await deadline(firstDisposeEntered.promise, "first lease disposal entry");

  const second = await runtime.prepare();
  assert.equal(second.signal.aborted, false);
  assert.equal(second.workerPath, first.workerPath);
  assert.equal(second.pythonLspPack, first.pythonLspPack);
  assert.equal(second.typescriptLspPack, first.typescriptLspPack);
  assert.equal(second.cppLspPack, first.cppLspPack);
  assert.equal(firstDisposalSettled, false);
  client = await runtime.createClient({ ...authoritative,
    workerPath: second.workerPath, pythonLspPack: second.pythonLspPack,
    typescriptLspPack: second.typescriptLspPack, cppLspPack: second.cppLspPack,
  });
  client.activateEvents?.();
  const ready = await deadline(client.initialize(authoritative.cwd, OMP_RUNTIME_HANDSHAKE, undefined,
    { signal: second.signal }), "healthy lease initialization despite matching revoked artifact paths");
  assert.equal(ready.cwd, authoritative.cwd);
  const identity = await deadline(client.execute("read", "healthy-second-lease", { waitForAck: true }), "healthy lease execute") as {
    pid: number; start: string; parent: number; acknowledged: boolean;
  };
  const live = await currentIdentity(identity.pid);
  assert.equal(live?.start, identity.start);
  assert.equal(live?.parent, process.pid);
  assert.notEqual(live?.state, "Z");
  assert.equal(identity.acknowledged, true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(firstDisposalSettled, false, "the stale lease must remain registered until its disposer settles");

  await deadline(client.close(), "healthy lease client close");
  assert.equal(await deadline(client.waitForExit(), "healthy lease companion exit"), 0);
  assert.notEqual((await currentIdentity(identity.pid))?.start, identity.start, "cleanup must reap the exact companion identity");
  assert.equal(await readFile(join(root, `shutdown-${identity.pid}-${identity.start}`), "utf8"), "shutdown received");
  assert.equal(firstDisposalSettled, false, "client exit must not implicitly release the unrelated stale lease");
  releaseFirstDispose.resolve();
  await deadline(firstDisposal, "explicit stale lease disposal release");
  assert.equal(firstDisposalSettled, true);
  await second.dispose();
  assert.equal(secondDisposed, true);
  await runtime.dispose();
  await owner.dispose();
  assert.equal(ownerDisposed, 1);
  assert.equal(preparationCalls, 2);
  process.stdout.write(`${JSON.stringify({ disposed: ownerDisposed, preparationCalls, firstAborted: true,
    secondHealthy: true, firstDisposalHeld: true, executed: true, identity })}\n`);
} finally {
  releaseFirstDispose.resolve();
  await firstDisposal?.catch(() => {});
  await runtime?.dispose().catch(() => {});
  await owner.dispose();
}
