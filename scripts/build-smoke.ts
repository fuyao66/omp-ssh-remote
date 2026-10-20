import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const requested = process.argv[2] ?? "all";
const names = ["cache", "lifecycle", "capture", "rich-output"] as const;
if (requested !== "all" && !names.some(name => name === requested)) {
  throw new Error("Usage: bun scripts/build-smoke.ts [all|cache|lifecycle|capture|rich-output]");
}
for (const name of names.filter(name => requested === "all" || name === requested)) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `scripts/smoke-${name}.ts`)],
    outdir: resolve(root, "packages/omp/dist"),
    naming: `${name}-smoke.js`,
    target: "bun",
    minify: true,
    external: ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-agent-core", "@oh-my-pi/pi-natives"],
    plugins: [{ name: "native-smoke-modules", setup(build) {
      build.onResolve({ filter: /^@oh-my-pi\/pi-coding-agent\/job-widgets\/registry$/ }, args => ({
        path: Bun.resolveSync(args.path, root),
      }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${name} acceptance`);
  console.log(`Bundled native ${name} acceptance`);
}
