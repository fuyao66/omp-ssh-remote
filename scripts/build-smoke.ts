import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
// cache-mc uses the same helper, with installed MC selected explicitly at runtime.
const requested = process.argv[2] === "cache-mc" ? "cache" : (process.argv[2] ?? "all");
const names = ["cache", "lifecycle", "capture", "rich-output", "lsp", "cpp-lsp", "task"] as const;
if (requested !== "all" && !names.some(name => name === requested)) {
  throw new Error("Usage: bun scripts/build-smoke.ts [all|cache|cache-mc|lifecycle|capture|rich-output|lsp|cpp-lsp|task]");
}
for (const name of names.filter(name => requested === "all" || name === requested)) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `scripts/smoke-${name}.ts`)],
    outdir: resolve(root, ".cache/smoke"),
    naming: `${name}-smoke.js`,
    target: "bun",
    minify: true,
    external: ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-agent-core", "@oh-my-pi/pi-natives"],
    plugins: [{ name: "native-smoke-modules", setup(build) {
      // Keep the release extension beside its workers; this path is relative to .cache/smoke.
      build.onResolve({ filter: /^\.\.\/packages\/omp\/dist\/extension\.js$/ }, () => ({
        path: "../../packages/omp/dist/extension.js", external: true,
      }));
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
        path: "omp-legacy-pi-modules", namespace: "native-smoke-modules",
      }));
      build.onLoad({ filter: /^omp-legacy-pi-modules$/, namespace: "native-smoke-modules" }, () => ({
        contents: "export const BUNDLED_PI_MODULE_LOADERS = {};", loader: "js",
      }));
      build.onResolve({ filter: /^@oh-my-pi\/pi-coding-agent\/job-widgets\/registry$/ }, args => ({
        path: Bun.resolveSync(args.path, root),
      }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${name} acceptance`);
  console.log(`Bundled native ${name} acceptance`);
}
