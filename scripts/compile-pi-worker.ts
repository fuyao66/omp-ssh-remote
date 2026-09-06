import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareAftWorkerBuild } from "./pi-worker-build/aft.ts";
import { prepareFffWorkerBuild } from "./pi-worker-build/fff.ts";

import { rtkBundlePlugin } from "./pi-worker-build/rtk.ts";

type Target = "arm64" | "x64";

const AFT_PLUGIN_ID = "@cortexkit/aft-pi";
const FFF_PLUGIN_ID = "@ff-labs/pi-fff";
const RTK_PLUGIN_ID = "pi-rtk-optimizer";
const KNOWN_PLUGINS = new Set([AFT_PLUGIN_ID, FFF_PLUGIN_ID, RTK_PLUGIN_ID]);

const targetArg = process.argv[2] as Target | undefined;
if (targetArg !== "arm64" && targetArg !== "x64") {
  throw new Error(
    "Usage: bun scripts/compile-pi-worker.ts <arm64|x64> [--plugins=none|aft,fff|...]",
  );
}
const target: Target = targetArg;
const bunTarget = target === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";

function parseSelectedPlugins(argv: string[]): string[] {
  const fromEnv = process.env.PI_WORKER_PLUGINS;
  const flag = argv.find((arg) => arg.startsWith("--plugins="));
  const raw = flag ? flag.slice("--plugins=".length) : fromEnv;
  if (raw === undefined || raw === "" || raw === "all") {
    return [AFT_PLUGIN_ID, FFF_PLUGIN_ID, RTK_PLUGIN_ID];
  }
  if (raw === "none" || raw === "core") return [];
  const selected: string[] = [];
  for (const token of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (token === "aft") selected.push(AFT_PLUGIN_ID);
    else if (token === "fff") selected.push(FFF_PLUGIN_ID);
    else if (token === "rtk") selected.push(RTK_PLUGIN_ID);
    else if (KNOWN_PLUGINS.has(token)) selected.push(token);
    else {
      throw new Error(
        `Unknown Pi worker plugin '${token}'. Expected aft, fff, rtk, none, or package ids.`,
      );
    }
  }
  return [...new Set(selected)];
}

const selectedPlugins = parseSelectedPlugins(process.argv.slice(3));
const withAft = selectedPlugins.includes(AFT_PLUGIN_ID);
const withFff = selectedPlugins.includes(FFF_PLUGIN_ID);
const withRtk = selectedPlugins.includes(RTK_PLUGIN_ID);

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "packages/pi/dist");
const outfile = resolve(dist, `worker-linux-${target}`);
await mkdir(dist, { recursive: true });

async function packageVersion(path: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`Package manifest has no version: ${path}`);
  }
  return manifest.version;
}

async function writeHash(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
  await writeFile(`${path}.sha256`, `${hash}\n`);
  return hash;
}

const piPackageDir = resolve(
  root,
  "node_modules/@earendil-works/pi-coding-agent",
);
const piVersion = await packageVersion(resolve(piPackageDir, "package.json"));

const plugins: Bun.BunPlugin[] = [];
const defines: Record<string, string> = {
  "process.env.PI_COMPILED": JSON.stringify("true"),
  "process.env.PI_BUNDLED_HOST_VERSION": JSON.stringify(piVersion),
};
const companionPaths: string[] = [];
const versions: string[] = [`Pi ${piVersion}`];

if (withAft) {
  const aft = await prepareAftWorkerBuild({ root, target });
  plugins.push(aft.plugin);
  Object.assign(defines, aft.defines);
  versions.push(`AFT ${aft.version}`);
  const companion = await aft.copyCompanion(dist);
  companionPaths.push(companion.path);
} else {
  await rm(resolve(dist, `aft-linux-${target}`), { force: true });
  await rm(resolve(dist, `aft-linux-${target}.sha256`), { force: true });
}

if (withFff) {
  const fff = await prepareFffWorkerBuild({ root, target });
  Object.assign(defines, fff.defines);
  if (fff.plugin) plugins.push(fff.plugin);
  versions.push(`FFF ${fff.version} (${fff.binPackage}; lib=${fff.libPath})`);
}

if (withRtk) {
  const rtkVersion = await packageVersion(resolve(root, "node_modules/pi-rtk-optimizer/package.json"));
  defines["process.env.PI_BUNDLED_RTK_VERSION"] = JSON.stringify(rtkVersion);
  defines["process.env.PI_RTK_BUNDLED"] = JSON.stringify("true");
  plugins.push(rtkBundlePlugin);
  versions.push(`RTK ${rtkVersion}`);
}

function registrySource(selected: string[]): string {
  const imports: string[] = [];
  const creators: string[] = [];
  if (selected.includes(AFT_PLUGIN_ID)) {
    imports.push(
      `import { createAftWorkerPluginAdapter } from "./plugins/aft-worker.ts";`,
    );
    creators.push("createAftWorkerPluginAdapter()");
  }
  if (selected.includes(FFF_PLUGIN_ID)) {
    imports.push(
      `import { createFffWorkerPluginAdapter } from "./plugins/fff-worker.ts";`,
    );
    creators.push("createFffWorkerPluginAdapter()");
  }
  if (selected.includes(RTK_PLUGIN_ID)) {
    imports.push(
      `import { createRtkWorkerPluginAdapter } from "./plugins/rtk-worker.ts";`,
    );
    creators.push("createRtkWorkerPluginAdapter()");
  }
  return `${imports.join("\n")}
import type { PiWorkerPluginAdapter } from "./worker-plugins.ts";

export const PI_WORKER_PLUGIN_ADAPTERS: readonly PiWorkerPluginAdapter[] = [
  ${creators.join(",\n  ")}
];
`;
}

const registryPlugin: Bun.BunPlugin = {
  name: "pi-ssh-remote:worker-plugin-registry",
  setup(build) {
    build.onResolve({ filter: /worker-plugin-registry\.ts$/ }, (args) => {
      if (!args.path.includes("worker-plugin-registry")) return null;
      return {
        path: resolve(root, "src/pi/worker-plugin-registry.ts"),
        namespace: "pi-ssh-remote-worker-registry",
      };
    });
    build.onLoad(
      { filter: /.*/, namespace: "pi-ssh-remote-worker-registry" },
      () => ({
        contents: registrySource(selectedPlugins),
        loader: "ts",
        resolveDir: resolve(root, "src/pi"),
      }),
    );
  },
};
plugins.push(registryPlugin);

console.log(
  `Compiling composable Pi worker for ${target} (${versions.join(", ")}; plugins=${selectedPlugins.length === 0 ? "none" : selectedPlugins.join(",")})...`,
);

const result = await Bun.build({
  entrypoints: [resolve(root, "src/pi-worker.ts")],
  define: defines,
  plugins,
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

await chmod(outfile, 0o755);
for (const companion of companionPaths) {
  await chmod(companion, 0o755);
}

const hashes = await Promise.all([
  writeHash(outfile),
  ...companionPaths.map((path) => writeHash(path)),
]);
console.log(
  `Pi ${target} worker: ${outfile} (${hashes[0]})${
    companionPaths.length > 0
      ? `; companions: ${companionPaths
          .map((path, index) => `${path} (${hashes[index + 1]})`)
          .join(", ")}`
      : ""
  }`,
);
