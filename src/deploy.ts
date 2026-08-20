import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_WORKER_BUNDLE } from "./omp/runtime-contract.ts";
import type {
  RemoteCompanionArtifact,
  RemoteWorkerBundle,
} from "./runtime-contract.ts";
import {
  buildScpBaseCommand,
  buildSshBaseCommand,
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

async function run(
  command: string[],
  description: string,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const [file, ...args] = command;
    const proc = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        proc.kill();
        rejectPromise(
          new Error(
            `${description} stdout exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        proc.kill();
        rejectPromise(
          new Error(
            `${description} stderr exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      stderrChunks.push(chunk);
    });

    const timer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`${description} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf-8").trim();
      if (code !== 0) {
        rejectPromise(
          new Error(
            `${description} failed (${code}): ${stderrText || stdoutText}`,
          ),
        );
      } else {
        resolvePromise(stdoutText);
      }
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

export type PreparedRemoteWorker = {
  workerPath: string;
  home?: string;
};

export async function resolveRemoteHome(
  options: WorkerDeploymentOptions,
): Promise<string> {
  const output = await run(
    [...buildSshBaseCommand(options), options.target, `printf '%s\\n' "$HOME"`],
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
  const probe = parseProbe(
    await run(
      [
        ...buildSshBaseCommand(options),
        options.target,
        "uname -s && uname -m && printf '%s' \"$HOME\"",
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
      options.target,
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
    return { workerPath: remoteWorker, home: probe.home };
  }
  if (exists !== "missing")
    throw new Error(`Unexpected remote worker check response: ${exists}`);

  await run(
    [
      ...buildSshBaseCommand(options),
      options.target,
      `mkdir -p ${quoteRemoteArgument(remoteDir)} && chmod 700 ${quoteRemoteArgument(remoteDir)}`,
    ],
    "Remote cache setup",
  );
  const nonce = crypto.randomUUID();
  const temporary = `${remoteWorker}.upload-${nonce}`;
  const temporaryMarker = `${marker}.upload-${nonce}`;
  const scp = buildScpBaseCommand(options);
  scp.push(localWorker, `${options.target}:${quoteRemoteArgument(temporary)}`);
  await run(scp, "Worker upload");
  const quotedTemporary = quoteRemoteArgument(temporary);
  const quotedTemporaryMarker = quoteRemoteArgument(temporaryMarker);
  await run(
    [
      ...buildSshBaseCommand(options),
      options.target,
      `set -eu; actual=$(sha256sum ${quotedTemporary} | cut -d ' ' -f 1); test "$actual" = '${hash}'; chmod 700 ${quotedTemporary}; mv -f ${quotedTemporary} ${quotedWorker}; printf '%s\\n' '${hash}' > ${quotedTemporaryMarker}; chmod 600 ${quotedTemporaryMarker}; mv -f ${quotedTemporaryMarker} ${quotedMarker}`,
    ],
    "Worker activation",
  );
  await deployCompanionArtifacts(options, probe.home, arch, remoteDir, bundle);
  return { workerPath: remoteWorker, home: probe.home };
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
      options.target,
      `test -x ${quotedRemoteArtifactBin} && test "$(cat ${quotedMarker} 2>/dev/null)" = '${artifactHash}' && printf present || printf missing`,
    ],
    `${artifact.id} companion artifact check`,
  );

  if (exists !== "present") {
    await run(
      [
        ...buildSshBaseCommand(options),
        options.target,
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
      `${options.target}:${quoteRemoteArgument(tempUpload)}`,
    );
    await run(scp, `${artifact.id} companion artifact upload`);
    await run(
      [
        ...buildSshBaseCommand(options),
        options.target,
        `set -eu; actual=$(sha256sum ${quoteRemoteArgument(tempUpload)} | cut -d ' ' -f 1); test "$actual" = '${artifactHash}'; chmod 700 ${quoteRemoteArgument(tempUpload)}; mv -f ${quoteRemoteArgument(tempUpload)} ${quotedRemoteArtifactBin}; printf '%s\n' '${artifactHash}' > ${quoteRemoteArgument(tempMarker)}; chmod 600 ${quoteRemoteArgument(tempMarker)}; mv -f ${quoteRemoteArgument(tempMarker)} ${quotedMarker}`,
      ],
      `${artifact.id} companion artifact activation`,
    );
  }

  await run(
    [
      ...buildSshBaseCommand(options),
      options.target,
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
