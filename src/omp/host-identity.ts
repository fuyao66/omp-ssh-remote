import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../protocol.ts";

const OMP_HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";

async function readPackageVersion(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    ) as unknown;
    if (!isRecord(manifest)) return undefined;
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

async function sourceDirectory(path: string): Promise<string | undefined> {
  if (!path || path.startsWith("<")) return undefined;
  try {
    return (await stat(path)).isDirectory() ? path : dirname(path);
  } catch {
    return dirname(path);
  }
}

async function packageVersionFromEntry(
  entry: string,
): Promise<string | undefined> {
  let current = await sourceDirectory(entry);
  while (current) {
    try {
      const manifest = JSON.parse(
        await readFile(join(current, "package.json"), "utf8"),
      ) as unknown;
      if (
        isRecord(manifest) &&
        manifest.name === OMP_HOST_PACKAGE &&
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

function packageVersionFromRequire(from: string): string | undefined {
  try {
    const req = createRequire(from);
    const manifest = req(`${OMP_HOST_PACKAGE}/package.json`) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

function versionFromOmpCli(): string | undefined {
  try {
    const result = Bun.spawnSync(["omp", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = `${result.stdout.toString()}${result.stderr.toString()}`;
    return /omp\/(\d+\.\d+\.\d+)/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

export function ompCompiledHostVersion(): string | undefined {
  const compiled = process.env.OMP_COMPILED_HOST_VERSION;
  return compiled && compiled !== "undefined" ? compiled : undefined;
}

export type OmpHostCompatibility = {
  /** Version of the OMP host currently running this extension (live import). */
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

export async function resolveOmpHostVersion(): Promise<string> {
  const compiled = ompCompiledHostVersion();
  if (compiled) return compiled;

  const cliVersion = versionFromOmpCli();
  if (cliVersion) return cliVersion;

  const requireCandidates = [
    process.execPath,
    typeof Bun !== "undefined" && typeof Bun.main === "string" ? Bun.main : undefined,
    process.argv[1],
    join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/package.json"),
    join(process.cwd(), "package.json"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of requireCandidates) {
    const version = packageVersionFromRequire(candidate);
    if (version) return version;
  }

  try {
    const resolved = import.meta.resolve(OMP_HOST_PACKAGE);
    const entry = resolved.startsWith("file:")
      ? fileURLToPath(resolved)
      : resolved;
    const version = await packageVersionFromEntry(entry);
    if (version) return version;
  } catch {}

  const fallbackDirs = [
    join(process.cwd(), "node_modules", OMP_HOST_PACKAGE),
    join(homedir(), ".bun/install/global/node_modules", OMP_HOST_PACKAGE),
  ];
  for (const dir of fallbackDirs) {
    const fallback = await readPackageVersion(dir);
    if (fallback) return fallback;
  }
  throw new Error(
    `Could not resolve the installed version of ${OMP_HOST_PACKAGE}`,
  );
}
