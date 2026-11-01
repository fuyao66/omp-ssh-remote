import { resolve } from "node:path";

/** Worker-only, fail-closed adaptation of SDK 18.13.1. No installed SDK files are modified. */
export function adaptNativePythonLspConfig(source: string, sdkVersion: string, fallbackModule: string): string {
  if (sdkVersion !== "18.13.1") throw new Error(`Python LSP configuration adapter requires SDK 18.13.1, got ${sdkVersion}`);
  const replaceOnce = (anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw new Error("Native LSP configuration adapter anchor drift");
    source = source.replace(anchor, replacement);
  };
  replaceOnce('import * as fs from "node:fs";', `import { applyPythonLspFallback } from ${JSON.stringify(resolve(fallbackModule))};\nimport * as fs from "node:fs";`);
  replaceOnce("\tlet mergedServers = coerceServerConfigs(DEFAULTS);", "\tlet mergedServers = coerceServerConfigs(DEFAULTS);\n\tconst privatePythonExplicit = new Map<string, Set<string>>();");
  replaceOnce("\t\tmergedServers = mergeServers(mergedServers, parsed.servers);", `\t\tfor (const [name, raw] of Object.entries(parsed.servers)) {
      if (raw && typeof raw === "object") {
        const keys = privatePythonExplicit.get(name) ?? new Set<string>();
        for (const key of Object.keys(raw)) keys.add(key);
        privatePythonExplicit.set(name, keys);
      }
    }
\t\tmergedServers = mergeServers(mergedServers, parsed.servers);`);
  replaceOnce("\tselectTypescriptServer(servers);", `\tconst privatePythonPack = process.env.OMP_REMOTE_PYTHON_LSP_PACK;
    let privatePythonLauncher: string | undefined;
    if (privatePythonPack) {
      if (!path.isAbsolute(privatePythonPack)) throw new Error("Python LSP pack path must be absolute");
      const physicalPack = fs.realpathSync(privatePythonPack);
      privatePythonLauncher = path.join(physicalPack, "bin", "pyright-langserver");
      fs.accessSync(privatePythonLauncher, fs.constants.X_OK);
    }
    applyPythonLspFallback(candidates, servers, privatePythonExplicit,
      config => hasRootMarkers(cwd, config.rootMarkers), privatePythonLauncher);
\tselectTypescriptServer(servers);`);
  return source;
}
