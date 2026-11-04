import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adaptNativeLspConfig } from "../src/native-lsp-config-adapter.ts";
import { adaptNativeMutationSettlement } from "../src/omp/native-mutation-adapter.ts";
import { SDK_SOURCE_ADAPTATIONS, assertSdkBuildAdaptations, sdkAdaptationLabel } from "../src/omp/sdk-contract.ts";
import {
  resolveOmpBuildVersion,
  resolveOmpNativeBuildVersion,
  validateOmpNativeAddonPackage,
} from "../src/omp/host-identity.ts";

type Target = "arm64" | "x64";

const targetArg = process.argv[2] as Target | undefined;
if (targetArg !== "arm64" && targetArg !== "x64") {
  throw new Error(
    `Usage: bun scripts/compile-worker.ts <arm64|x64>; got ${JSON.stringify(targetArg)}`,
  );
}
const target: Target = targetArg;

const root = resolve(import.meta.dir, "..");
const hostVersion = await resolveOmpBuildVersion(root);
const nativeVersion = await resolveOmpNativeBuildVersion(root);
const archTag = target === "arm64" ? "linux-arm64" : "linux-x64";
const bunTarget = target === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
const addonFiles =
  target === "x64"
    ? [
        {
          variant: "modern" as const,
          filename: `pi_natives.${archTag}-modern.node`,
        },
        {
          variant: "baseline" as const,
          filename: `pi_natives.${archTag}-baseline.node`,
        },
      ]
    : [{ variant: "default" as const, filename: `pi_natives.${archTag}.node` }];

const cache = resolve(root, `.cache/native-${archTag}`, nativeVersion);
const packageDir = resolve(cache, "package");
const embeddedModule = resolve(cache, "embedded-addon.ts");
const dist = resolve(root, "packages/omp/dist");
const outfile = resolve(dist, `worker-linux-${target}`);
await mkdir(dist, { recursive: true });
await mkdir(cache, { recursive: true });
async function verifyAddonPackage(): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
  validateOmpNativeAddonPackage(manifest, archTag, nativeVersion);
}

for (const file of addonFiles) {
  const addonPath = resolve(packageDir, file.filename);
  try {
    await verifyAddonPackage();
    await stat(addonPath);
  } catch {
    const packed = Bun.spawnSync(
      [
        "npm",
        "pack",
        `@oh-my-pi/pi-natives-${archTag}@${nativeVersion}`,
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
    await verifyAddonPackage();
    await stat(addonPath);
  }
}

const imports: string[] = [];
const fileSpecs: string[] = [];
for (const [index, file] of addonFiles.entries()) {
  const addon = await readFile(resolve(packageDir, file.filename));
  const zstdPath = resolve(cache, `${file.filename}.zst`);
  await Bun.write(zstdPath, Bun.zstdCompressSync(addon));
  imports.push(`import zstdPath${index} from ${JSON.stringify(zstdPath)} with { type: "file" };`);
  fileSpecs.push(
    `{ variant: ${JSON.stringify(file.variant)}, filename: ${JSON.stringify(file.filename)}, size: ${addon.byteLength}, zstdPath: zstdPath${index} }`,
  );
}
await writeFile(
  embeddedModule,
  `${imports.join("\n")}\n` +
    `export const embeddedAddon = {\n` +
    `  platformTag: ${JSON.stringify(archTag)},\n` +
    `  version: ${JSON.stringify(nativeVersion)},\n` +
    `  files: [${fileSpecs.join(", ")}],\n` +
    `};\n`,
);

const adaptedModules = new Map<string, number>();
const adaptationPaths = new Map(SDK_SOURCE_ADAPTATIONS.map(adaptation => {
  try {
    return [Bun.resolveSync(adaptation.sdkModule, root), adaptation] as const;
  } catch (error) {
    throw new Error(`${sdkAdaptationLabel(adaptation)} cannot resolve installed source; run bun run check:sdk before compiling`, { cause: error });
  }
}));
const buildPlugin: Bun.BunPlugin = {
  name: "omp-ssh-remote:worker-modules",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async args => {
      const adaptation = adaptationPaths.get(args.path);
      if (!adaptation) return undefined;
      const count = (adaptedModules.get(adaptation.id) ?? 0) + 1;
      if (count > adaptation.expectedBuildCount) throw new Error(`Duplicate SDK adaptation: ${sdkAdaptationLabel(adaptation)}`);
      const source = await readFile(args.path, "utf8");
      const contents = adaptation.kind === "lsp-config"
        ? adaptNativeLspConfig(source, hostVersion, resolve(root, "src/python-lsp-fallback.ts"))
        : adaptNativeMutationSettlement(source, hostVersion, adaptation.module, resolve(root, "src/omp/mutation-settlement.ts"));
      adaptedModules.set(adaptation.id, count);
      return { contents, loader: "ts" };
    });
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
  define: {
    "process.env.PI_COMPILED": JSON.stringify("true"),
    "process.env.OMP_COMPILED_HOST_VERSION": JSON.stringify(hostVersion),
  },
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
assertSdkBuildAdaptations(adaptedModules);
await chmod(outfile, 0o755);
const workerHash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(outfile).arrayBuffer())
  .digest("hex");
await writeFile(`${outfile}.sha256`, `${workerHash}\n`);
