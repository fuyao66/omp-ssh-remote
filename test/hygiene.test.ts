import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_LEGACY_SWEEP_AGE_MS,
  ARTIFACT_OWNER_FILE,
  ARTIFACT_SWEEP_MIN_AGE_MS,
  createRemoteArtifacts,
  sweepOrphanedArtifactNamespaces,
} from "../src/omp/artifacts.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

const HOUR = 60 * 60 * 1000;

async function namespace(
  base: string,
  name: string,
  ageMs: number,
  owner?: { pid: number; bootId: string },
): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "0.bash.log"), "output");
  if (owner) await writeFile(join(dir, ARTIFACT_OWNER_FILE), JSON.stringify(owner));
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
}

const uuid = (seed: string) => `${seed.repeat(8)}-${seed.repeat(4)}-${seed.repeat(4)}-${seed.repeat(4)}-${seed.repeat(12)}`;

describe("remote artifact namespace hygiene", () => {
  test("worker namespace records its owner and dispose removes it", async () => {
    const artifacts = await createRemoteArtifacts({ sweep: false });
    const dir = artifacts.manager.dir;
    const owner = JSON.parse(await readFile(join(dir, ARTIFACT_OWNER_FILE), "utf8")) as {
      pid: number;
      bootId: string;
    };
    expect(owner.pid).toBe(process.pid);
    expect(typeof owner.bootId).toBe("string");
    await artifacts.dispose();
    await expect(stat(dir)).rejects.toThrow();
    await artifacts.dispose(); // idempotent
  });

  test("sweeps only namespaces whose owner is provably gone", async () => {
    const base = await mkdtemp(join(tmpdir(), "artifact-sweep-"));
    const bootId = "boot-current";
    await namespace(base, uuid("a"), 2 * HOUR, { pid: 1, bootId }); // alive
    await namespace(base, uuid("b"), 2 * HOUR, { pid: 2, bootId }); // dead pid
    await namespace(base, uuid("c"), 2 * HOUR, { pid: 1, bootId: "boot-previous" }); // previous boot
    await namespace(base, uuid("d"), 10 * 60 * 1000, { pid: 2, bootId }); // dead but too young
    await namespace(base, uuid("e"), 2 * HOUR); // legacy, no owner, under 24h
    await namespace(base, uuid("f"), ARTIFACT_LEGACY_SWEEP_AGE_MS + HOUR); // legacy, stale
    await mkdir(join(base, "not-a-namespace"), { recursive: true });
    await writeFile(join(base, "stray-file"), "x");

    const removed = await sweepOrphanedArtifactNamespaces({
      base,
      bootId,
      isAlive: async (owner) => owner.bootId === bootId && owner.pid === 1,
    });
    expect(removed.sort()).toEqual([uuid("b"), uuid("c"), uuid("f")].sort());
    expect((await readdir(base)).sort()).toEqual(
      [uuid("a"), uuid("d"), uuid("e"), "not-a-namespace", "stray-file"].sort(),
    );
  });

  test("sweep is disabled without a boot id and tolerates a missing base", async () => {
    const base = await mkdtemp(join(tmpdir(), "artifact-sweep-"));
    await namespace(base, uuid("b"), ARTIFACT_SWEEP_MIN_AGE_MS * 3, { pid: 2, bootId: "x" });
    expect(await sweepOrphanedArtifactNamespaces({ base, bootId: undefined })).toEqual([]);
    expect(await sweepOrphanedArtifactNamespaces({ base: join(base, "missing"), bootId: "x" })).toEqual([]);
  });
});

describe("native worker launch lease", () => {
  test("holds the shared build lock until worker exit", async () => {
    const ns = await mkdtemp(join(tmpdir(), "worker lease '"));
    const worker = join(ns, "worker path'quoted");
    await writeFile(worker, '#!/bin/sh\necho READY\nread input\nprintf "%s" "$input"\n', { mode: 0o700 });
    const proc = Bun.spawn(["sh", "-c", buildSshWorkerCommand({ target: "example", workerPath: worker }).at(-1)!], { stdin: "pipe", stdout: "pipe" });
    try {
      const reader = proc.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("READY");
      expect(Bun.spawnSync(["flock", "-n", "-x", join(ns, ".worker.lock"), "true"]).exitCode).not.toBe(0);
      proc.stdin.write("still-live\n"); proc.stdin.end();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("still-live");
      await proc.exited;
      expect(Bun.spawnSync(["flock", "-n", "-x", join(ns, ".worker.lock"), "true"]).exitCode).toBe(0);
    } finally { proc.kill(); await proc.exited; await rm(ns, { recursive: true, force: true }); }
  });
});
