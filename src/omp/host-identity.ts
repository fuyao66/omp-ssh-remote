import { readFile, stat } from "node:fs/promises";
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

export function ompCompiledHostVersion(): string | undefined {
  const compiled = process.env.OMP_COMPILED_HOST_VERSION;
  return compiled && compiled !== "undefined" ? compiled : undefined;
}

export async function resolveOmpHostVersion(): Promise<string> {
  const compiled = ompCompiledHostVersion();
  if (compiled) return compiled;
  try {
    const resolved = import.meta.resolve(OMP_HOST_PACKAGE);
    const entry = resolved.startsWith("file:")
      ? fileURLToPath(resolved)
      : resolved;
    const version = await packageVersionFromEntry(entry);
    if (version) return version;
  } catch {}
  const fallback = await readPackageVersion(
    join(process.cwd(), "node_modules", OMP_HOST_PACKAGE),
  );
  if (fallback) return fallback;
  throw new Error(
    `Could not resolve the installed version of ${OMP_HOST_PACKAGE}`,
  );
}
