import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

type BuildTarget = "all" | "omp" | "pi";
const target = (process.argv[2] ?? "all") as BuildTarget;
if (target !== "all" && target !== "omp" && target !== "pi") {
  throw new Error(
    `Usage: bun scripts/build.ts <all|omp|pi>; got ${JSON.stringify(target)}`,
  );
}

const root = resolve(import.meta.dir, "..");
const ompOutdir = resolve(root, "packages/omp/dist");
const piOutdir = resolve(root, "packages/pi/dist");
await Promise.all([
  mkdir(ompOutdir, { recursive: true }),
  mkdir(piOutdir, { recursive: true }),
]);
if (target === "all" || target === "omp") {
  await rm(resolve(ompOutdir, "pi-extension.js"), { force: true });
  for (const entry of await readdir(ompOutdir)) {
    if (
      entry === "worker.js" ||
      entry.startsWith("CHANGELOG-") ||
      entry.startsWith("template-") ||
      entry.startsWith("tool-views.generated-")
    ) {
      await rm(resolve(ompOutdir, entry), { force: true });
    }
  }
}
if (target === "all" || target === "pi") {
  await rm(resolve(piOutdir, "extension.js"), { force: true });
}

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

if (target === "all" || target === "omp") {
  const extension = await Bun.build({
    entrypoints: [resolve(root, "src/extension.ts")],
    outdir: ompOutdir,
    target: "bun",
    format: "esm",
    minify: false,
  });
  if (!extension.success)
    throw new AggregateError(extension.logs, "OMP extension build failed");
}

if (target === "all" || target === "pi") {
  const extension = await Bun.build({
    entrypoints: [resolve(root, "src/pi/host-extension.ts")],
    outdir: piOutdir,
    naming: "pi-extension.js",
    target: "node",
    format: "esm",
    minify: false,
    external: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-agent-core",
    ],
  });
  if (!extension.success)
    throw new AggregateError(extension.logs, "Pi extension build failed");
}
