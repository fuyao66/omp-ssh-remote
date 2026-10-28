import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_WORKER_BUNDLE } from "./omp/runtime-contract.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  RemoteCompanionArtifact,
  RemoteWorkerBundle,
} from "./runtime-contract.ts";
import {
  buildScpBaseCommand,
  buildSshBaseCommand,
  getSshDestination,
  quoteRemoteArgument,
  type SshConnectionOptions,
} from "./ssh.ts";

export interface WorkerDeploymentOptions extends Omit<
  SshConnectionOptions,
  "workerPath"
> {
  workerPath?: string;
  localWorkerPath?: string;
  localArtifactDir?: string;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  label: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > MAX_COMMAND_OUTPUT_BYTES)
      throw new Error(`${label} exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`);
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, bytes),
  );
}

const deploymentContext = new AsyncLocalStorage<Pick<WorkerDeploymentOptions, "signal" | "onProgress">>();
const deployments = new Map<string, Promise<unknown>>();

async function run(command: string[], description: string, timeoutMs = 120_000): Promise<string> {
  const { signal, onProgress } = deploymentContext.getStore() ?? {};
  signal?.throwIfAborted();
  onProgress?.(description);
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const [file, ...args] = command;
    const proc = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; proc.kill("SIGKILL"); };
    const abort = () => stop(new Error(`${description} cancelled`, { cause: signal?.reason }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) stop(new Error(`${description} output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
      else target.push(chunk);
    };
    proc.stdout?.on("data", collect(chunks));
    proc.stderr?.on("data", collect(errors));
    const timer = setTimeout(() => stop(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
    proc.on("error", (error) => { failure ??= error; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(chunks).toString("utf8").trim();
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (failure) rejectPromise(failure);
      else if (code !== 0) rejectPromise(new Error(`${description} failed (${code}): ${stderr || stdout}`));
      else resolvePromise(stdout);
    });
  });
}
export const SUPPORTED_PLATFORMS: Record<string, "arm64" | "x64"> = {
  "Linux/aarch64": "arm64",
  "Linux/x86_64": "x64",
};
const MODULE_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));

function resolveLocalWorkerPath(
  arch: "arm64" | "x64",
  artifactDir = MODULE_DIR,
): string[] {
  return [join(artifactDir, `worker-linux-${arch}`)];
}

function resolveLocalCompanionPath(
  artifact: RemoteCompanionArtifact,
  arch: "arm64" | "x64",
  artifactDir = MODULE_DIR,
): string {
  return join(artifactDir, `${artifact.filePrefix}-${arch}`);
}

async function resolveLocalCompanionBinary(
  artifact: RemoteCompanionArtifact,
  arch: "arm64" | "x64",
  artifactDir?: string,
): Promise<string> {
  const candidate = resolveLocalCompanionPath(artifact, arch, artifactDir);
  try {
    await access(candidate);
    return candidate;
  } catch {}
  throw new Error(
    `${arch} ${artifact.id} companion artifact not found; checked: ${candidate}`,
  );
}

async function resolveLocalWorker(
  arch: "arm64" | "x64",
  explicitPath?: string,
  artifactDir?: string,
): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : resolveLocalWorkerPath(arch, artifactDir);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  throw new Error(
    `${arch} worker binary not found; checked: ${candidates.join(", ")}`,
  );
}
async function readWorkerHash(workerPath: string): Promise<string> {
  try {
    const sidecar = (await readFile(`${workerPath}.sha256`, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(sidecar)) return sidecar;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const data = await readFile(workerPath);
  return createHash("sha256").update(data).digest("hex");
}
function parseProbe(output: string): { platform: string; home: string } {
  const [os, arch, home, ...extra] = output.split("\n");
  if (extra.length > 0 || !os || !arch || !home || !home.startsWith("/")) {
    throw new Error(
      `Invalid remote platform probe response: ${JSON.stringify(output)}`,
    );
  }
  return { platform: `${os}/${arch}`, home };
}

export type RemoteWorkerCacheUsage = {
  namespace: string;
  versions: number;
  binaryFiles: number;
  allocatedBytes: number;
};

export type RemoteWorkerCacheAudit = {
  observedAt: string;
} & ({
  available: true;
  scope: "worker binaries only; excludes shared assets and other cache contents";
  metric: "sum of per-file allocated bytes (stat blocks × block size), not logical size";
  current: RemoteWorkerCacheUsage;
  retainedOld: Omit<RemoteWorkerCacheUsage, "namespace">;
  legacy: RemoteWorkerCacheUsage[];
} | {
  available: false;
  warning: string;
});

export type PreparedRemoteWorker = {
  workerPath: string;
  home?: string;
  cacheAudit: RemoteWorkerCacheAudit;
};

export async function resolveRemoteHome(
  options: WorkerDeploymentOptions,
): Promise<string> {
  const output = await run(
    [...buildSshBaseCommand(options), getSshDestination(options), `printf '%s\\n' "$HOME"`],
    "Remote home probe",
  );
  if (!output.startsWith("/") || output.includes("\n")) {
    throw new Error(`Invalid remote home response: ${JSON.stringify(output)}`);
  }
  return output;
}

export async function prepareRemoteWorker(
  options: WorkerDeploymentOptions,
  bundle: RemoteWorkerBundle = OMP_WORKER_BUNDLE,
): Promise<PreparedRemoteWorker> {
  const key = JSON.stringify([options.target, options.port, options.identityFile, options.knownHostsFile, bundle.cacheNamespace]);
  const previous = deployments.get(key);
  const result = (async () => {
    if (previous) {
      options.onProgress?.("Waiting for existing deployment to finish");
      await previous.catch(() => {});
    }
    options.signal?.throwIfAborted();
    return deploymentContext.run(options, () => deployRemoteWorker(options, bundle));
  })();
  deployments.set(key, result);
  void result.finally(() => { if (deployments.get(key) === result) deployments.delete(key); }).catch(() => {});
  if (!options.signal) return result;
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(new Error("Remote deployment cancelled", { cause: options.signal?.reason }));
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  try { return await Promise.race([result, cancelled.promise]); }
  finally { options.signal.removeEventListener("abort", abort); }
}

async function deployRemoteWorker(options: WorkerDeploymentOptions, bundle: RemoteWorkerBundle): Promise<PreparedRemoteWorker> {
  const probe = parseProbe(
    await run(
      [
        ...buildSshBaseCommand(options),
        getSshDestination(options),
        "command -v flock >/dev/null && uname -s && uname -m && printf '%s' \"$HOME\"",
      ],
      "Probe remote host platform and home",
    ),
  );
  const arch = SUPPORTED_PLATFORMS[probe.platform];
  if (!arch) {
    throw new Error(
      `Unsupported remote platform ${probe.platform}; supported: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`,
    );
  }
  const localWorker = await resolveLocalWorker(
    arch,
    options.localWorkerPath,
    options.localArtifactDir,
  );
  const hash = await readWorkerHash(localWorker);
  const cacheDir = `${probe.home}/.cache/omp-ssh-remote`;
  const workerFile = `worker-linux-${arch}`;
  const remoteDir = `${cacheDir}/${bundle.cacheNamespace}/${hash}`;
  const remoteWorker = `${remoteDir}/${workerFile}`;
  const marker = `${remoteDir}/${workerFile}.sha256`;
  const quotedWorker = quoteRemoteArgument(remoteWorker);
  const quotedMarker = quoteRemoteArgument(marker);
  const exists = await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `test -x ${quotedWorker} && test "$(cat ${quotedMarker} 2>/dev/null)" = '${hash}' && printf present || printf missing`,
    ],
    "Remote worker check",
  );
  if (exists === "present") {
    await deployCompanionArtifacts(
      options,
      probe.home,
      arch,
      remoteDir,
      bundle,
    );
    const cacheAudit = await pruneAndAuditRemoteWorkers(options, `${cacheDir}/${bundle.cacheNamespace}`, hash);
    return { workerPath: remoteWorker, home: probe.home, cacheAudit };
  }
  if (exists !== "missing")
    throw new Error(`Unexpected remote worker check response: ${exists}`);

  await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `mkdir -p ${quoteRemoteArgument(remoteDir)} && chmod 700 ${quoteRemoteArgument(remoteDir)}`,
    ],
    "Remote cache setup",
  );
  const nonce = crypto.randomUUID();
  const temporary = `${remoteWorker}.upload-${nonce}`;
  const temporaryMarker = `${marker}.upload-${nonce}`;
  const scp = buildScpBaseCommand(options);
  // The worker is a ~200 MB uncompressed Bun executable; ssh-level compression
  // measured ~40% fewer bytes on the wire for the one-time upload per version.
  scp.push("-C", localWorker, `${getSshDestination(options)}:${quoteRemoteArgument(temporary)}`);
  const quotedTemporary = quoteRemoteArgument(temporary);
  const quotedTemporaryMarker = quoteRemoteArgument(temporaryMarker);
  try {
    await run(scp, "Worker upload (compressed SCP; first deployment may take several minutes)", 600_000);
  await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `set -eu; actual=$(sha256sum ${quotedTemporary} | cut -d ' ' -f 1); test "$actual" = '${hash}'; chmod 700 ${quotedTemporary}; mv -f ${quotedTemporary} ${quotedWorker}; printf '%s\\n' '${hash}' > ${quotedTemporaryMarker}; chmod 600 ${quotedTemporaryMarker}; mv -f ${quotedTemporaryMarker} ${quotedMarker}`,
    ],
    "Worker activation",
  );
  } catch (error) {
    await deploymentContext.run({}, () => run([
      ...buildSshBaseCommand(options), getSshDestination(options),
      `rm -f -- ${quotedTemporary} ${quotedTemporaryMarker}`,
    ], "Remove incomplete worker upload", 20000)).catch(() => {});
    throw error;
  }
  await deployCompanionArtifacts(options, probe.home, arch, remoteDir, bundle);
  const cacheAudit = await pruneAndAuditRemoteWorkers(options, `${cacheDir}/${bundle.cacheNamespace}`, hash);
  return { workerPath: remoteWorker, home: probe.home, cacheAudit };
}

/** Versions retained under one contract namespace: the one just activated plus the previous one. */
export const RETAINED_REMOTE_WORKER_VERSIONS = 2;

/**
 * Shell fragment that deletes every sibling version directory under `namespaceDir`
 * except the active hash and the most recently modified `keep - 1` others.
 * A newly activated version is always the newest, so the previous version
 * survives and a rollback of the local plugin does not re-upload 200 MB.
 * A version lease protects worker self-reentry (eval and broker subprocesses).
 * Legacy processes without a lease are also checked via /proc before deletion.
 */
export function buildPruneStaleWorkersCommand(
  namespaceDir: string,
  activeHash: string,
  keep = RETAINED_REMOTE_WORKER_VERSIONS,
): string {
  if (!/^[a-f0-9]{64}$/.test(activeHash)) throw new Error("Invalid worker hash");
  const dir = quoteRemoteArgument(namespaceDir);
  const others = Math.max(0, keep - 1);
  // ls -t sorts by mtime (newest first); only 64-hex sibling names are candidates.
  return `cd ${dir} 2>/dev/null || exit 0; ls -1t | grep -E '^[a-f0-9]{64}$' | grep -v '^${activeHash}$' | tail -n +${others + 1} | while IFS= read -r d; do ( exec 9>"$d/.worker.lock" || exit 0; flock -n -x 9 || exit 0; for exe in /proc/[0-9]*/exe; do target=$(readlink "$exe" 2>/dev/null) || continue; case "$target" in "$PWD/$d/"*) exit 0;; esac; done; rm -rf -- "$d" ); done; exit 0`;
}

/** Shallow worker-binary accounting only: never traverse shared assets or hash binaries. */
export function buildPruneAndAuditWorkersCommand(namespaceDir: string, activeHash: string): string {
  const prune = buildPruneStaleWorkersCommand(namespaceDir, activeHash);
  // Keep the script a single shell argument compatible with quoteRemoteArgument.
  // Separators are explicit: function/loop openers cannot be followed by `;`.
  return [
    `(${prune});`,
    "set -eu;",
    `namespace=${quoteRemoteArgument(namespaceDir)};`,
    'root=$(dirname -- "$namespace");',
    'if test -e "$root"; then test -r "$root" && test -x "$root" || exit 1; fi;',
    'audit_namespace() {',
    'ns=$1; kind=$2; versions=0; files=0; bytes=0; old_versions=0; old_files=0; old_bytes=0;',
    'if test -e "$ns"; then test -r "$ns" && test -x "$ns" || exit 1; fi;',
    'for d in "$ns"/*; do',
    'test -d "$d" && test ! -L "$d" || continue;',
    'name=${d##*/};',
    `printf '%s\\n' "$name" | grep -Eq '^[a-f0-9]{64}$' || continue;`,
    'test -r "$d" && test -x "$d" || exit 1;',
    'versions=$((versions + 1)); version_files=0; version_bytes=0;',
    'for binary in "$d/worker" "$d/worker-linux-x64" "$d/worker-linux-arm64"; do',
    'test -f "$binary" && test ! -L "$binary" || continue;',
    `allocation=$(stat -c '%b %B' -- "$binary") || exit 1;`,
    'set -- $allocation;',
    'test "$#" -eq 2 || exit 1;',
    'version_files=$((version_files + 1)); version_bytes=$((version_bytes + $1 * $2));',
    'done;',
    'files=$((files + version_files)); bytes=$((bytes + version_bytes));',
    `if test "$name" != '${activeHash}'; then`,
    'old_versions=$((old_versions + 1)); old_files=$((old_files + version_files)); old_bytes=$((old_bytes + version_bytes));',
    'fi;',
    'done;',
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$kind" "\${ns##*/}" "$versions" "$files" "$bytes" "$old_versions" "$old_files" "$old_bytes";`,
    '};',
    'audit_namespace "$namespace" current;',
    'for ns in "$root"/*; do',
    'test -d "$ns" && test ! -L "$ns" && test "$ns" != "$namespace" || continue;',
    'name=${ns##*/};',
    `printf '%s\\n' "$name" | grep -Eq '^(omp-[a-zA-Z0-9][a-zA-Z0-9._-]*|[0-9]+\\.[0-9]+\\.[0-9]+([+-][a-zA-Z0-9.-]+)?)$' || continue;`,
    'audit_namespace "$ns" legacy;',
    'done',
  ].join(" ");
}

export function parseRemoteWorkerCacheAudit(output: string, namespace: string): RemoteWorkerCacheAudit {
  const rows = output.split("\n").map(line => {
    const [kind, name, ...fields] = line.split("\t");
    if (!name || fields.length !== 6 || fields.some(field => !/^(0|[1-9][0-9]*)$/.test(field) || !Number.isSafeInteger(Number(field)))) {
      throw new Error("Invalid worker cache audit response");
    }
    const [versions, binaryFiles, allocatedBytes, oldVersions, oldFiles, oldBytes] = fields.map(Number) as [number, number, number, number, number, number];
    if (oldVersions > versions || oldFiles > binaryFiles || oldBytes > allocatedBytes) throw new Error("Inconsistent worker cache audit response");
    return { kind, usage: { namespace: name, versions, binaryFiles, allocatedBytes }, old: { versions: oldVersions, binaryFiles: oldFiles, allocatedBytes: oldBytes } };
  });
  const current = rows.shift();
  if (current?.kind !== "current" || current.usage.namespace !== namespace || rows.some(row => row.kind !== "legacy" || !/^(omp-[a-zA-Z0-9][a-zA-Z0-9._-]*|[0-9]+\.[0-9]+\.[0-9]+([+-][a-zA-Z0-9.-]+)?)$/.test(row.usage.namespace)) || new Set(rows.map(row => row.usage.namespace)).size !== rows.length) {
    throw new Error("Invalid worker cache audit namespaces");
  }
  return {
    available: true,
    observedAt: new Date().toISOString(),
    scope: "worker binaries only; excludes shared assets and other cache contents",
    metric: "sum of per-file allocated bytes (stat blocks × block size), not logical size",
    current: current.usage,
    retainedOld: current.old,
    legacy: rows.map(row => row.usage),
  };
}

export function describeRemoteWorkerCacheAudit(audit: RemoteWorkerCacheAudit): string {
  if (!audit.available) return audit.warning;
  const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const usage = (entry: Omit<RemoteWorkerCacheUsage, "namespace">) => `${entry.versions} version(s), ${entry.binaryFiles} binary file(s), ${size(entry.allocatedBytes)}`;
  const legacy = audit.legacy.length ? audit.legacy.slice(0, 3).map(entry => `${entry.namespace}: ${usage(entry)}`).join("; ") + (audit.legacy.length > 3 ? `; +${audit.legacy.length - 3} more namespace(s)` : "") : "none";
  return `Worker cache (${audit.current.namespace}): ${usage(audit.current)}; retained old: ${usage(audit.retainedOld)}; legacy: ${legacy}. Allocated binary bytes only, not total cache usage; shared assets excluded. Retained versions may still be in use.`;
}

async function pruneAndAuditRemoteWorkers(
  options: WorkerDeploymentOptions,
  namespaceDir: string,
  activeHash: string,
): Promise<RemoteWorkerCacheAudit> {
  try {
    const output = await run(
      [
        ...buildSshBaseCommand(options),
        getSshDestination(options),
        `timeout -k 1s 8s sh -c ${quoteRemoteArgument(buildPruneAndAuditWorkersCommand(namespaceDir, activeHash))}`,
      ],
      "Remote worker cache prune and audit",
      10_000,
    );
    return parseRemoteWorkerCacheAudit(output, namespaceDir.slice(namespaceDir.lastIndexOf("/") + 1));
  } catch {
    return { available: false, observedAt: new Date().toISOString(), warning: "Worker cache audit unavailable (prune/audit failed or exceeded 10s); connection continues." };
  }
}

async function deployCompanionArtifacts(
  options: WorkerDeploymentOptions,
  home: string,
  arch: "arm64" | "x64",
  workerRemoteDir: string,
  bundle: RemoteWorkerBundle,
): Promise<void> {
  for (const artifact of bundle.companionArtifacts) {
    await deployCompanionArtifact(
      options,
      home,
      arch,
      workerRemoteDir,
      bundle,
      artifact,
    );
  }
}

async function deployCompanionArtifact(
  options: WorkerDeploymentOptions,
  home: string,
  arch: "arm64" | "x64",
  workerRemoteDir: string,
  bundle: RemoteWorkerBundle,
  artifact: RemoteCompanionArtifact,
): Promise<void> {
  const localArtifact = await resolveLocalCompanionBinary(
    artifact,
    arch,
    options.localArtifactDir,
  );
  const artifactHash = await readWorkerHash(localArtifact);
  const remoteArtifactDir = `${home}/.cache/omp-ssh-remote/${bundle.cacheNamespace}/${artifact.id}/${arch}/${artifactHash}`;
  const remoteArtifactBin = `${remoteArtifactDir}/${artifact.executableName}`;
  const marker = `${remoteArtifactBin}.sha256`;
  const quotedRemoteArtifactBin = quoteRemoteArgument(remoteArtifactBin);
  const quotedMarker = quoteRemoteArgument(marker);
  const quotedWorkerDir = quoteRemoteArgument(workerRemoteDir);

  const exists = await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `test -x ${quotedRemoteArtifactBin} && test "$(cat ${quotedMarker} 2>/dev/null)" = '${artifactHash}' && printf present || printf missing`,
    ],
    `${artifact.id} companion artifact check`,
  );

  if (exists !== "present") {
    await run(
      [
        ...buildSshBaseCommand(options),
        getSshDestination(options),
        `mkdir -p ${quoteRemoteArgument(remoteArtifactDir)} && chmod 700 ${quoteRemoteArgument(remoteArtifactDir)}`,
      ],
      `${artifact.id} companion artifact cache setup`,
    );
    const nonce = crypto.randomUUID();
    const tempUpload = `${remoteArtifactBin}.upload-${nonce}`;
    const tempMarker = `${marker}.upload-${nonce}`;
    const scp = buildScpBaseCommand(options);
    scp.push(
      localArtifact,
      `${getSshDestination(options)}:${quoteRemoteArgument(tempUpload)}`,
    );
    await run(scp, `${artifact.id} companion artifact upload`);
    await run(
      [
        ...buildSshBaseCommand(options),
        getSshDestination(options),
        `set -eu; actual=$(sha256sum ${quoteRemoteArgument(tempUpload)} | cut -d ' ' -f 1); test "$actual" = '${artifactHash}'; chmod 700 ${quoteRemoteArgument(tempUpload)}; mv -f ${quoteRemoteArgument(tempUpload)} ${quotedRemoteArtifactBin}; printf '%s\n' '${artifactHash}' > ${quoteRemoteArgument(tempMarker)}; chmod 600 ${quoteRemoteArgument(tempMarker)}; mv -f ${quoteRemoteArgument(tempMarker)} ${quotedMarker}`,
      ],
      `${artifact.id} companion artifact activation`,
    );
  }

  await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `ln -sf ${quotedRemoteArtifactBin} ${quotedWorkerDir}/${quoteRemoteArgument(artifact.executableName)}`,
    ],
    `Link ${artifact.id} companion artifact to worker directory`,
  );
}

export async function ensureRemoteWorker(
  options: WorkerDeploymentOptions,
): Promise<string> {
  return (await prepareRemoteWorker(options)).workerPath;
}
