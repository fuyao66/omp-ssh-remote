import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { downloadPinned } from "./prepare-language-pack.ts";
import { PYTHON_LSP_PINS, type PythonLspArchitecture } from "../src/python-lsp-pack.ts";
import { LANGUAGE_PACK_ARCHIVE_SCRIPT } from "../src/language-pack-archive.ts";

const arch = process.argv[2] as PythonLspArchitecture;
if (arch !== "arm64" && arch !== "x64") throw new Error("Usage: bun scripts/prepare-python-lsp.ts arm64|x64");
const root = resolve(import.meta.dir, "..");
const cache = resolve(root, ".cache/language-pack-downloads");
const dist = resolve(root, "packages/omp/dist");
await mkdir(cache, { recursive: true });
await mkdir(dist, { recursive: true });

const nodeName = `node-v${PYTHON_LSP_PINS.node.version}-linux-${arch}.tar.xz`;
const nodeUrl = `https://nodejs.org/dist/v${PYTHON_LSP_PINS.node.version}/${nodeName}`;
const node = await downloadPinned(cache, nodeUrl, nodeName, "sha256", PYTHON_LSP_PINS.node.sha256[arch]);
const pyright = await downloadPinned(cache, PYTHON_LSP_PINS.pyright.url, `pyright-${PYTHON_LSP_PINS.pyright.version}.tgz`, "sha512", PYTHON_LSP_PINS.pyright.integrity.slice(7));
const provenance = {
  node: { version: PYTHON_LSP_PINS.node.version, url: nodeUrl, sha256: PYTHON_LSP_PINS.node.sha256[arch], checksums: PYTHON_LSP_PINS.node.checksums },
  pyright: PYTHON_LSP_PINS.pyright,
};
const result = Bun.spawnSync(["python3", "-c", LANGUAGE_PACK_ARCHIVE_SCRIPT, "prepare", node, pyright,
  resolve(dist, `python-lsp-linux-${arch}`), arch, JSON.stringify(provenance)], { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) throw new Error("Python LSP pack preparation failed");
