import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CPP_LSP_PINS } from "../src/cpp-lsp-pack.ts";
import { LANGUAGE_PACK_ARCHIVE_SCRIPT } from "../src/language-pack-archive.ts";
import { languagePackCacheCommand, deployLanguagePack } from "../src/language-pack-deploy.ts";
import { applyCppLspFallback } from "../src/cpp-lsp-fallback.ts";
import type { LanguagePackDescriptor } from "../src/language-pack.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";
import { loadConfiguredSshHosts, parseConnectArgs } from "../src/connect-options.ts";
import type { PythonServerCandidate } from "../src/python-lsp-fallback.ts";
let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "cpp-pack-")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
const required = ["bin/clangd", "bin/clangd.real", "lib/libLLVM.so.23.1", "lib/libclang-cpp.so.23.1", "lib/libstdc++.so.6", "lib/libgcc_s.so.1", "lib/clang/23/include/stddef.h", ...["clangd-23", "libclang-common-23-dev", "libclang-cpp23", "libllvm23", "gcc-10-base"].map(n => `licenses/${n}-copyright`)];
required.push("licenses/common/Apache-2.0", "licenses/common/GPL-3", "licenses/common/LGPL-2.1");
async function fixture(omit?: string) {
  const dir = await mkdtemp(join(work, "pack ' ")); const pack = join(dir, "payload");
  for (const name of required.filter(n => n !== omit)) { await mkdir(join(pack, name, ".."), { recursive: true }); await writeFile(join(pack, name), name); await chmod(join(pack, name), name.startsWith("bin/") ? 0o755 : 0o644); }
  const prefix = join(dir, "cpp-lsp-linux-arm64");
  const result = Bun.spawnSync(["python3", "-c", LANGUAGE_PACK_ARCHIVE_SCRIPT, "prepare-cpp-directory", pack, prefix, "arm64", "{}"]);
  return { dir, prefix, result, root: join(dir, "cache"), descriptor: result.exitCode === 0 ? JSON.parse(await readFile(prefix + ".json", "utf8")) as LanguagePackDescriptor : undefined };
}

test("Debian payload boundary refuses source mismatch, linked selections and unsafe names", () => {
  const helper = resolve(import.meta.dir, "../scripts/prepare-cpp-payload.py");
  const script = `import importlib.util,io,tarfile,tempfile,pathlib,json,hashlib\ns=importlib.util.spec_from_file_location('payload',${JSON.stringify(helper)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nfor name in ['/absolute','../escape','a/../../escape']:\n try: m.safe_name(name);raise AssertionError('unsafe accepted')\n except ValueError: pass\nwith tempfile.TemporaryDirectory() as work:\n p=pathlib.Path(work);buf=io.BytesIO()\n with tarfile.open(fileobj=buf,mode='w:xz') as t:\n  item=tarfile.TarInfo('usr/bin/clangd');item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd';t.addfile(item)\n data=buf.getvalue();header=('data.tar.xz/'.ljust(16)+'0'.ljust(12)+'0'.ljust(6)+'0'.ljust(6)+'100644'.ljust(8)+str(len(data)).ljust(10)+'\u0060\\n').encode();raw=b'!<arch>\\n'+header+data+(b'\\n' if len(data)%2 else b'');archive=p/'payload.deb';archive.write_bytes(raw)\n source={'archive':str(archive),'sha256':hashlib.sha256(raw).hexdigest(),'files':[{'source':'usr/bin/clangd','target':'bin/clangd.real'}]}\n try: m.prepare([source],p/'pack','arm64');raise AssertionError('link accepted')\n except ValueError as e: assert 'nonregular' in str(e),str(e)\n source['sha256']='0'*64\n try: m.prepare([source],p/'bad','arm64');raise AssertionError('bad hash accepted')\n except ValueError as e: assert 'checksum' in str(e),str(e)\n`;
  const p = Bun.spawnSync(["python3", "-B", "-c", script]); expect(p.exitCode, p.stderr.toString()).toBe(0);
});
function execute(command: string) { return Bun.spawnSync(["sh", "-c", command]); }
test("official same-version sources pin complete native closure and license payloads without Node", () => {
  expect(CPP_LSP_PINS.glibc).toBe("2.29");
  for (const arch of ["arm64", "x64"] as const) {
    const sources = CPP_LSP_PINS.sources[arch];
    expect(sources.find(s => s.name === "clangd-23")!.version).toBe(CPP_LSP_PINS.packageVersion);
    expect(sources.some(s => s.name === "gcc-10-base")).toBe(true);
    for (const source of sources) { expect(source.sha256).toMatch(/^[a-f0-9]{64}$/); expect(new URL(source.url).protocol).toBe("https:"); expect(source.files.length).toBeGreaterThan(0); }
  }
});
test("native profile publishes and reuses without fake Node; checks archive and full cache", async () => {
  const f = await fixture(); expect(f.result.exitCode, f.result.stderr.toString()).toBe(0);
  const d = f.descriptor!; const command = languagePackCacheCommand("cpp", f.root, d, f.prefix + ".tar.gz");
  expect(execute(command).exitCode).toBe(0); expect(execute(languagePackCacheCommand("cpp", f.root, d)).exitCode).toBe(0);
  expect(execute(languagePackCacheCommand("python", f.root, d)).exitCode).not.toBe(0);
  await writeFile(join(f.root, d.id, "lib/libLLVM.so.23.1"), "corrupt"); expect(execute(command).exitCode).not.toBe(0);
  expect(execute(languagePackCacheCommand("cpp", join(f.dir, "bad"), { ...d, archiveSha256: "0".repeat(64) }, f.prefix + ".tar.gz")).exitCode).not.toBe(0);
});
test("native profile rejects missing executable, resources, runtime and licenses", async () => {
  for (const name of ["bin/clangd.real", "lib/clang/23/include/stddef.h", "lib/libstdc++.so.6", "licenses/gcc-10-base-copyright"]) expect((await fixture(name)).result.exitCode).not.toBe(0);
});
test("cpp deployment verifies prepared archive before cache hit or upload", async () => {
  const f = await fixture(); const d = f.descriptor!;
  const expected = `/home/test/.cache/omp-ssh-remote/language-packs/cpp/linux-arm64/${d.id}`;
  expect(await deployLanguagePack("cpp", { target: "example.com" }, "/home/test", "arm64", f.dir, async () => expected)).toBe(expected);
  await writeFile(f.prefix + ".tar.gz", "bad");
  await expect(deployLanguagePack("cpp", { target: "example.com" }, "/home/test", "arm64", f.dir, async () => expected)).rejects.toThrow("checksum");
});
const config = (command = "clangd"): PythonServerCandidate => ({ command, fileTypes: [".cpp", ".h"] });
function select(candidates: Record<string, PythonServerCandidate>, explicit = new Map<string, Set<string>>(), servers: Record<string, PythonServerCandidate> = {}, root = true) { applyCppLspFallback(candidates, servers, explicit, () => root, "/private/bin/clangd"); return servers; }
test("cpp fallback preserves arguments and project semantic intent including missing ccls", () => {
  const clangd = { ...config(), args: ["--background-index", "--clang-tidy"] };
  expect(select({ clangd }).clangd).toEqual({ ...clangd, resolvedCommand: "/private/bin/clangd" });
  for (const key of ["command", "disabled", "fileTypes", "rootMarkers", "extensionToLanguage"]) expect(select({ clangd }, new Map([["clangd", new Set([key])]])).clangd).toBeUndefined();
  expect(select({ clangd }, new Map(), {}, false).clangd).toBeUndefined();
  expect(select({ clangd: { ...clangd, disabled: true } }).clangd).toBeUndefined();
  expect(select({ clangd, ccls: config("ccls") }, new Map([["ccls", new Set(["command"])]])).clangd).toBeUndefined();
  expect(select({ clangd, lint: { ...config("lint"), isLinter: true } }, new Map([["lint", new Set(["command"])]])).clangd).toBeDefined();
  const installed = { ...clangd, resolvedCommand: "/project/clangd" }; expect(select({ clangd }, new Map(), { clangd: installed }).clangd).toBe(installed);
  for (const [nativeType, customType] of [[".cuh", ".CUH"], [".mm", "MM"], [".CPP", ".cpp"]]) {
    const native = { ...clangd, fileTypes: [nativeType] };
    const custom = { ...config("missing-custom"), fileTypes: [customType] };
    expect(select({ clangd: native, custom }, new Map([["custom", new Set(["command"])]] )).clangd).toBeUndefined();
  }
});
test("host cpp opt-in is independent and worker strips ambient cpp pack", async () => {
  const dir = join(work, "host"); await mkdir(join(dir, ".omp"), { recursive: true });
  await writeFile(join(dir, ".omp/ssh.json"), JSON.stringify({ hosts: { fixture: { host: "example.com", lsp: { cpp: true } } } }));
  const options = parseConnectArgs("fixture", await loadConfiguredSshHosts(dir)); expect(options.cppLsp).toBe(true); expect(options.pythonLsp).toBeUndefined(); expect(options.typescriptLsp).toBeUndefined();
  const worker = join(dir, "worker"); await writeFile(worker, '#!/bin/sh\nprintf "%s" "${OMP_REMOTE_CPP_LSP_PACK-unset}"\n'); await chmod(worker, 0o755);
  for (const enabled of [true, false]) {
    const command = buildSshWorkerCommand({ target: "example.com", workerPath: worker, ...(enabled ? { cppLspPack: dir + "/private ' pack" } : {}) }).at(-1)!;
    const p = Bun.spawnSync(["sh", "-c", command], { env: { ...process.env, OMP_REMOTE_CPP_LSP_PACK: "/ambient" } }); expect(p.exitCode, p.stderr.toString()).toBe(0); expect(p.stdout.toString()).toBe(enabled ? dir + "/private ' pack" : "unset"); expect(command).not.toContain("LD_LIBRARY_PATH=");
  }
  expect(() => buildSshWorkerCommand({ target: "example.com", workerPath: worker, cppLspPack: "relative" })).toThrow("absolute");
});
