import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { InternalUrlRouter, type ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
  formatFullOutputReference,
  formatOutputNotice,
  stripRawOutputArtifactNotice,
  type OutputMeta,
} from "@oh-my-pi/pi-tui/tools/output-meta";

const root = () => join(homedir(), ".cache/omp-ssh-remote/artifacts");
const NAMESPACE_NAME = /^[a-f0-9-]{36}$/;
/** Mirrors the native artifact:// gate: path consumers locate, only materialization reads bytes. */
const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

async function resolveArtifactPath(namespace: string, id: string): Promise<string> {
  const path = await new ArtifactManager(join(root(), namespace)).getPath(id);
  if (!path) throw new Error(`Remote artifact not found: remote-artifact://${namespace}/${id}`);
  return path;
}

const ARTIFACT_URL = /^remote-artifact:\/\/([a-f0-9-]{36})(?:\/(\d+))?\/?$/;

function parseArtifactUrl(href: string): { namespace: string; id?: string } {
  const match = ARTIFACT_URL.exec(href);
  if (!match) throw new Error(`Invalid remote artifact URL: ${href}; expected remote-artifact://<namespace>/<id>`);
  return { namespace: match[1]!, id: match[2] };
}

/**
 * The embedded shell resolves operands through this read-only filesystem mount, never shell source.
 * A namespace is a virtual directory, not its physical one: ids map to `<id>.<suffix>` files,
 * and no-follow metadata (`ls -l`) walks the parent before locating the leaf.
 */
const remoteArtifactHandler: ProtocolHandler = {
  scheme: "remote-artifact",
  spec: { backing: "file", selectors: "lines", immutable: true, artifactStore: true },
  async locate(url) {
    const { namespace, id } = parseArtifactUrl(url.href);
    return id === undefined ? null : resolveArtifactPath(namespace, id);
  },
  async resolve(url) {
    const { namespace, id } = parseArtifactUrl(url.href);
    if (id === undefined) {
      if (!(await stat(join(root(), namespace)).then(entry => entry.isDirectory(), () => false))) {
        throw new Error(`Remote artifact namespace not found: ${url.href}`);
      }
      return { url: url.href, content: "", contentType: "text/plain", isDirectory: true };
    }
    const path = await resolveArtifactPath(namespace, id);
    const { size } = await stat(path);
    if (size > MAX_INLINE_ARTIFACT_BYTES) {
      throw new Error(`Remote artifact is ${size} bytes; full internal resolution is blocked. Use read selectors such as ${url.href}:1-3000`);
    }
    const content = await readFile(path, "utf8");
    return { url: url.href, content, contentType: "text/plain", sourcePath: path, size };
  },
};

/**
 * Mount remote-artifact:// in this process's embedded shell. Only the worker
 * calls this: the scheme names files on the remote host, so a host process
 * (which also builds a runtime for metadata fallback) must never resolve it.
 */
export function mountRemoteArtifactScheme(): void {
  const router = InternalUrlRouter.instance();
  const existing = router.getHandler(remoteArtifactHandler.scheme);
  if (existing && existing !== remoteArtifactHandler) throw new Error("The remote-artifact URL scheme is already registered");
  if (!existing) router.register(remoteArtifactHandler);
}
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

/** Locate one exact operand; tool data and URI selectors never enter this helper. */
export async function resolveRemoteArtifacts(uri: string): Promise<string> {
  const { namespace, id } = parseArtifactUrl(uri);
  if (id === undefined) throw new Error(`Remote artifact requires an id: ${uri}`);
  return resolveArtifactPath(namespace, id);
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
    // Only typed OutputMeta artifact slots own ids. Rich values and arbitrary
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
      if (meta.minimized && nativeId(meta.minimized.artifactId)) {
        const id = meta.minimized.artifactId;
        meta.minimized = { ...meta.minimized, artifactId: remote(id) };
        if (!recoveries.has(remote(id))) recoveries.set(remote(id), reference(id));
      }
      return meta;
    };
    const originalDetails = record(result.details);
    const details = originalDetails ? { ...originalDetails } : undefined;
    // Remote filenames must never enter the TUI's local-file media fast path.
    if (details) delete details.mediaPath;
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
