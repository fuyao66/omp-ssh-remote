import { copyFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PiWorkerArch = "arm64" | "x64";

export type AftBuildArtifacts = {
  plugin: Bun.BunPlugin;
  defines: Record<string, string>;
  version: string;
  packageName: "@cortexkit/aft-pi";
  copyCompanion: (distDir: string) => Promise<{ path: string; hashPath: string }>;
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

export async function prepareAftWorkerBuild(input: {
  root: string;
  target: PiWorkerArch;
}): Promise<AftBuildArtifacts> {
  const aftPackageDir = resolve(input.root, "node_modules/@cortexkit/aft-pi");
  const version = await packageVersion(resolve(aftPackageDir, "package.json"));
  const aftEntry = resolve(aftPackageDir, "dist/index.js");
  const aftSourceText = await readFile(aftEntry, "utf8");
  const patchedAftSource = aftSourceText.replace(
    /var PLUGIN_VERSION = \(\(\) => \{[\s\S]*?\}\)\(\);/,
    `var PLUGIN_VERSION = ${JSON.stringify(version)};`,
  );
  if (patchedAftSource === aftSourceText) {
    throw new Error(`Could not embed the resolved AFT version in ${aftEntry}`);
  }

  const aftSource = resolve(
    input.root,
    input.target === "arm64"
      ? "vendor/aft-arm64/bin/aft"
      : "vendor/aft/bin/aft",
  );

  const plugin: Bun.BunPlugin = {
    name: "pi-ssh-remote:aft-runtime",
    setup(build) {
      build.onResolve({ filter: /^@cortexkit\/aft-pi$/ }, () => ({
        path: aftEntry,
        namespace: "pi-ssh-remote-aft",
      }));
      build.onLoad({ filter: /.*/, namespace: "pi-ssh-remote-aft" }, () => ({
        contents: patchedAftSource,
        loader: "js",
        resolveDir: dirname(aftEntry),
      }));
    },
  };

  return {
    plugin,
    defines: {
      "process.env.PI_BUNDLED_AFT_VERSION": JSON.stringify(version),
    },
    version,
    packageName: "@cortexkit/aft-pi",
    async copyCompanion(distDir) {
      const outfile = resolve(distDir, `aft-linux-${input.target}`);
      await copyFile(aftSource, outfile);
      return { path: outfile, hashPath: `${outfile}.sha256` };
    },
  };
}
