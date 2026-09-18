import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";

const root = () => join(homedir(), ".cache/omp-ssh-remote/artifacts");
const references = /remote-artifact:\/\/([a-f0-9-]{36})\/(\d+)/g;
const NAMESPACE_NAME = /^[a-f0-9-]{36}$/;
/** Records which process owns a namespace so a later sweep can prove it is gone. */
export const ARTIFACT_OWNER_FILE = ".owner.json";
/** Namespaces younger than this are never swept, even without an owner record. */
export const ARTIFACT_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;
/** Namespaces without an owner record (created by pre-ownership workers) are swept after this age. */
export const ARTIFACT_LEGACY_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export type ArtifactOwner = { pid: number; bootId: string };

async function currentBootId(): Promise<string | undefined> {
  try {
    const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await stat(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

export type ArtifactSweepOptions = {
  base?: string;
  now?: number;
  /** Boot id of this host; `undefined` disables the sweep (no liveness oracle). */
  bootId?: string;
  isAlive?: (owner: ArtifactOwner) => Promise<boolean>;
};

/**
 * Remove artifact namespaces whose owning process is provably gone. Liveness is
 * decided by the recorded owner (`pid` + `boot_id`): a different boot or an
 * absent `/proc/<pid>` means the worker that created the namespace cannot still
 * be writing to it. Namespaces without an owner record predate ownership
 * tracking and are only swept once they are clearly stale. The minimum-age
 * floor protects a namespace whose owner record is still being written.
 */
export async function sweepOrphanedArtifactNamespaces(
  options: ArtifactSweepOptions = {},
): Promise<string[]> {
  const base = options.base ?? root();
  const now = options.now ?? Date.now();
  const bootId = "bootId" in options ? options.bootId : await currentBootId();
  if (!bootId) return [];
  const isAlive =
    options.isAlive ??
    (async (owner: ArtifactOwner) => owner.bootId === bootId && (await processExists(owner.pid)));
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!NAMESPACE_NAME.test(name)) continue;
    const dir = join(base, name);
    let mtime: number;
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      mtime = info.mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime < ARTIFACT_SWEEP_MIN_AGE_MS) continue;
    let owner: ArtifactOwner | undefined;
    try {
      const parsed = JSON.parse(await readFile(join(dir, ARTIFACT_OWNER_FILE), "utf8")) as Partial<ArtifactOwner>;
      if (typeof parsed.pid === "number" && typeof parsed.bootId === "string") {
        owner = { pid: parsed.pid, bootId: parsed.bootId };
      }
    } catch {}
    const orphan = owner
      ? !(await isAlive(owner))
      : now - mtime >= ARTIFACT_LEGACY_SWEEP_AGE_MS;
    if (!orphan) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
}

export async function resolveRemoteArtifacts(value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    let result = value;
    for (const match of value.matchAll(references)) {
      const dir = join(root(), match[1]!);
      const name = (await readdir(dir)).find((name) => name.startsWith(`${match[2]}.`));
      if (!name) throw new Error(`Remote artifact not found: ${match[0]}`);
      result = result.replaceAll(match[0], join(dir, name));
    }
    return result;
  }
  if (Array.isArray(value)) return Promise.all(value.map(resolveRemoteArtifacts));
  if (value && typeof value === "object") {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveRemoteArtifacts(item)])));
  }
  return value;
}

export type RemoteArtifacts = {
  namespace: string;
  manager: ArtifactManager;
  publish: (value: unknown) => unknown;
  /** Remove this namespace; call once the owning runtime is shutting down. */
  dispose: () => Promise<void>;
};

export async function createRemoteArtifacts(
  options: { sweep?: boolean } = {},
): Promise<RemoteArtifacts> {
  if (options.sweep !== false) {
    await sweepOrphanedArtifactNamespaces().catch(() => undefined);
  }
  const namespace = crypto.randomUUID();
  const dir = join(root(), namespace);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const bootId = await currentBootId();
  if (bootId) {
    const owner: ArtifactOwner & { createdAt: string } = {
      pid: process.pid,
      bootId,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, ARTIFACT_OWNER_FILE), JSON.stringify(owner), { mode: 0o600 });
  }
  const manager = new ArtifactManager(dir);
  const publish = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/artifact:\/\/(\d+)/g, `remote-artifact://${namespace}/$1`);
    if (Array.isArray(value)) return value.map(publish);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const result = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "artifactId").map(([key, item]) => [key, publish(item)]));
      const details = record.details as { meta?: { truncation?: { artifactId?: string } } } | undefined;
      const id = details?.meta?.truncation?.artifactId;
      if (typeof id === "string" && Array.isArray(result.content)) {
        result.content = [...result.content, { type: "text", text: `Full output: remote-artifact://${namespace}/${id}` }];
      }
      return result;
    }
    return value;
  };
  const dispose = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  return { namespace, manager, publish, dispose };
}
