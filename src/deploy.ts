import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { sha256File } from "./file-hash.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_WORKER_BUNDLE } from "./omp/runtime-contract.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { deployLanguagePack } from "./language-pack-deploy.ts";
import type { RemoteWorkerBundle } from "./runtime-contract.ts";
import {
  buildScpBaseCommand,
  buildSshBaseCommand,
  getScpDestination,
  getSshDestination,
  quoteRemoteArgument,
  type SshConnectionOptions,
} from "./ssh.ts";
import { buildCommitWorkerCacheCommand, buildWorkerDeploymentLeaseCommand, cacheRootSetup, validateWorkerCacheIdentity, NATIVE_WORKER_OWNER } from "./worker-cache.ts";

export interface WorkerDeploymentOptions extends SshConnectionOptions {
  localWorkerPath?: string;
  localArtifactDir?: string;
  pythonLsp?: boolean;
  typescriptLsp?: boolean;
  cppLsp?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;


const deploymentContext = new AsyncLocalStorage<Pick<WorkerDeploymentOptions, "signal" | "onProgress">>();
const deployments = new Map<string, Promise<void>>();

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
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(chunks).toString("utf8").trim();
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (failure) rejectPromise(failure);
      else if (code !== 0) rejectPromise(new Error(`${description} failed (${code}): ${stderr || stdout}`));
      else resolvePromise(stdout);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    };
    let finishing = false;
    const drain = (code: number | null) => {
      if (finishing) return;
      finishing = true;
      setImmediate(() => finish(code));
    };
    proc.on("error", (error) => {
      failure ??= error;
      // A failed spawn has no child exit event to wait for.
      if (proc.pid === undefined) drain(null);
    });
    proc.on("exit", drain);
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

async function resolveLocalWorker(
  arch: "arm64" | "x64",
  explicitPath?: string,
  artifactDir = MODULE_DIR,
): Promise<string> {
  const candidate = explicitPath ?? join(artifactDir, `worker-linux-${arch}`);
  try {
    await access(candidate);
    return candidate;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    throw new Error(`${arch} worker binary not found; checked: ${candidate}`);
  }
}
async function readWorkerHash(workerPath: string): Promise<string> {
  try {
    const sidecar = (await readFile(`${workerPath}.sha256`, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(sidecar)) return sidecar;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return sha256File(workerPath);
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

export type RemoteWorkerCacheAudit = { observedAt: string } & ({
  available: true;
  scope: "worker binaries only; excludes shared assets and other cache contents";
  metric: "sum of per-file allocated bytes (stat blocks × block size), not logical size";
  retained: { builds: number; replicas: number; binaryFiles: number; allocatedBytes: number };
  deleted: { builds: number; replicas: number; allocatedBytes: number };
  busy: { builds: number; replicas: number };
  unclassified: number;
} | { available: false; warning: string });

export type PreparedRemoteWorker = {
  workerPath: string;
  pythonLspPack?: string;
  typescriptLspPack?: string;
  cppLspPack?: string;
  home: string;
  /** Combined caller/lease signal, only for deployment and admission. */
  signal: AbortSignal;
  cacheAudit: RemoteWorkerCacheAudit;
  commitUsage(): Promise<RemoteWorkerCacheAudit>;
  dispose(): Promise<void>;
};

export interface RemoteWorkerPreparation {
  /** Resolves on delivery; cancellation can reject before producer cleanup finishes. */
  ready: Promise<PreparedRemoteWorker>;
  /** Completes producer/undelivered-lease cleanup, not a successfully delivered lease. */
  settled: Promise<void>;
}

export async function resolveRemoteHome(
  options: WorkerDeploymentOptions,
): Promise<string> {
  const output = await deploymentContext.run(options, () => run(
    [...buildSshBaseCommand(options), getSshDestination(options), `printf '%s\\n' "$HOME"`],
    "Remote home probe",
  ));
  if (!output.startsWith("/") || output.includes("\n")) {
    throw new Error(`Invalid remote home response: ${JSON.stringify(output)}`);
  }
  return output;
}

export function startRemoteWorkerPreparation(
  options: WorkerDeploymentOptions,
  bundle: RemoteWorkerBundle = OMP_WORKER_BUNDLE,
): RemoteWorkerPreparation {
  const key = JSON.stringify([options.target, options.port, options.identityFile, options.knownHostsFile, bundle.cacheNamespace]);
  const previous = deployments.get(key);
  const producer = (async () => {
    if (previous) {
      options.onProgress?.("Waiting for existing deployment to finish");
      await previous.catch(() => {});
    }
    options.signal?.throwIfAborted();
    return deploymentContext.run(options, () => deployRemoteWorker(options, bundle));
  })();
  const ready = Promise.withResolvers<PreparedRemoteWorker>();
  let deliveredOrCancelled = false;
  const abort = () => {
    if (deliveredOrCancelled) return;
    deliveredOrCancelled = true;
    ready.reject(new Error("Remote deployment cancelled", { cause: options.signal?.reason }));
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  // Cancellation releases the caller promptly, not the producer's ownership.
  // After delivery the caller owns the prepared lease independently of settlement.
  const settled = producer.then(async prepared => {
    if (deliveredOrCancelled) {
      await prepared.dispose();
      return;
    }
    deliveredOrCancelled = true;
    ready.resolve(prepared);
  }, error => {
    deliveredOrCancelled = true;
    ready.reject(error);
  }).finally(() => {
    options.signal?.removeEventListener("abort", abort);
    if (deployments.get(key) === settled) deployments.delete(key);
  });
  deployments.set(key, settled);
  // Consume unhandled rejection reporting without changing the owner's promise.
  void settled.catch(() => {});
  return { ready: ready.promise, settled };
}

export async function prepareRemoteWorker(
  options: WorkerDeploymentOptions,
  bundle: RemoteWorkerBundle = OMP_WORKER_BUNDLE,
): Promise<PreparedRemoteWorker> {
  const preparation = startRemoteWorkerPreparation(options, bundle);
  void preparation.settled.catch(() => {});
  return await preparation.ready;
}

async function deployRemoteWorker(options: WorkerDeploymentOptions, bundle: RemoteWorkerBundle): Promise<PreparedRemoteWorker> {
  if (bundle.owner !== NATIVE_WORKER_OWNER) throw new Error("Unsupported worker bundle owner");
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
  validateWorkerCacheIdentity(bundle.cacheNamespace, hash);
  const lease = await acquireDeploymentLease(options, cacheDir, bundle.cacheNamespace, hash);
  try {
    return await deploymentContext.run({ ...options, signal: lease.signal }, async () => {
  const pythonLspPack = options.pythonLsp
    ? await deployLanguagePack("python", options, probe.home, arch, options.localArtifactDir ?? MODULE_DIR, run)
    : undefined;
  const typescriptLspPack = options.typescriptLsp
    ? await deployLanguagePack("typescript", options, probe.home, arch, options.localArtifactDir ?? MODULE_DIR, run)
    : undefined;
  const cppLspPack = options.cppLsp
    ? await deployLanguagePack("cpp", options, probe.home, arch, options.localArtifactDir ?? MODULE_DIR, run)
    : undefined;
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
      `test ! -L ${quotedWorker} && test ! -L ${quotedMarker} && test -x ${quotedWorker} && test "$(cat ${quotedMarker} 2>/dev/null)" = '${hash}' && printf present || printf missing`,
    ],
    "Remote worker check",
  );
  if (exists !== "present" && exists !== "missing")
    throw new Error(`Unexpected remote worker check response: ${exists}`);

  if (exists === "missing") {
  await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `mkdir -p ${quoteRemoteArgument(remoteDir)} && chmod 700 ${quoteRemoteArgument(remoteDir)}`,
    ],
    "Remote cache setup",
  );
  const nonce = crypto.randomUUID();
  // Independent clients may upload the same hash while another admits it.
  // Staging must not make the admitted generation's strict owned layout invalid.
  const temporary = `${cacheDir}/.${hash}.upload-${nonce}`;
  const temporaryMarker = `${cacheDir}/.${hash}.marker-${nonce}`;
  const scp = buildScpBaseCommand(options);
  // The worker is a ~200 MB uncompressed Bun executable; ssh-level compression
  // measured ~40% fewer bytes on the wire for the one-time upload per version.
  scp.push("-C", localWorker, `${getScpDestination(options)}:${quoteRemoteArgument(temporary)}`);
  const quotedTemporary = quoteRemoteArgument(temporary);
  const quotedTemporaryMarker = quoteRemoteArgument(temporaryMarker);
  try {
    await run(scp, "Worker upload (compressed SCP; first deployment may take several minutes)", 600_000);
  await run(
    [
      ...buildSshBaseCommand(options),
      getSshDestination(options),
      `${cacheRootSetup(cacheDir)} actual=$(sha256sum ${quotedTemporary} | cut -d ' ' -f 1); test "$actual" = '${hash}'; test ! -L ${quotedWorker}; test ! -L ${quotedMarker}; if test -x ${quotedWorker} && test "$(cat ${quotedMarker} 2>/dev/null)" = '${hash}'; then rm -f -- ${quotedTemporary}; else chmod 700 ${quotedTemporary}; mv -f ${quotedTemporary} ${quotedWorker}; printf '%s\\n' '${hash}' > ${quotedTemporaryMarker}; chmod 600 ${quotedTemporaryMarker}; mv -f ${quotedTemporaryMarker} ${quotedMarker}; fi`,
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
  }
  return Object.assign(preparedWorker(options, cacheDir, bundle.cacheNamespace, hash, remoteWorker, probe.home, lease), { pythonLspPack, typescriptLspPack, cppLspPack });
    });
  } catch (error) { await lease.dispose(); throw error; }
}

export function parseRemoteWorkerCacheAudit(output: string): RemoteWorkerCacheAudit {
  const [kind, ...fields] = output.split("\t");
  if (kind !== "managed" || fields.length !== 10 || fields.some(value => !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("Invalid worker cache audit response");
  const [builds, replicas, binaryFiles, allocatedBytes, deletedBuilds, deletedReplicas, deletedBytes, busyBuilds, busyReplicas, unclassified] = fields.map(Number) as [number, number, number, number, number, number, number, number, number, number];
  if (builds > replicas || busyBuilds > busyReplicas || busyReplicas > replicas || deletedBuilds > deletedReplicas) throw new Error("Inconsistent worker cache audit response");
  return { available: true, observedAt: new Date().toISOString(), scope: "worker binaries only; excludes shared assets and other cache contents", metric: "sum of per-file allocated bytes (stat blocks × block size), not logical size", retained: { builds, replicas, binaryFiles, allocatedBytes }, deleted: { builds: deletedBuilds, replicas: deletedReplicas, allocatedBytes: deletedBytes }, busy: { builds: busyBuilds, replicas: busyReplicas }, unclassified };
}

export function describeRemoteWorkerCacheAudit(audit: RemoteWorkerCacheAudit): string {
  if (!audit.available) return audit.warning;
  const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `Worker cache (managed native OMP): retained ${audit.retained.builds} distinct build(s), ${audit.retained.replicas} replica(s), ${size(audit.retained.allocatedBytes)}; deleted ${audit.deleted.replicas} replica(s), ${size(audit.deleted.allocatedBytes)}; busy exemptions ${audit.busy.builds} build(s), ${audit.busy.replicas} replica(s); unclassified ${audit.unclassified} candidate directories. Policy: two distinct used builds, plus busy exemptions. Allocated binary bytes only, not total cache usage; shared assets excluded.`;
}

async function acquireDeploymentLease(options: WorkerDeploymentOptions, root: string, namespace: string, hash: string): Promise<{ signal: AbortSignal; dispose(): Promise<void> }> {
  options.signal?.throwIfAborted();
  const failed = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
  const command = [...buildSshBaseCommand(options), getSshDestination(options), buildWorkerDeploymentLeaseCommand(root, namespace, hash)];
  const [file, ...args] = command;
  const proc = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  let disposal: Promise<void> | undefined;
  let disposed = false;
  let ready = false;
  let output = "";
  let errors = "";
  proc.stdin.on("error", () => {});
  const acquired = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const abort = () => { proc.stdin.end(); proc.kill("SIGKILL"); acquired.reject(new Error("Worker deployment lease cancelled", { cause: signal.reason })); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  proc.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (!ready && output === "READY\n") { ready = true; acquired.resolve(); }
    else if (output.length > 1024 || output.includes("\n") && output !== "READY\n") failed.abort(new Error("Invalid worker deployment lease response"));
  });
  proc.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096); });
  let finishing = false;
  const drain = () => {
    if (finishing) return;
    finishing = true;
    setImmediate(() => {
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
      exited.resolve();
      if (!disposed) {
        const error = new Error(`Worker deployment lease lost: ${errors || "SSH channel closed"}`);
        acquired.reject(error);
        failed.abort(error);
      }
    });
  };
  proc.on("error", error => {
    acquired.reject(error);
    if (!disposed) failed.abort(error);
    if (proc.pid === undefined) drain();
  });
  proc.on("exit", drain);
  const timer = setTimeout(() => failed.abort(new Error("Worker deployment lease acquisition timed out")), 20_000);
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    signal.removeEventListener("abort", abort);
    proc.stdin.end();
    disposal = (async () => {
      const kill = setTimeout(() => proc.kill("SIGKILL"), 2000);
      try { await exited.promise; } finally { clearTimeout(kill); }
    })();
    return disposal;
  };
  try { await acquired.promise; signal.throwIfAborted(); return { signal, dispose }; }
  catch (error) { await dispose(); throw error; }
  finally { clearTimeout(timer); }
}

function preparedWorker(options: WorkerDeploymentOptions, root: string, namespace: string, hash: string, workerPath: string, home: string, lease: { signal: AbortSignal; dispose(): Promise<void> }): PreparedRemoteWorker {
  let committed: Promise<RemoteWorkerCacheAudit> | undefined;
  const result: PreparedRemoteWorker = {
    workerPath, home, signal: lease.signal, dispose: lease.dispose,
    cacheAudit: { available: false, observedAt: new Date().toISOString(), warning: "Worker cache usage not committed: native admission has not succeeded." },
    commitUsage() {
      return committed ??= deploymentContext.run({ ...options, signal: lease.signal }, async () => {
        lease.signal.throwIfAborted();
        try {
          const output = await run([...buildSshBaseCommand(options), getSshDestination(options), `timeout -k 1s 8s sh -c ${quoteRemoteArgument(buildCommitWorkerCacheCommand(root, namespace, hash))}`], "Commit admitted worker usage and collect cache", 10_000);
          result.cacheAudit = parseRemoteWorkerCacheAudit(output);
        } catch {
          result.cacheAudit = { available: false, observedAt: new Date().toISOString(), warning: "Worker cache audit unavailable (usage commit/collection failed or exceeded 10s); connection continues." };
        }
        lease.signal.throwIfAborted();
        return result.cacheAudit;
      });
    },
  };
  return result;
}
