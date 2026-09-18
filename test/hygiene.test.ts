import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_LEGACY_SWEEP_AGE_MS,
  ARTIFACT_OWNER_FILE,
  ARTIFACT_SWEEP_MIN_AGE_MS,
  createRemoteArtifacts,
  sweepOrphanedArtifactNamespaces,
} from "../src/omp/artifacts.ts";
import { buildPruneStaleWorkersCommand } from "../src/deploy.ts";

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

describe("remote worker cache prune command", () => {
  test("keeps the active hash plus the newest other version and ignores foreign entries", async () => {
    const base = await mkdtemp(join(tmpdir(), "worker-prune-"));
    const ns = join(base, "omp-1");
    const hash = (c: string) => c.repeat(64);
    let t = 1;
    for (const c of ["a", "b", "c", "d"]) {
      const dir = join(ns, hash(c));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "worker-linux-x64"), "bin");
      const when = new Date(1000 * t++);
      await utimes(dir, when, when);
    }
    await mkdir(join(ns, "17.3.3"), { recursive: true });
    await mkdir(join(ns, "not-a-hash"), { recursive: true });

    const result = Bun.spawnSync(["sh", "-c", buildPruneStaleWorkersCommand(ns, hash("c"))]);
    expect(result.exitCode).toBe(0);
    expect((await readdir(ns)).sort()).toEqual([hash("c"), hash("d"), "17.3.3", "not-a-hash"].sort());

    const missing = Bun.spawnSync(["sh", "-c", buildPruneStaleWorkersCommand(join(base, "absent"), hash("c"))]);
    expect(missing.exitCode).toBe(0);
  });

  test("rejects an unvalidated hash before it reaches a shell", () => {
    expect(() => buildPruneStaleWorkersCommand("/x", "abc; rm -rf /")).toThrow("Invalid worker hash");
  });
});
