import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PYTHON_LSP_ARCHIVE_SCRIPT } from "./python-lsp-archive.ts";
import { parsePythonLspPackDescriptor, sha256, type PythonLspArchitecture, type PythonLspPackDescriptor } from "./python-lsp-pack.ts";
import { buildScpBaseCommand, buildSshBaseCommand, getSshDestination, quoteRemoteArgument, type SshConnectionOptions } from "./ssh.ts";

type Run = (command: string[], description: string, timeoutMs?: number) => Promise<string>;
export function pythonLspCacheCommand(root: string, descriptor: PythonLspPackDescriptor, archive = "-"): string {
  const encoded = Buffer.from(PYTHON_LSP_ARCHIVE_SCRIPT).toString("base64");
  const program = `import base64;exec(base64.b64decode('${encoded}'))`;
  return ["python3", "-c", program, "cache", root, descriptor.id, descriptor.arch, archive, descriptor.archiveSha256]
    .map(quoteRemoteArgument).join(" ");
}

export async function deployPythonLspPack(options: SshConnectionOptions, home: string, arch: PythonLspArchitecture, artifactDir: string, run: Run): Promise<string> {
  const prefix = join(artifactDir, `python-lsp-linux-${arch}`);
  let descriptor: PythonLspPackDescriptor;
  try { descriptor = parsePythonLspPackDescriptor(JSON.parse(await readFile(`${prefix}.json`, "utf8")), arch); }
  catch (error) { throw new Error(`Python LSP opt-in requires a prepared ${arch} pack; run bun scripts/prepare-python-lsp.ts ${arch}`, { cause: error }); }
  const archive = `${prefix}.tar.gz`;
  if (sha256(await readFile(archive)) !== descriptor.archiveSha256) throw new Error("Local Python LSP pack archive checksum mismatch");
  const root = `${home}/.cache/omp-ssh-remote/language-packs/python/linux-${arch}`;
  const expected = `${root}/${descriptor.id}`;
  const ssh = (command: string) => [...buildSshBaseCommand(options), getSshDestination(options), command];
  const existing = await run(ssh(pythonLspCacheCommand(root, descriptor)), "Python LSP pack integrity check", 120_000);
  if (existing === expected) return expected;
  if (existing !== "missing") throw new Error("Unexpected Python LSP pack cache response");
  const upload = `${root}/.${descriptor.id}.upload-${crypto.randomUUID()}`;
  try {
    await run([...buildScpBaseCommand(options), archive, `${getSshDestination(options)}:${quoteRemoteArgument(upload)}`], "Python LSP pack upload (explicit opt-in; first deployment only)", 600_000);
    const result = await run(ssh(pythonLspCacheCommand(root, descriptor, upload)), "Verify and atomically publish Python LSP pack", 120_000);
    if (result !== expected) throw new Error("Unexpected Python LSP pack activation response");
    return result;
  } finally {
    await run(ssh(`rm -f -- ${quoteRemoteArgument(upload)}`), "Remove Python LSP pack temporary upload", 20_000).catch(() => {});
  }
}
