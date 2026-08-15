import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { OMP_VERSION } from "../src/protocol.ts";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const cache = resolve(root, ".cache/native-arm64");
const packageDir = resolve(cache, "package");
const addonFilename = "pi_natives.linux-arm64.node";
const addonPath = resolve(packageDir, addonFilename);
const archivePath = resolve(cache, "embedded-addons.linux-arm64.tar.gz");
const embeddedModule = resolve(cache, "embedded-addon.ts");
const outfile = resolve(dist, "worker-linux-arm64");
await mkdir(dist, { recursive: true });
await mkdir(cache, { recursive: true });

try {
  await stat(addonPath);
} catch {
  const packed = Bun.spawnSync(
    [
      "npm",
      "pack",
      `@oh-my-pi/pi-natives-linux-arm64@${OMP_VERSION}`,
      "--pack-destination",
      cache,
      "--silent",
    ],
    { cwd: root },
  );
  if (packed.exitCode !== 0)
    throw new Error(
      `Failed to download ARM64 native addon: ${packed.stderr.toString()}`,
    );
  const tarball = resolve(cache, packed.stdout.toString().trim());
  await rm(packageDir, { recursive: true, force: true });
  const extracted = Bun.spawnSync(["tar", "-xzf", tarball, "-C", cache]);
  if (extracted.exitCode !== 0)
    throw new Error(
      `Failed to extract ARM64 native addon: ${extracted.stderr.toString()}`,
    );
}

const addon = await readFile(addonPath);
await Bun.write(
  archivePath,
  await new Bun.Archive(
    { [addonFilename]: addon },
    { compress: "gzip", level: 9 },
  ).bytes(),
);
await writeFile(
  embeddedModule,
  `import archivePath from ${JSON.stringify(archivePath)} with { type: "file" };\n` +
    `export const embeddedAddon = {\n` +
    `  platformTag: "linux-arm64",\n` +
    `  version: ${JSON.stringify(OMP_VERSION)},\n` +
    `  archive: { format: "tar.gz", filename: ${JSON.stringify(basename(archivePath))}, filePath: archivePath },\n` +
    `  files: [{ variant: "default", filename: ${JSON.stringify(addonFilename)}, size: ${addon.byteLength} }],\n` +
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
    target: "bun-linux-arm64",
    outfile,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!result.success)
  throw new AggregateError(result.logs, "ARM64 worker compile failed");
await chmod(outfile, 0o755);
const workerHash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(outfile).arrayBuffer())
  .digest("hex");
await writeFile(`${outfile}.sha256`, `${workerHash}\n`);
