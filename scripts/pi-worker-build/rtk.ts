import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

/** Locked upstream packaging fix: preserve lazy evaluation while making targets visible to Bun. */
export const rtkBundlePlugin: Bun.BunPlugin = {
  name: "pi-ssh-remote:rtk-bundle",
  setup(build) {
    const root = resolve(import.meta.dir, "../../node_modules/pi-rtk-optimizer");
    const aliases: Record<string, string> = {
      "omp-rtk-entry": "index.ts",
      "omp-rtk-config-store": "src/config-store.ts",
      "omp-rtk-output-metrics": "src/output-metrics.ts",
      "omp-rtk-executable-resolver": "src/rtk-executable-resolver.ts",
    };
    build.onResolve({ filter: /^omp-rtk-/ }, ({ path }) => {
      if (!aliases[path]) throw new Error(`Unknown RTK bundle import: ${path}`);
      return { path: resolve(root, aliases[path]) };
    });
    build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, ({ path, importer }) => {
      if (!importer.startsWith(root + "/")) return;
      return { path: resolve(dirname(importer), path.slice(0, -3) + ".ts") };
    });
    build.onLoad({ filter: /pi-rtk-optimizer\/src\/lazy-module-loader\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      if (!source.includes("cached ??= import(specifier)")) throw new Error("RTK lazy-loader contract changed");
      return {
        contents: source.replace("cached ??= import(specifier)", `cached ??= (specifier === "./output-compactor.js" ? import("./output-compactor.js") : specifier === "./config-modal.js" ? import("./config-modal.js") : Promise.reject(new Error("Unsupported RTK lazy module: " + specifier)))`),
        loader: "ts",
        resolveDir: dirname(path),
      };
    });
  },
};
