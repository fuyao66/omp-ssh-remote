import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

/** Download only exact, pinned upstream archives; never invoke npm or lifecycle scripts. */
export async function downloadPinned(cache: string, url: string, filename: string, algorithm: "sha256" | "sha512", expected: string): Promise<string> {
  const path = resolve(cache, filename);
  let bytes: Uint8Array;
  try { bytes = await readFile(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    // A 30 MiB Node artifact at 64 KiB/s fits this bounded first-download budget.
    console.error(`Downloading ${filename} from ${new URL(url).host} (10 minute deadline)`);
    const started = performance.now();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64");
    if (actual !== expected) throw new Error(`Upstream checksum mismatch: ${filename}`);
    await writeFile(path, bytes, { mode: 0o600 });
    console.error(`Verified download ${filename}: ${bytes.byteLength} bytes in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  const actual = createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64");
  if (actual !== expected) throw new Error(`Cached upstream checksum mismatch: ${filename}`);
  console.error(`Verified cache ${filename}: ${bytes.byteLength} bytes`);
  return path;
}
