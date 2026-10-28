import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { describeRemoteWorkerCacheAudit, parseRemoteWorkerCacheAudit, SUPPORTED_PLATFORMS } from "../src/deploy.ts";
import { buildCommitWorkerCacheCommand, buildWorkerDeploymentLeaseCommand } from "../src/worker-cache.ts";

const hash = (c: string) => c.repeat(64);
async function build(root: string, c: string, ns = "omp-1") {
  const directory = join(root, ns, hash(c));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "worker-linux-x64"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(directory, "worker-linux-x64.sha256"), hash(c) + "\n");
  return directory;
}
function commit(root: string, c: string, ns = "omp-1", links: string[] = []) {
  const result = spawnSync("sh", ["-c", buildCommitWorkerCacheCommand(root, ns, hash(c), links)], { encoding: "utf8", timeout: 10000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return parseRemoteWorkerCacheAudit(result.stdout.trim());
}
type HeldLease = { dispose(): Promise<void> };
async function holder(root: string, c: string, ns = "omp-1"): Promise<HeldLease> {
  const process = Bun.spawn(["sh", "-c", buildWorkerDeploymentLeaseCommand(root, ns, hash(c))], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("READY\n");
  return { async dispose() { process.stdin.end(); await process.exited; reader.releaseLock(); } };
}

describe("managed native worker cache", () => {
  test("maps only supported native platforms", () => {
    expect(SUPPORTED_PLATFORMS["Linux/aarch64"]).toBe("arm64");
    expect(SUPPORTED_PLATFORMS["Linux/x86_64"]).toBe("x64");
    expect(SUPPORTED_PLATFORMS["Darwin/arm64"]).toBeUndefined();
  });

  test("A→B→C, repeat, rollback and namespace transitions retain two distinct used hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker policy ' spaces "));
    try {
      await build(root, "a"); commit(root, "a");
      await build(root, "b"); commit(root, "b");
      const before = await readFile(join(root, "omp-1", hash("b"), ".native-worker-v1"), "utf8");
      const repeated = commit(root, "b");
      expect(repeated).toMatchObject({ retained: { builds: 2, replicas: 2 }, deleted: { replicas: 0 } });
      expect(await readFile(join(root, "omp-1", hash("b"), ".native-worker-v1"), "utf8")).not.toBe(before);
      await build(root, "c", "future-contract");
      const advanced = commit(root, "c", "future-contract");
      expect(advanced).toMatchObject({ retained: { builds: 2 }, deleted: { builds: 1, replicas: 1 } });
      expect((await readdir(join(root, "omp-1"))).sort()).toEqual([hash("b")]);
      await build(root, "a"); commit(root, "a");
      expect((await readdir(join(root, "omp-1"))).sort()).toEqual([hash("a")]);
      const rolled = commit(root, "c", "future-contract");
      expect(rolled).toMatchObject({ retained: { builds: 2 }, deleted: { replicas: 0 } });
      expect(describeRemoteWorkerCacheAudit(rolled)).toContain("not total cache usage");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("busy generations exceed two until released; preparation protects a previously used build", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-busy-"));
    let lease: HeldLease | undefined;
    try {
      await build(root, "a"); commit(root, "a"); lease = await holder(root, "a");
      await build(root, "b"); commit(root, "b");
      await build(root, "c");
      expect(commit(root, "c")).toMatchObject({ retained: { builds: 3, replicas: 3 }, busy: { builds: 1, replicas: 1 } });
      await lease.dispose(); lease = undefined;
      expect(commit(root, "c")).toMatchObject({ retained: { builds: 2 }, deleted: { replicas: 1 }, busy: { replicas: 0 } });
    } finally { await lease?.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  test("deduplicates aliases by hash without removing busy replicas", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-alias-"));
    let lease: HeldLease | undefined;
    try {
      await build(root, "a"); commit(root, "a"); lease = await holder(root, "a");
      await build(root, "a", "future");
      expect(commit(root, "a", "future")).toMatchObject({ retained: { builds: 1, replicas: 2 }, busy: { replicas: 1 } });
      await lease.dispose(); lease = undefined;
      expect(commit(root, "a", "future")).toMatchObject({ retained: { builds: 1, replicas: 1 }, deleted: { replicas: 1 } });
    } finally { await lease?.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  test("imports frozen native layout once and never infers ownership from historical namespace names", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-import-"));
    try {
      const a = await build(root, "a"); const b = await build(root, "b");
      await utimes(a, new Date(1000), new Date(1000)); await utimes(b, new Date(2000), new Date(2000));
      await build(root, "d", "17.3.3"); await build(root, "e", "pi"); await build(root, "f", "omp-unknown");
      commit(root, "b");
      expect(await readFile(join(a, ".native-worker-v1"), "utf8")).toContain("imported-mtime");
      await build(root, "c");
      const audit = commit(root, "c");
      expect(audit).toMatchObject({ unclassified: 3, deleted: { replicas: 1 } });
      for (const ns of ["17.3.3", "pi", "omp-unknown"]) expect((await readdir(join(root, ns))).length).toBe(1);
      await build(root, "d"); commit(root, "c");
      expect(await readdir(join(root, "omp-1", hash("d")))).not.toContain(".native-worker-v1");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("unknown children, corrupt manifests and symlink namespaces are non-deletable; shared links stay shared", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-unknown-"));
    try {
      const a = await build(root, "a"); commit(root, "a");
      await writeFile(join(a, "user-data"), "keep");
      const b = await build(root, "b"); commit(root, "b");
      await writeFile(join(b, ".native-worker-v1"), "invalid\n");
      const c = await build(root, "c");
      await writeFile(join(root, "shared"), "shared asset"); await symlink(join(root, "shared"), join(c, "companion"));
      commit(root, "c", "omp-1", ["companion"]);
      await build(root, "d"); commit(root, "d");
      await build(root, "e"); const audit = commit(root, "e");
      expect(audit).toMatchObject({ unclassified: 2 });
      expect(await readFile(join(a, "user-data"), "utf8")).toBe("keep");
      expect(await readFile(join(root, "shared"), "utf8")).toBe("shared asset");
      expect(await readdir(join(root, "omp-1"))).not.toContain(hash("c"));
      await symlink(join(root, "omp-1"), join(root, "alias"));
      commit(root, "e");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("missing directories and state recovery preserve surviving use order", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-missing-"));
    try {
      const a = await build(root, "a"); commit(root, "a"); await rm(a, { recursive: true });
      await build(root, "b"); commit(root, "b"); await rm(join(root, ".native-cache-state"));
      await build(root, "c"); expect(commit(root, "c")).toMatchObject({ retained: { builds: 2 } });
      await writeFile(join(root, ".native-cache-state"), "corrupt\n");
      const failed = spawnSync("sh", ["-c", buildCommitWorkerCacheCommand(root, "omp-1", hash("c"))]);
      expect(failed.status).not.toBe(0);
      expect((await readdir(join(root, "omp-1"))).sort()).toEqual([hash("b"), hash("c")]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each(["", "managed\t0", "managed\t1\t0\t0\t0\t0\t0\t0\t0\t0\t0", "managed\t0\t0\t0\tNaN\t0\t0\t0\t0\t0\t0"])("rejects invalid audit %s", output => {
    expect(() => parseRemoteWorkerCacheAudit(output)).toThrow();
  });
  test("rejects unsafe metadata identities", () => {
    expect(() => buildCommitWorkerCacheCommand("/x", "../elsewhere", hash("a"))).toThrow();
    expect(() => buildWorkerDeploymentLeaseCommand("/x", "omp-1", "abc; rm -rf /")).toThrow();
  });
});

// Real shell-backed fake SSH: exercises production lease cancellation and admission boundary,
// including shell-quoted homes, without contacting a server.
describe("deployment transaction transport", () => {
  test("failed admission has no usage; successful commit and cancellation release lease channels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worker-transport-"));
    try {
      const home = join(directory, "home ' spaces; literal");
      await mkdir(home);
      await writeFile(join(directory, "worker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(join(directory, "ssh"), `#!${process.execPath}
import { spawn } from 'node:child_process';
const script = process.argv.at(-1);
if (script.includes('uname -s')) console.log('Linux\\nx86_64\\n' + ${JSON.stringify(home)});
else { const child = spawn('sh', ['-c', script], { stdio: 'inherit' }); child.on('exit', code => process.exit(code ?? 1)); }
`, { mode: 0o700 });
      await writeFile(join(directory, "scp"), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv; const source = args.at(-2); const dest = args.at(-1).split(':').slice(1).join(':');
const result = spawnSync('sh', ['-c', 'cp -- "$1" ' + dest, 'sh', source], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.env.HOLD_UPLOAD) { await writeFile(process.env.UPLOAD_READY, 'ready'); await readFile(process.env.UPLOAD_GATE); }
process.exit(0);
`, { mode: 0o700 });
      const raceChild = join(directory, "race-child.ts");
      await writeFile(raceChild, `
import { prepareRemoteWorker } from ${JSON.stringify(new URL("../src/deploy.ts", import.meta.url).href)};
const controller = new AbortController(); process.stdin.on('data', () => controller.abort());
try { const prepared = await prepareRemoteWorker({ target: 'fixture.example', localWorkerPath: process.env.RACE_WORKER, signal: controller.signal }); await prepared.dispose(); throw new Error('held upload unexpectedly finished'); }
catch (error) { if (!controller.signal.aborted) throw error; }
process.stdin.pause();
`);
      const runner = join(directory, "runner.ts");
      await writeFile(runner, `
import { prepareRemoteWorker } from ${JSON.stringify(new URL("../src/deploy.ts", import.meta.url).href)};
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const options = { target: 'fixture.example', localWorkerPath: ${JSON.stringify(join(directory, "worker"))} };
const first = await prepareRemoteWorker(options);
try { await access(first.workerPath.replace(/worker-linux-x64$/, '.native-worker-v1')); throw new Error('premature usage'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await first.dispose(); // models failed native admission
const second = await prepareRemoteWorker(options);
const audit = await second.commitUsage(); if (!audit.available || audit.retained.builds !== 1) throw new Error(JSON.stringify(audit));
await second.dispose();
const [parallelA, parallelB] = await Promise.all([prepareRemoteWorker(options), prepareRemoteWorker(options)]);
try {
  const both = await Promise.all([parallelA.commitUsage(), parallelB.commitUsage()]);
  if (both.some(audit => !audit.available || audit.retained.builds !== 1)) throw new Error('concurrent same-build admission failed');
} finally { await parallelA.dispose(); await parallelB.dispose(); }
if (second.signal.aborted) throw new Error('normal disposal must not abort admitted worker');
const controller = new AbortController(); const third = await prepareRemoteWorker({ ...options, signal: controller.signal });
const before = await readFile(${JSON.stringify(join(home, ".cache/omp-ssh-remote/.native-cache-state"))}, 'utf8');
controller.abort(); await third.dispose();
if (!third.signal.aborted) throw new Error('missing cancellation');
const preCancelled = new AbortController(); preCancelled.abort();
try { await prepareRemoteWorker({ ...options, signal: preCancelled.signal }); throw new Error('pre-cancelled deployment succeeded'); } catch (error) { if (String(error).includes('pre-cancelled deployment succeeded')) throw error; }
if (before !== await readFile(${JSON.stringify(join(home, ".cache/omp-ssh-remote/.native-cache-state"))}, 'utf8')) throw new Error('cancelled preparation marked used');
const badWorker = ${JSON.stringify(join(directory, "bad-worker"))};
await writeFile(badWorker, 'bad upload fixture'); await writeFile(badWorker + '.sha256', 'f'.repeat(64));
try { await prepareRemoteWorker({ ...options, localWorkerPath: badWorker }); throw new Error('bad upload succeeded'); } catch (error) { if (!String(error).includes('Worker activation failed')) throw error; }
if (before !== await readFile(${JSON.stringify(join(home, ".cache/omp-ssh-remote/.native-cache-state"))}, 'utf8')) throw new Error('failed upload marked used');
const raceWorker = ${JSON.stringify(join(directory, "race-worker"))}; await writeFile(raceWorker, '#!/bin/sh\\n# independent concurrent build\\nexit 0\\n');
const uploadReady = ${JSON.stringify(join(directory, "upload-ready"))}; const uploadGate = ${JSON.stringify(join(directory, "upload-gate"))};
if (spawnSync('mkfifo', [uploadReady, uploadGate]).status !== 0) throw new Error('mkfifo failed');
const child = Bun.spawn([process.execPath, 'run', ${JSON.stringify(raceChild)}], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOLD_UPLOAD: '1', UPLOAD_READY: uploadReady, UPLOAD_GATE: uploadGate, RACE_WORKER: raceWorker } });
try {
  if (await readFile(uploadReady, 'utf8') !== 'ready') throw new Error('missing upload barrier');
  const admitted = await prepareRemoteWorker({ ...options, localWorkerPath: raceWorker });
  try {
    const result = await admitted.commitUsage();
    if (!result.available || result.retained.builds !== 2) throw new Error('in-flight independent upload invalidated admission: ' + JSON.stringify(result));
    await access(admitted.workerPath.replace(/worker-linux-x64$/, '.native-worker-v1'));
  } finally { await admitted.dispose(); }
  child.stdin.write('cancel\\n'); child.stdin.end();
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  const reused = await prepareRemoteWorker({ ...options, localWorkerPath: raceWorker });
  try { if (!(await reused.commitUsage()).available) throw new Error('cancelled competing upload lost managed ownership'); } finally { await reused.dispose(); }
} finally { child.kill(); await child.exited; }
`);
      const result = spawnSync(process.execPath, ["run", runner], { encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
