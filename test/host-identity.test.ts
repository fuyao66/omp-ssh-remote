import { describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOmpBuildVersion,
  resolveOmpNativeBuildVersion,
  resolveOmpHostVersion,
  validateOmpNativeAddonPackage,
} from "../src/omp/host-identity.ts";

async function sourcePackage(root: string, name: string, version: string): Promise<string> {
  const directory = join(root, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.ts" }));
  await writeFile(join(directory, "index.ts"), "export {};\n");
  return join(directory, "index.ts");
}

async function cli(path: string, version: string, marker?: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${marker ? `touch '${marker}'\n` : ""}printf 'omp/${version}\\n'\n`);
  await chmod(path, 0o755);
}

describe("OMP source and live host identity", () => {
  test("build dependencies ignore a different PATH CLI and compiled pin; live identity follows actual host", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-host-identity-"));
    try {
      const buildRoot = join(root, "build");
      await sourcePackage(buildRoot, "@oh-my-pi/pi-coding-agent", "18.12.6");
      await sourcePackage(buildRoot, "@oh-my-pi/pi-natives", "18.12.6");
      const sourceEntry = await sourcePackage(join(root, "host"), "@oh-my-pi/pi-coding-agent", "18.13.0");
      const linkedEntry = join(root, "host-entry");
      await symlink(sourceEntry, linkedEntry);
      const bin = join(root, "bin");
      await mkdir(bin);
      const marker = join(root, "path-cli-was-run");
      await cli(join(bin, "omp"), "99.0.0", marker);
      const actualHost = join(root, "renamed-host");
      await cli(actualHost, "18.14.0");
      const script = `
        import { resolveOmpBuildVersion, resolveOmpNativeBuildVersion, resolveOmpHostVersion } from ${JSON.stringify(join(import.meta.dir, "../src/omp/host-identity.ts"))};
        console.log(JSON.stringify({
          build: await resolveOmpBuildVersion(${JSON.stringify(buildRoot)}),
          native: await resolveOmpNativeBuildVersion(${JSON.stringify(buildRoot)}),
          source: await resolveOmpHostVersion({ entrypoints: [${JSON.stringify(linkedEntry)}], executable: ${JSON.stringify(actualHost)} }),
          compiled: await resolveOmpHostVersion({ entrypoints: ["/$bunfs/root/cli.js"], executable: ${JSON.stringify(actualHost)} }),
        }));`;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OMP_COMPILED_HOST_VERSION: "88.0.0" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ build: "18.12.6", native: "18.12.6", source: "18.13.0", compiled: "18.14.0" });
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects native wrapper/source version drift before downloading an addon", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-native-drift-"));
    try {
      await sourcePackage(root, "@oh-my-pi/pi-coding-agent", "18.12.6");
      await sourcePackage(root, "@oh-my-pi/pi-natives", "18.12.5");
      expect(await resolveOmpBuildVersion(root)).toBe("18.12.6");
      await expect(resolveOmpNativeBuildVersion(root)).rejects.toThrow(/source=18\.12\.6, pi-natives=18\.12\.5/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unknown running host identity cannot fall back to the source dependency or Bun's version", async () => {
    await expect(resolveOmpHostVersion({ entrypoints: [], executable: process.execPath })).rejects.toThrow(/Could not resolve the running OMP version/);
  });

  test("cached and downloaded addon manifests must match both platform and source version", () => {
    const manifest = { name: "@oh-my-pi/pi-natives-linux-x64", version: "18.12.6" };
    expect(() => validateOmpNativeAddonPackage(manifest, "linux-x64", "18.12.6")).not.toThrow();
    for (const invalid of [
      { ...manifest, version: "18.12.5" },
      { ...manifest, name: "@oh-my-pi/pi-natives-linux-arm64" },
      {}, null,
    ]) {
      expect(() => validateOmpNativeAddonPackage(invalid, "linux-x64", "18.12.6")).toThrow(/must be @oh-my-pi\/pi-natives-linux-x64@18\.12\.6/);
    }
  });
});
