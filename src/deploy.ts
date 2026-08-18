import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
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
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => process.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collectBounded(process.stdout, `${description} stdout`),
      collectBounded(process.stderr, `${description} stderr`),
      process.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(
        `${description} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    return stdout.trim();
  } catch (error) {
    process.kill();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const SUPPORTED_PLATFORMS: Record<string, "arm64" | "x64"> = {
  "Linux/aarch64": "arm64",
  "Linux/x86_64": "x64",
};

function resolveLocalWorkerPath(arch: "arm64" | "x64"): string[] {
  return [
    join(import.meta.dir, `worker-linux-${arch}`),
    join(import.meta.dir, `../dist/worker-linux-${arch}`),
  ];
}

async function resolveLocalWorker(
  arch: "arm64" | "x64",
  explicitPath?: string,
): Promise<string> {
  const candidates = explicitPath ? [explicitPath] : resolveLocalWorkerPath(arch);
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
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(workerPath).arrayBuffer())
    .digest("hex");
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
): Promise<PreparedRemoteWorker> {
  if (options.workerPath) return { workerPath: options.workerPath };
  const probe = await run(
    [
      ...buildSshBaseCommand(options),
      options.target,
      `printf '%s\\n%s\\n%s\\n' "$(uname -s)" "$(uname -m)" "$HOME"`,
    ],
    "Remote platform probe",
  );
  const { platform, home } = parseProbe(probe);
  const arch = SUPPORTED_PLATFORMS[platform];
  if (!arch) {
    throw new Error(
      `No bundled worker for remote platform ${JSON.stringify(platform)}; supported: Linux/aarch64, Linux/x86_64`,
    );
  }

  const localWorker = await resolveLocalWorker(arch, options.localWorkerPath);
  const hash = await readWorkerHash(localWorker);
  const remoteDir = `${home}/.cache/omp-ssh-remote/${OMP_VERSION}/${hash}`;
  const remoteWorker = `${remoteDir}/worker`;
  const marker = `${remoteDir}/worker.sha256`;
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
  if (exists === "present") return { workerPath: remoteWorker, home };
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
  return { workerPath: remoteWorker, home };
}

export async function ensureRemoteWorker(
  options: WorkerDeploymentOptions,
): Promise<string> {
  return (await prepareRemoteWorker(options)).workerPath;
}
