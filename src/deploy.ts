import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_VERSION } from "./protocol.ts";
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
        rejectPromise(new Error(`${description} stdout exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        proc.kill();
        rejectPromise(new Error(`${description} stderr exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
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
          new Error(`${description} failed (${code}): ${stderrText || stdoutText}`),
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

function resolveLocalWorkerPath(arch: "arm64" | "x64", host: "omp" | "pi" = "omp"): string[] {
  const prefix = host === "pi" ? "pi-worker-linux-" : "worker-linux-";
  return [
    join(MODULE_DIR, `${prefix}${arch}`),
    join(MODULE_DIR, `../dist/${prefix}${arch}`),
  ];
}
export function resolveLocalAftPath(arch: "arm64" | "x64"): string[] {
  const dirName = arch === "arm64" ? "aft-arm64" : "aft";
  const userHome = process.env.HOME || "/root";
  return [
    join(MODULE_DIR, `../vendor/${dirName}/bin/aft`),
    join(userHome, `.pi/agent/npm/node_modules/@cortexkit/aft-linux-${arch}/bin/aft`),
    join(userHome, `.omp/node_modules/@cortexkit/aft-linux-${arch}/bin/aft`),
  ];
}

export async function resolveLocalAftBinary(arch: "arm64" | "x64"): Promise<string | undefined> {
  const candidates = resolveLocalAftPath(arch);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function resolveLocalWorker(
  arch: "arm64" | "x64",
  explicitPath?: string,
  host: "omp" | "pi" = "omp",
): Promise<string> {
  const candidates = explicitPath ? [explicitPath] : resolveLocalWorkerPath(arch, host);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
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
    [
      ...buildSshBaseCommand(options),
      options.target,
      `printf '%s\\n' "$HOME"`,
    ],
    "Remote home probe",
  );
  if (!output.startsWith("/") || output.includes("\n")) {
    throw new Error(`Invalid remote home response: ${JSON.stringify(output)}`);
  }
  return output;
}

export async function prepareRemoteWorker(
  options: WorkerDeploymentOptions,
  host: "omp" | "pi" = "omp",
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
  const localWorker = await resolveLocalWorker(arch, options.localWorkerPath, host);
  const hash = await readWorkerHash(localWorker);
  const cacheDir = `${probe.home}/.cache/omp-ssh-remote`;
  const workerFile = host === "pi" ? `pi-worker-linux-${arch}` : `worker-linux-${arch}`;
  const remoteDir = `${cacheDir}/${host === "pi" ? "pi" : OMP_VERSION}/${hash}`;
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
    // Check if AFT binary also needs deployment for Pi
    if (host === "pi") {
      await deployRemoteAftIfAvailable(options, probe.home, arch, remoteDir);
    }
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
  if (host === "pi") {
    await deployRemoteAftIfAvailable(options, probe.home, arch, remoteDir);
  }
  return { workerPath: remoteWorker, home: probe.home };
}

async function deployRemoteAftIfAvailable(
  options: WorkerDeploymentOptions,
  home: string,
  arch: "arm64" | "x64",
  workerRemoteDir: string,
): Promise<void> {
  const localAft = await resolveLocalAftBinary(arch);
  if (!localAft) return;

  const aftHash = await readWorkerHash(localAft);
  const remoteAftDir = `${home}/.cache/omp-ssh-remote/aft/${arch}/${aftHash}`;
  const remoteAftBin = `${remoteAftDir}/aft`;
  const quotedRemoteAftBin = quoteRemoteArgument(remoteAftBin);
  const quotedWorkerDir = quoteRemoteArgument(workerRemoteDir);

  const exists = await run(
    [
      ...buildSshBaseCommand(options),
      options.target,
      `test -x ${quotedRemoteAftBin} && printf present || printf missing`,
    ],
    "AFT binary check",
  );

  if (exists !== "present") {
    await run(
      [
        ...buildSshBaseCommand(options),
        options.target,
        `mkdir -p ${quoteRemoteArgument(remoteAftDir)} && chmod 700 ${quoteRemoteArgument(remoteAftDir)}`,
      ],
      "AFT cache directory setup",
    );
    const nonce = crypto.randomUUID();
    const tempUpload = `${remoteAftBin}.upload-${nonce}`;
    const scp = buildScpBaseCommand(options);
    scp.push(localAft, `${options.target}:${quoteRemoteArgument(tempUpload)}`);
    await run(scp, "AFT binary upload");
    await run(
      [
        ...buildSshBaseCommand(options),
        options.target,
        `set -eu; chmod 700 ${quoteRemoteArgument(tempUpload)}; mv -f ${quoteRemoteArgument(tempUpload)} ${quotedRemoteAftBin}`,
      ],
      "AFT binary activation",
    );
  }

  // Symlink into the worker directory so Pi worker can find it as ./aft
  await run(
    [
      ...buildSshBaseCommand(options),
      options.target,
      `ln -sf ${quotedRemoteAftBin} ${quotedWorkerDir}/aft`,
    ],
    "Link AFT binary to worker directory",
  );
}

export async function ensureRemoteWorker(
  options: WorkerDeploymentOptions,
): Promise<string> {
  return (await prepareRemoteWorker(options)).workerPath;
}
