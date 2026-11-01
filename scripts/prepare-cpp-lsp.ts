import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { downloadPinned } from "./prepare-language-pack.ts";
import { CPP_LSP_PINS as pins } from "../src/cpp-lsp-pack.ts";
import { LANGUAGE_PACK_ARCHIVE_SCRIPT } from "../src/language-pack-archive.ts";

const arch = process.argv[2];
if (arch !== "arm64" && arch !== "x64") throw new Error("Usage: bun scripts/prepare-cpp-lsp.ts arm64|x64");
const root = resolve(import.meta.dir, "..");
const cache = resolve(root, ".cache/language-pack-downloads");
const dist = resolve(root, "packages/omp/dist");
await mkdir(cache, { recursive: true });
await mkdir(dist, { recursive: true });
const work = await mkdtemp(resolve(tmpdir(), "cpp-lsp-"));
try {
  const sources = [];
  for (const source of pins.sources[arch]) {
    const archive = await downloadPinned(cache, source.url, source.url.split("/").at(-1)!, "sha256", source.sha256);
    sources.push({ ...source, archive });
  }
  const inventory = resolve(work, "sources.json");
  await writeFile(inventory, JSON.stringify(sources));
  const pack = resolve(work, "pack");
  const prepare = Bun.spawnSync(["python3", resolve(import.meta.dir, "prepare-cpp-payload.py"), inventory, pack, arch], { stdout: "inherit", stderr: "inherit" });
  if (prepare.exitCode !== 0) throw new Error("C/C++ payload preparation failed");
  const provenance = { ...pins, sources: pins.sources[arch] };
  const result = Bun.spawnSync(["python3", "-c", LANGUAGE_PACK_ARCHIVE_SCRIPT, "prepare-cpp-directory", pack,
    resolve(dist, `cpp-lsp-linux-${arch}`), arch, JSON.stringify(provenance)], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("C/C++ LSP pack preparation failed");
} finally {
  await rm(work, { recursive: true, force: true });
}
