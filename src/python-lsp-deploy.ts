import { deployLanguagePack, languagePackCacheCommand, type PackRun } from "./language-pack-deploy.ts";
import type { PythonLspArchitecture, PythonLspPackDescriptor } from "./python-lsp-pack.ts";
import type { SshConnectionOptions } from "./ssh.ts";

export function pythonLspCacheCommand(root: string, descriptor: PythonLspPackDescriptor, archive = "-"): string {
  return languagePackCacheCommand("python", root, descriptor, archive);
}
export function deployPythonLspPack(options: SshConnectionOptions, home: string, arch: PythonLspArchitecture, artifactDir: string, run: PackRun): Promise<string> {
  return deployLanguagePack("python", options, home, arch, artifactDir, run);
}
