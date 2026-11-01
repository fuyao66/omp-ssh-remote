import { deployLanguagePack, languagePackCacheCommand, type PackRun } from "./language-pack-deploy.ts";
import type { TypescriptLspArchitecture, TypescriptLspPackDescriptor } from "./typescript-lsp-pack.ts";
import type { SshConnectionOptions } from "./ssh.ts";

export function typescriptLspCacheCommand(root: string, descriptor: TypescriptLspPackDescriptor, archive = "-"): string {
  return languagePackCacheCommand("typescript", root, descriptor, archive);
}
export function deployTypescriptLspPack(options: SshConnectionOptions, home: string, arch: TypescriptLspArchitecture, artifactDir: string, run: PackRun): Promise<string> {
  return deployLanguagePack("typescript", options, home, arch, artifactDir, run);
}
