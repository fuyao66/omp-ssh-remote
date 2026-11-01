import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LANGUAGE_PACK_ARCHIVE_SCRIPT } from "./language-pack-archive.ts";
import { parseLanguagePackDescriptor, sha256, type LanguagePackArchitecture, type LanguagePackDescriptor } from "./language-pack.ts";
import { buildScpBaseCommand, buildSshBaseCommand, getSshDestination, quoteRemoteArgument, type SshConnectionOptions } from "./ssh.ts";

export type PackRun = (command: string[], description: string, timeoutMs?: number) => Promise<string>;
export type LanguagePackProfile = "python" | "typescript" | "cpp";
export function languagePackCacheCommand(profile: LanguagePackProfile, root: string, descriptor: LanguagePackDescriptor, archive = "-"): string {
  const encoded = Buffer.from(LANGUAGE_PACK_ARCHIVE_SCRIPT).toString("base64");
  const program = `import base64;exec(base64.b64decode('${encoded}'))`;
  return ["python3", "-c", program, "cache", root, descriptor.id, descriptor.arch, archive, descriptor.archiveSha256, profile]
    .map(quoteRemoteArgument).join(" ");
}
export async function deployLanguagePack(profile: LanguagePackProfile, options: SshConnectionOptions, home: string, arch: LanguagePackArchitecture, artifactDir: string, run: PackRun): Promise<string> {
  const label = { python: "Python", typescript: "TypeScript", cpp: "C/C++" }[profile];
  const prefix = join(artifactDir, `${profile}-lsp-linux-${arch}`);
  let descriptor: LanguagePackDescriptor;
  try { descriptor = parseLanguagePackDescriptor(JSON.parse(await readFile(`${prefix}.json`, "utf8")), arch, label); }
  catch (error) { throw new Error(`${label} LSP opt-in requires a prepared ${arch} pack; run bun scripts/prepare-${profile}-lsp.ts ${arch}`, { cause: error }); }
  const archive = `${prefix}.tar.gz`;
  if (sha256(await readFile(archive)) !== descriptor.archiveSha256) throw new Error(`Local ${label} LSP pack archive checksum mismatch`);
  const root = `${home}/.cache/omp-ssh-remote/language-packs/${profile}/linux-${arch}`;
  const expected = `${root}/${descriptor.id}`;
  const ssh = (command: string) => [...buildSshBaseCommand(options), getSshDestination(options), command];
  const existing = await run(ssh(languagePackCacheCommand(profile, root, descriptor)), `${label} LSP pack integrity check`, 120_000);
  if (existing === expected) return expected;
  if (existing !== "missing") throw new Error(`Unexpected ${label} LSP pack cache response`);
  const upload = `${root}/.${descriptor.id}.upload-${crypto.randomUUID()}`;
  try {
    await run([...buildScpBaseCommand(options), archive, `${getSshDestination(options)}:${quoteRemoteArgument(upload)}`], `${label} LSP pack upload (explicit opt-in; first deployment only)`, 600_000);
    const result = await run(ssh(languagePackCacheCommand(profile, root, descriptor, upload)), `Verify and atomically publish ${label} LSP pack`, 120_000);
    if (result !== expected) throw new Error(`Unexpected ${label} LSP pack activation response`);
    return result;
  } finally {
    await run(ssh(`rm -f -- ${quoteRemoteArgument(upload)}`), `Remove ${label} LSP pack temporary upload`, 20_000).catch(() => {});
  }
}
