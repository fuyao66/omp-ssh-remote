import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { downloadPinned } from "./prepare-language-pack.ts";
import { TYPESCRIPT_LSP_PINS as pins, type TypescriptLspArchitecture } from "../src/typescript-lsp-pack.ts";
import { LANGUAGE_PACK_ARCHIVE_SCRIPT } from "../src/language-pack-archive.ts";

const arch = process.argv[2] as TypescriptLspArchitecture;
if (arch !== "arm64" && arch !== "x64") throw new Error("Usage: bun scripts/prepare-typescript-lsp.ts arm64|x64");
const root = resolve(import.meta.dir, "..");
const cache = resolve(root, ".cache/language-pack-downloads");
const legacyCaches = [resolve(root, ".cache/python-lsp-downloads"), resolve(root, ".cache/typescript-lsp-downloads")];
const dist = resolve(root, "packages/omp/dist");
await mkdir(cache, { recursive: true });
await mkdir(dist, { recursive: true });
const nodeName = `node-v${pins.node.version}-linux-${arch}.tar.xz`;
const nodeUrl = `https://nodejs.org/dist/v${pins.node.version}/${nodeName}`;
const node = await downloadPinned(cache, nodeUrl, nodeName, "sha256", pins.node.sha256[arch], legacyCaches);
const server = await downloadPinned(cache, pins.server.url, `typescript-language-server-${pins.server.version}.tgz`, "sha512", pins.server.integrity.slice(7), legacyCaches);
const typescript = await downloadPinned(cache, pins.typescript.url, `typescript-${pins.typescript.version}.tgz`, "sha512", pins.typescript.integrity.slice(7), legacyCaches);
const provenance = {
  node: { version: pins.node.version, url: nodeUrl, sha256: pins.node.sha256[arch], checksums: pins.node.checksums },
  server: pins.server,
  typescript: pins.typescript,
};
const result = Bun.spawnSync(["python3", "-c", LANGUAGE_PACK_ARCHIVE_SCRIPT, "prepare-typescript", node, server, typescript,
  resolve(dist, `typescript-lsp-linux-${arch}`), arch, JSON.stringify(provenance)], { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) throw new Error("TypeScript LSP pack preparation failed");
