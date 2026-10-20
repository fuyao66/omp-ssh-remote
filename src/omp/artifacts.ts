import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import {
  formatFullOutputReference,
  formatOutputNotice,
  stripRawOutputArtifactNotice,
  type OutputMeta,
} from "@oh-my-pi/pi-tui/tools/output-meta";

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
  publish: (value: unknown, toolName?: string) => unknown;
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
  const publish = (value: unknown, toolName?: string): unknown => {
    const record = (item: unknown): Record<string, unknown> | undefined =>
      item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const result = record(value);
    if (!result || !Array.isArray(result.content)) return value;
    const remote = (id: string): string => `remote-artifact://${namespace}/${id}`;
    const nativeId = (id: unknown): id is string => typeof id === "string" && /^\d+$/.test(id);
    const mapUri = (uri: string): string => {
      const match = /^artifact:\/\/(\d+)$/.exec(uri);
      return match ? remote(match[1]!) : uri;
    };
    const recoveries = new Map<string, string>();
    const sampledIds = new Set<string>();
    const reference = (id: string, elided?: number, source?: OutputMeta["source"]): string => {
      if (source?.type === "report" && !(elided && elided > 0)) {
        return `Read ${remote(id)} for full report (${source.value})`;
      }
      const text = formatFullOutputReference(id, elided).replace(`artifact://${id}`, remote(id));
      return source?.type === "report" ? `${text} (report: ${source.value})` : text;
    };
    // Only these two OutputMeta slots own artifact ids. Rich values and arbitrary
    // application records (including their own `meta`) never enter this adapter.
    const adaptMeta = (value: unknown): OutputMeta | undefined => {
      if (!record(value)) return undefined;
      const meta = { ...value as OutputMeta };
      if (meta.source && ["path", "url", "internal", "report"].includes(meta.source.type)) {
        meta.source = { ...meta.source, value: mapUri(meta.source.value) };
      }
      if (meta.truncation && nativeId(meta.truncation.artifactId)) {
        const { artifactId, ...truncation } = meta.truncation;
        if ((truncation.artifactElidedBytes ?? 0) > 0) sampledIds.add(artifactId);
        recoveries.set(remote(artifactId), reference(artifactId, truncation.artifactElidedBytes, meta.source));
        meta.truncation = truncation;
      }
      if (meta.limits?.columnTruncated) {
        const column = { ...meta.limits.columnTruncated };
        const id = column.artifactId;
        const nativeSampleSelector = nativeId(id) && column.selectorBase === `artifact://${id}`;
        if (typeof column.selectorBase === "string") column.selectorBase = mapUri(column.selectorBase);
        if (nativeId(id)) {
          const uri = remote(id);
          const sampled = (column.artifactElidedBytes ?? 0) > 0;
          if (sampled) sampledIds.add(id);
          if (sampled && nativeSampleSelector) {
            // The capped artifact renumbers lines; it cannot address original lines.
            delete column.selectorBase;
          } else if (!sampled && column.selectorBase === undefined) {
            column.selectorBase = uri;
          }
          let recovery = reference(id, column.artifactElidedBytes);
          if (!sampled && column.lines && column.selectorBase === uri) {
            // Reuse native wording for the canonical raw-line recovery hint.
            recovery = formatOutputNotice({ limits: { columnTruncated: column } });
          }
          if (!recoveries.has(uri)) recoveries.set(uri, recovery);
          delete column.artifactId;
        }
        meta.limits = { ...meta.limits, columnTruncated: column };
      }
      return meta;
    };
    const originalDetails = record(result.details);
    const details = originalDetails ? { ...originalDetails } : undefined;
    const originalMeta = record(originalDetails?.meta) ? originalDetails!.meta as OutputMeta : undefined;
    const meta = adaptMeta(originalMeta);
    if (details && meta) details.meta = meta;
    if (toolName === "edit" && details && Array.isArray(details.perFileResults)) {
      details.perFileResults = details.perFileResults.map(item => {
        const file = record(item);
        // Edit's typed per-file result has path and diff; this is not a generic meta walk.
        if (!file || typeof file.path !== "string" || typeof file.diff !== "string") return item;
        const fileMeta = adaptMeta(file.meta);
        return fileMeta ? { ...file, meta: fileMeta } : item;
      });
    }
    const content = [...result.content];
    let lastText = -1;
    for (let index = content.length - 1; index >= 0; index--) {
      const block = record(content[index]);
      if (block?.type === "text" && typeof block.text === "string") {
        lastText = index;
        break;
      }
    }
    const published = new Set<string>();
    if (lastText >= 0) {
      const block = record(content[lastText])!;
      const text = block.text as string;
      const originalNotice = formatOutputNotice(originalMeta);
      const hasNotice = originalNotice.length > 0 && text.endsWith(originalNotice);
      let body = hasNotice ? text.slice(0, -originalNotice.length) : text;
      if (toolName === "bash") {
        const { artifactId } = stripRawOutputArtifactNotice(body);
        if (artifactId !== undefined) {
          const footer = `[raw output: artifact://${artifactId}]`;
          const end = body.trimEnd().length;
          // The native helper identifies the footer. Replace that exact suffix,
          // not its trimmed body, so every other whitespace byte survives.
          body = body.slice(0, end - footer.length) + `[raw output: ${remote(artifactId)}]` + body.slice(end);
          if (!sampledIds.has(artifactId)) published.add(remote(artifactId));
        }
      }
      const notice = hasNotice ? formatOutputNotice(meta) : "";
      const column = meta?.limits?.columnTruncated;
      if (hasNotice && column?.lines && column.selectorBase !== undefined) published.add(column.selectorBase);
      content[lastText] = { ...block, text: body + notice };
    }
    const pending = [...recoveries].filter(([uri]) => !published.has(uri)).map(([, text]) => text);
    if (pending.length > 0) content.push({ type: "text", text: pending.join("\n") });
    return { ...result, ...(details ? { details } : {}), content };
  };
  const dispose = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  return { namespace, manager, publish, dispose };
}
