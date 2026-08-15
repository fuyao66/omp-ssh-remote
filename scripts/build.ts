import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "dist");
await mkdir(outdir, { recursive: true });

const legacyModulePlugin: Bun.BunPlugin = {
  name: "omp-ssh-remote:legacy-pi-disabled",
  setup(build) {
    build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
      path: "omp-legacy-pi-modules",
      namespace: "omp-ssh-remote",
    }));
    build.onLoad({ filter: /.*/, namespace: "omp-ssh-remote" }, () => ({
      contents: "export const BUNDLED_PI_MODULE_LOADERS = {};",
      loader: "js",
    }));
  },
};

const extension = await Bun.build({
  entrypoints: [resolve(root, "src/extension.ts")],
  outdir,
  target: "bun",
  format: "esm",
  minify: false,
});
if (!extension.success)
  throw new AggregateError(extension.logs, "Extension build failed");
const worker = await Bun.build({
  entrypoints: [resolve(root, "src/worker.ts")],
  outdir,
  naming: "worker.js",
  target: "bun",
  format: "esm",
  minify: false,
  plugins: [legacyModulePlugin],
});
if (!worker.success)
  throw new AggregateError(worker.logs, "Worker build failed");
