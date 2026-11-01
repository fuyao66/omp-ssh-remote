import { dirname, resolve } from "node:path";

/** Worker-only, fail-closed adaptation of SDK 18.15.0. No installed SDK files are modified. */
export function adaptNativeLspConfig(source: string, sdkVersion: string, fallbackModule: string): string {
  if (sdkVersion !== "18.15.0") throw new Error(`Native LSP configuration adapter requires SDK 18.15.0, got ${sdkVersion}`);
  const replaceOnce = (anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw new Error("Native LSP configuration adapter anchor drift");
    source = source.replace(anchor, replacement);
  };
  replaceOnce('import * as fs from "node:fs";', `import { applyPythonLspFallback } from ${JSON.stringify(resolve(fallbackModule))};\nimport { applyTypescriptLspFallback } from ${JSON.stringify(resolve(dirname(fallbackModule), "typescript-lsp-fallback.ts"))};\nimport * as fs from "node:fs";`);
  replaceOnce('import * as fs from "node:fs";', `import { applyCppLspFallback } from ${JSON.stringify(resolve(dirname(fallbackModule), "cpp-lsp-fallback.ts"))};\nimport * as fs from "node:fs";`);
  replaceOnce("\tlet mergedServers = coerceServerConfigs(DEFAULTS);", "\tlet mergedServers = coerceServerConfigs(DEFAULTS);\n\tconst explicitServerFields = new Map<string, Set<string>>();");
  replaceOnce("\t\tmergedServers = mergeServers(mergedServers, parsed.servers);", `\t\tfor (const [name, raw] of Object.entries(parsed.servers)) {
      if (raw && typeof raw === "object") {
        const keys = explicitServerFields.get(name) ?? new Set<string>();
        for (const key of Object.keys(raw)) keys.add(key);
        explicitServerFields.set(name, keys);
      }
    }
\t\tmergedServers = mergeServers(mergedServers, parsed.servers);`);
  replaceOnce("\tselectTypescriptServer(servers, cwd);", `\tconst privatePythonPack = process.env.OMP_REMOTE_PYTHON_LSP_PACK;
    let privatePythonLauncher: string | undefined;
    if (privatePythonPack) {
      if (!path.isAbsolute(privatePythonPack)) throw new Error("Python LSP pack path must be absolute");
      const physicalPack = fs.realpathSync(privatePythonPack);
      privatePythonLauncher = path.join(physicalPack, "bin", "pyright-langserver");
      fs.accessSync(privatePythonLauncher, fs.constants.X_OK);
    }
    applyPythonLspFallback(candidates, servers, explicitServerFields,
      config => hasRootMarkers(cwd, config.rootMarkers), privatePythonLauncher);
    const privateTypescriptPack = process.env.OMP_REMOTE_TYPESCRIPT_LSP_PACK;
    let privateTypescriptLauncher: string | undefined;
    if (privateTypescriptPack) {
      if (!path.isAbsolute(privateTypescriptPack)) throw new Error("TypeScript LSP pack path must be absolute");
      const physicalPack = fs.realpathSync(privateTypescriptPack);
      privateTypescriptLauncher = path.join(physicalPack, "bin", "typescript-language-server");
      fs.accessSync(privateTypescriptLauncher, fs.constants.X_OK);
    }
    applyTypescriptLspFallback(candidates, servers, explicitServerFields,
      config => hasRootMarkers(cwd, config.rootMarkers), privateTypescriptLauncher);
    const privateCppPack = process.env.OMP_REMOTE_CPP_LSP_PACK;
    let privateCppLauncher: string | undefined;
    if (privateCppPack) {
      if (!path.isAbsolute(privateCppPack)) throw new Error("C/C++ LSP pack path must be absolute");
      privateCppLauncher = path.join(fs.realpathSync(privateCppPack), "bin", "clangd");
      fs.accessSync(privateCppLauncher, fs.constants.X_OK);
    }
    applyCppLspFallback(candidates, servers, explicitServerFields,
      config => hasRootMarkers(cwd, config.rootMarkers), privateCppLauncher);
\tselectTypescriptServer(servers, cwd);`);
  return source;
}
