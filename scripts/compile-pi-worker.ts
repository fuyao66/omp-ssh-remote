import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const AFT_VERSION = "0.51.2";

type Target = "arm64" | "x64";

const targetArg = process.argv[2] as Target | undefined;
if (targetArg !== "arm64" && targetArg !== "x64") {
  throw new Error("Usage: bun scripts/compile-pi-worker.ts <arm64|x64>");
}
const target: Target = targetArg;
const bunTarget = target === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "packages/pi/dist");
const outfile = resolve(dist, `worker-linux-${target}`);
const aftSource = resolve(
  root,
  target === "arm64" ? "vendor/aft-arm64/bin/aft" : "vendor/aft/bin/aft",
);
const aftOutfile = resolve(dist, `aft-linux-${target}`);
await mkdir(dist, { recursive: true });

const aftEntry = resolve(root, "node_modules/@cortexkit/aft-pi/dist/index.js");
const aftSourceText = await readFile(aftEntry, "utf8");
const patchedAftSource = aftSourceText.replace(
  /var PLUGIN_VERSION = \(\(\) => \{[\s\S]*?\}\)\(\);/,
  `var PLUGIN_VERSION = ${JSON.stringify(AFT_VERSION)};`,
);
if (patchedAftSource === aftSourceText) {
  throw new Error(`Could not lock AFT plugin version in ${aftEntry}`);
}
console.log(`Compiling Pi + AFT worker for ${target}...`);

const aftBundlePlugin: Bun.BunPlugin = {
  name: "pi-ssh-remote:aft-version-lock",
  setup(build) {
    build.onResolve({ filter: /^@cortexkit\/aft-pi$/ }, () => ({
      path: aftEntry,
      namespace: "pi-ssh-remote-aft",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "pi-ssh-remote-aft" },
      () => ({
        contents: patchedAftSource,
        loader: "js",
        resolveDir: dirname(aftEntry),
      }),
    );
  },
};
const result = await Bun.build({
  entrypoints: [resolve(root, "src/pi-worker.ts")],
  define: { "process.env.PI_COMPILED": JSON.stringify("true") },
  plugins: [aftBundlePlugin],
  compile: {
    target: bunTarget,
    outfile,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  minify: false,
});
if (!result.success) {
  throw new AggregateError(result.logs, `Pi ${target} worker compile failed`);
}

await copyFile(aftSource, aftOutfile);
await Promise.all([chmod(outfile, 0o755), chmod(aftOutfile, 0o755)]);

async function writeHash(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
  await writeFile(`${path}.sha256`, `${hash}\n`);
  return hash;
}

const [workerHash, aftHash] = await Promise.all([
  writeHash(outfile),
  writeHash(aftOutfile),
]);
console.log(
  `Pi ${target} worker: ${outfile} (${workerHash}); AFT: ${aftOutfile} (${aftHash})`,
);
