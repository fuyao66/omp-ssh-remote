import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { OMP_VERSION } from "../src/protocol.ts";

type Target = "arm64" | "x64";

const targetArg = process.argv[2] as Target | undefined;
if (targetArg !== "arm64" && targetArg !== "x64") {
  throw new Error(
    `Usage: bun scripts/compile-worker.ts <arm64|x64>; got ${JSON.stringify(targetArg)}`,
  );
}
const target: Target = targetArg;

const archTag = target === "arm64" ? "linux-arm64" : "linux-x64";
const bunTarget = target === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
const addonFiles =
  target === "x64"
    ? [
        {
          variant: "baseline" as const,
          filename: "pi_natives.linux-x64-baseline.node",
        },
        {
          variant: "modern" as const,
          filename: "pi_natives.linux-x64-modern.node",
        },
      ]
    : [{ variant: "default" as const, filename: `pi_natives.${archTag}.node` }];

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const cache = resolve(root, `.cache/native-${archTag}`);
const packageDir = resolve(cache, "package");
const archivePath = resolve(cache, `embedded-addons.${archTag}.tar.gz`);
const embeddedModule = resolve(cache, "embedded-addon.ts");
const outfile = resolve(dist, `worker-linux-${target}`);
await mkdir(dist, { recursive: true });
await mkdir(cache, { recursive: true });

for (const file of addonFiles) {
  const addonPath = resolve(packageDir, file.filename);
  try {
    await stat(addonPath);
  } catch {
    const packed = Bun.spawnSync(
      [
        "npm",
        "pack",
        `@oh-my-pi/pi-natives-${archTag}@${OMP_VERSION}`,
        "--pack-destination",
        cache,
        "--silent",
      ],
      { cwd: root },
    );
    if (packed.exitCode !== 0)
      throw new Error(
        `Failed to download ${archTag} native addon: ${packed.stderr.toString()}`,
      );
    const tarball = resolve(cache, packed.stdout.toString().trim());
    await rm(packageDir, { recursive: true, force: true });
    const extracted = Bun.spawnSync(["tar", "-xzf", tarball, "-C", cache]);
    if (extracted.exitCode !== 0)
      throw new Error(
        `Failed to extract ${archTag} native addon: ${extracted.stderr.toString()}`,
      );
    // Re-check after extraction
    await stat(addonPath);
  }
}

const archiveEntries: Record<string, Uint8Array> = {};
const fileSpecs: string[] = [];
for (const file of addonFiles) {
  const addon = await readFile(resolve(packageDir, file.filename));
  archiveEntries[file.filename] = addon;
  fileSpecs.push(
    `{ variant: ${JSON.stringify(file.variant)}, filename: ${JSON.stringify(file.filename)}, size: ${addon.byteLength} }`,
  );
}
await Bun.write(
  archivePath,
  await new Bun.Archive(archiveEntries, { compress: "gzip", level: 9 }).bytes(),
);
await writeFile(
  embeddedModule,
  `import archivePath from ${JSON.stringify(archivePath)} with { type: "file" };\n` +
    `export const embeddedAddon = {\n` +
    `  platformTag: ${JSON.stringify(archTag)},\n` +
    `  version: ${JSON.stringify(OMP_VERSION)},\n` +
    `  archive: { format: "tar.gz", filename: ${JSON.stringify(basename(archivePath))}, filePath: archivePath },\n` +
    `  files: [${fileSpecs.join(", ")}],\n` +
    `};\n`,
);

const buildPlugin: Bun.BunPlugin = {
  name: "omp-ssh-remote:worker-modules",
  setup(build) {
    build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
      path: "omp-legacy-pi-modules",
      namespace: "omp-ssh-remote",
    }));
    build.onLoad(
      { filter: /^omp-legacy-pi-modules$/, namespace: "omp-ssh-remote" },
      () => ({
        contents: "export const BUNDLED_PI_MODULE_LOADERS = {};",
        loader: "js",
      }),
    );
    build.onResolve(
      { filter: /@oh-my-pi\/pi-natives\/native\/embedded-addon\.js$/ },
      () => ({
        path: embeddedModule,
      }),
    );
    build.onResolve(
      { filter: /^\.\/embedded-addon\.js$/, namespace: "file" },
      (args) => {
        if (
          args.importer.includes("@oh-my-pi/pi-natives/native/loader-state.js")
        )
          return { path: embeddedModule };
        return undefined;
      },
    );
  },
};

const result = await Bun.build({
  entrypoints: [resolve(root, "src/worker.ts")],
  root,
  plugins: [buildPlugin],
  define: { "process.env.PI_COMPILED": JSON.stringify("true") },
  compile: {
    target: bunTarget,
    outfile,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!result.success)
  throw new AggregateError(result.logs, `${target} worker compile failed`);
await chmod(outfile, 0o755);
const workerHash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(outfile).arrayBuffer())
  .digest("hex");
await writeFile(`${outfile}.sha256`, `${workerHash}\n`);
