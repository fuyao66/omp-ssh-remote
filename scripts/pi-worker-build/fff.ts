import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type PiWorkerArch = "arm64" | "x64";

export type FffBuildArtifacts = {
  defines: Record<string, string>;
  version: string;
  packageName: "@ff-labs/pi-fff";
  libc: "gnu";
  binPackage: string;
  /** Absolute path to libfff_c.so used for embedding / diagnostics. */
  libPath: string;
  plugin?: Bun.BunPlugin;
};

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * FFF native embedding strategy:
 * - Worker compiles with Bun `--compile` and `FFF_LIBC='"gnu"'`.
 * - `@ff-labs/fff-bun` `embedded.ts` statically imports
 *   `@ff-labs/fff-bin-linux-${arch}-gnu/libfff_c.so` via `{ with: { type: "file" } }`,
 *   so Bun embeds the `.so` into `$bunfs` inside the worker binary.
 * - companionArtifacts remains [] — native addon is inside the worker binary.
 * - arm64 may be absent from platform node_modules; fall back to
 *   vendor/fff-linux-arm64-gnu extracted by Main, remapped via a Bun plugin so
 *   the embedded import still resolves.
 */
export async function prepareFffWorkerBuild(input: {
  root: string;
  target: PiWorkerArch;
}): Promise<FffBuildArtifacts> {
  const fffPackageDir = resolve(input.root, "node_modules/@ff-labs/pi-fff");
  const version = await packageVersion(resolve(fffPackageDir, "package.json"));
  const binPackage = `@ff-labs/fff-bin-linux-${input.target}-gnu`;
  const nodeModulesLib = resolve(
    input.root,
    "node_modules",
    binPackage,
    "libfff_c.so",
  );
  const vendorLib = resolve(
    input.root,
    `vendor/fff-linux-${input.target}-gnu/libfff_c.so`,
  );

  let libPath = nodeModulesLib;
  let plugin: Bun.BunPlugin | undefined;

  if (await pathExists(nodeModulesLib)) {
    libPath = nodeModulesLib;
  } else if (await pathExists(vendorLib)) {
    libPath = vendorLib;
    // Remap the platform package import used by fff-bun/embedded.ts onto the
    // vendor-extracted .so without patching node_modules.
    const filter = new RegExp(
      `^@ff-labs\\/fff-bin-linux-${input.target}-gnu(\\/libfff_c\\.so)?$`,
    );
    plugin = {
      name: "pi-ssh-remote:fff-vendor-bin",
      setup(build) {
        build.onResolve({ filter }, () => ({
          path: libPath,
          namespace: "file",
        }));
      },
    };
  } else {
    throw new Error(
      `FFF native library missing. Install ${binPackage} or provide vendor/fff-linux-${input.target}-gnu/libfff_c.so before compiling the Pi worker.`,
    );
  }

  if (
    !(await pathExists(
      resolve(input.root, "node_modules/@ff-labs/fff-bun/package.json"),
    ))
  ) {
    throw new Error(
      "FFF worker build requires @ff-labs/fff-bun in node_modules for the embedded import graph",
    );
  }
  const nativeResolver = plugin;
  plugin = {
    name: "pi-ssh-remote:fff-static-runtime",
    setup(build) {
      nativeResolver?.setup(build);
      build.onLoad({ filter: /[\\/]@ff-labs[\\/]pi-fff[\\/]src[\\/]sdk\.ts$/ }, () => ({
        contents: `import { FileFinder } from "@ff-labs/fff-bun"; export const SCAN_TIMEOUT_MS = 15000; export function loadSdk() { return Promise.resolve({ FileFinder }); }`,
        loader: "ts",
        resolveDir: resolve(input.root, "node_modules/@ff-labs/pi-fff/src"),
      }));
      build.onLoad({ filter: /[\\/]@ff-labs[\\/]fff-bun[\\/]src[\\/]embedded\.ts$/ }, () => ({
        contents: `import nativePath from ${JSON.stringify(libPath)} with { type: "file" }; export const embeddedLibPath = nativePath;`,
        loader: "ts",
        resolveDir: input.root,
      }));
    },
  };

  return {
    defines: {
      "process.env.PI_BUNDLED_FFF_VERSION": JSON.stringify(version),
      FFF_LIBC: JSON.stringify("gnu"),
    },
    version,
    packageName: "@ff-labs/pi-fff",
    libc: "gnu",
    binPackage,
    libPath,
    plugin,
  };
}
