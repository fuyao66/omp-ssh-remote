import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../protocol.ts";

const OMP_HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";


async function sourceDirectory(path: string): Promise<string | undefined> {
  if (!path || path.startsWith("<") || path.includes("$bunfs")) return undefined;
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : dirname(canonical);
  } catch {
    return dirname(path);
  }
}

async function packageVersionFromEntry(
  entry: string,
  packageName = OMP_HOST_PACKAGE,
): Promise<string | undefined> {
  let current = await sourceDirectory(entry);
  while (current) {
    try {
      const manifest = JSON.parse(
        await readFile(join(current, "package.json"), "utf8"),
      ) as unknown;
      if (
        isRecord(manifest) &&
        manifest.name === packageName &&
        typeof manifest.version === "string" &&
        manifest.version
      ) {
        return manifest.version;
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** Resolve the same source package that Bun's build will import, never a PATH CLI. */
export async function resolveOmpBuildVersion(
  fromDirectory = resolve(import.meta.dir, "../.."),
): Promise<string> {
  const entry = Bun.resolveSync(OMP_HOST_PACKAGE, fromDirectory);
  const version = await packageVersionFromEntry(entry);
  if (!version) throw new Error(`Could not resolve build dependency ${OMP_HOST_PACKAGE} from ${entry}`);
  return version;
}

/** The native wrapper and downloaded platform addon must use the source runtime's release. */
export async function resolveOmpNativeBuildVersion(
  fromDirectory = resolve(import.meta.dir, "../.."),
): Promise<string> {
  const agentEntry = Bun.resolveSync(OMP_HOST_PACKAGE, fromDirectory);
  const nativeEntry = Bun.resolveSync("@oh-my-pi/pi-natives", dirname(agentEntry));
  const hostVersion = await resolveOmpBuildVersion(fromDirectory);
  const nativeVersion = await packageVersionFromEntry(nativeEntry, "@oh-my-pi/pi-natives");
  if (nativeVersion !== hostVersion) {
    throw new Error(`OMP native dependency version mismatch: source=${hostVersion}, pi-natives=${nativeVersion ?? "unknown"}; install matching OMP dependencies before compiling workers`);
  }
  return nativeVersion;
}

/** Validate both freshly downloaded and cached platform addon manifests. */
export function validateOmpNativeAddonPackage(manifest: unknown, archTag: string, version: string): void {
  const name = `@oh-my-pi/pi-natives-${archTag}`;
  if (!isRecord(manifest) || manifest.name !== name || manifest.version !== version) {
    throw new Error(`Native addon package must be ${name}@${version}; got ${isRecord(manifest) ? `${manifest.name}@${manifest.version}` : "invalid manifest"}`);
  }
}

export function ompCompiledHostVersion(): string | undefined {
  const compiled = process.env.OMP_COMPILED_HOST_VERSION;
  return compiled && compiled !== "undefined" ? compiled : undefined;
}

export type OmpHostCompatibility = {
  /** Version of the actual running OMP entry/executable, not a bundled utility. */
  installedHostVersion: string | undefined;
  /** OMP version the plugin bundle and companion workers were compiled against. */
  compiledHostVersion: string | undefined;
  /** True only when both versions are known and equal. */
  compatible: boolean;
  /** Human-readable remediation when the versions differ or are unknown. */
  advice: string | undefined;
};

/**
 * Compare the running host's version against the version the plugin was
 * built for. The companion worker is a native OMP runtime compiled at plugin
 * build time, so a host upgrade without a rebuild is the single most common
 * cause of `schema is incompatible` handshake rejections. Detecting it at
 * session start turns a mid-connect failure into an actionable notice.
 */
export function ompHostCompatibility(
  installedHostVersion: string | undefined,
  compiledHostVersion: string | undefined = ompCompiledHostVersion(),
): OmpHostCompatibility {
  const compatible =
    installedHostVersion !== undefined &&
    compiledHostVersion !== undefined &&
    installedHostVersion === compiledHostVersion;
  let advice: string | undefined;
  if (!compatible) {
    if (installedHostVersion === undefined) {
      advice = "Could not determine the running OMP version; the remote handshake will still verify tool schemas.";
    } else if (compiledHostVersion === undefined) {
      advice = `omp-ssh-remote was not built with a pinned OMP version; the running host is ${installedHostVersion}. Rebuild the plugin (bun run build && bun run build:worker:all).`;
    } else {
      advice = `omp-ssh-remote was built for OMP ${compiledHostVersion} but the running host is ${installedHostVersion}. Update the plugin's pinned OMP dependencies to ${installedHostVersion}, run bun run build && bun run build:worker:all, then reload the extension and reconnect.`;
    }
  }
  return { installedHostVersion, compiledHostVersion, compatible, advice };
}

export interface OmpHostVersionOptions {
  /** Actual host launch paths; injectable for source/compiled host regression tests. */
  entrypoints?: readonly string[];
  executable?: string;
}

/**
 * Resolve the running process, not `omp` on PATH or this extension's dependencies.
 * A compiled host has no on-disk source package: query that exact executable.
 */
export async function resolveOmpHostVersion(options: OmpHostVersionOptions = {}): Promise<string> {
  const entrypoints = options.entrypoints ?? [
    typeof Bun !== "undefined" && typeof Bun.main === "string" ? Bun.main : "",
    process.argv[1] ?? "",
    process.execPath,
  ];
  for (const entry of entrypoints) {
    const version = await packageVersionFromEntry(entry);
    if (version) return version;
  }
  const executable = options.executable ?? process.execPath;
  try {
    const result = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      const version = /(?:^|\n)omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(result.stdout.toString().trim())?.[1];
      if (version) return version;
    }
  } catch {}
  throw new Error(`Could not resolve the running OMP version from its entrypoints or executable ${executable}`);
}
