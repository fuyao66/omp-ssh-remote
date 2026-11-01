import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { PYTHON_LSP_PINS, type PythonLspArchitecture } from "../src/python-lsp-pack.ts";
import { PYTHON_LSP_ARCHIVE_SCRIPT } from "../src/python-lsp-archive.ts";

const arch = process.argv[2] as PythonLspArchitecture;
if (arch !== "arm64" && arch !== "x64") throw new Error("Usage: bun scripts/prepare-python-lsp.ts arm64|x64");
const root = resolve(import.meta.dir, "..");
const cache = resolve(root, ".cache/python-lsp-downloads");
const dist = resolve(root, "packages/omp/dist");
await mkdir(cache, { recursive: true });
await mkdir(dist, { recursive: true });

async function download(url: string, filename: string, algorithm: "sha256" | "sha512", expected: string): Promise<string> {
  const path = resolve(cache, filename);
  let bytes: Uint8Array;
  try { bytes = await readFile(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64");
    if (actual !== expected) throw new Error(`Upstream checksum mismatch: ${filename}`);
    await writeFile(path, bytes, { mode: 0o600 });
  }
  const actual = createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64");
  if (actual !== expected) throw new Error(`Cached upstream checksum mismatch: ${filename}`);
  return path;
}
const nodeName = `node-v${PYTHON_LSP_PINS.node.version}-linux-${arch}.tar.xz`;
const nodeUrl = `https://nodejs.org/dist/v${PYTHON_LSP_PINS.node.version}/${nodeName}`;
const node = await download(nodeUrl, nodeName, "sha256", PYTHON_LSP_PINS.node.sha256[arch]);
const pyright = await download(PYTHON_LSP_PINS.pyright.url, `pyright-${PYTHON_LSP_PINS.pyright.version}.tgz`, "sha512", PYTHON_LSP_PINS.pyright.integrity.slice(7));
const provenance = {
  node: { version: PYTHON_LSP_PINS.node.version, url: nodeUrl, sha256: PYTHON_LSP_PINS.node.sha256[arch], checksums: PYTHON_LSP_PINS.node.checksums },
  pyright: PYTHON_LSP_PINS.pyright,
};
const result = Bun.spawnSync(["python3", "-c", PYTHON_LSP_ARCHIVE_SCRIPT, "prepare", node, pyright,
  resolve(dist, `python-lsp-linux-${arch}`), arch, JSON.stringify(provenance)], { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) throw new Error("Python LSP pack preparation failed");
