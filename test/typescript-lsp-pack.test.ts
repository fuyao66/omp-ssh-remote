import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESCRIPT_LSP_PINS } from "../src/typescript-lsp-pack.ts";
import { languagePackCacheCommand, deployLanguagePack } from "../src/language-pack-deploy.ts";
import { sha256, type LanguagePackDescriptor } from "../src/language-pack.ts";
import { applyTypescriptLspFallback, type TypescriptServerCandidate } from "../src/typescript-lsp-fallback.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";
import { loadConfiguredSshHosts, parseConnectArgs, parseConnectOptions } from "../src/connect-options.ts";

let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "ts pack's tests ")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
const required = ["bin/node", "bin/typescript-language-server", "typescript-language-server/lib/cli.mjs", "typescript-language-server/package.json", "typescript-language-server/LICENSE", ...["lib/tsserver.js", "lib/_tsserver.js", "lib/typescript.js", "package.json", "LICENSE.txt", "ThirdPartyNoticeText.txt"].map(p => `typescript-language-server/node_modules/typescript/${p}`), "licenses/node-LICENSE"];
async function fixture(omit?: string) {
  const dir = await mkdtemp(join(work, "fixture "));
  const files = Object.fromEntries(required.filter(p => p !== omit).map(p => [p, { sha256: sha256(Buffer.from(p)), mode: p.startsWith("bin/") ? 0o755 : 0o644 }]));
  const manifest = JSON.stringify({ format: 1, platform: "linux", arch: "arm64", entrypoint: "bin/typescript-language-server", files });
  const archive = join(dir, "pack.tar.gz");
  const generator = `import tarfile,io,json,sys\narchive,manifest=sys.argv[1:]\nwith tarfile.open(archive,'w:gz') as t:\n for name in ['manifest.json']+list(json.loads(manifest)['files']):\n  b=manifest.encode() if name=='manifest.json' else name.encode()\n  m=tarfile.TarInfo(name);m.size=len(b);m.mode=0o755 if name.startswith('bin/') else 0o644;t.addfile(m,io.BytesIO(b))\n`;
  const p = Bun.spawnSync(["python3", "-c", generator, archive, manifest]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  const descriptor: LanguagePackDescriptor = { format: 1, platform: "linux", arch: "arm64", id: sha256(Buffer.from(manifest)), archiveSha256: sha256(await readFile(archive)) };
  return { dir, archive, descriptor, root: join(dir, "cache's root") };
}
async function execute(command: string) {
  const p = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout: stdout.trim(), stderr };
}
describe("TypeScript shared pack consumer", () => {
  test("pins the complete published runtime closure", () => {
    expect(TYPESCRIPT_LSP_PINS.node.version).toBe("22.22.0");
    expect(TYPESCRIPT_LSP_PINS.server.version).toBe("4.3.4");
    expect(TYPESCRIPT_LSP_PINS.typescript.version).toBe("5.8.3");
    for (const pin of [TYPESCRIPT_LSP_PINS.server, TYPESCRIPT_LSP_PINS.typescript]) expect(pin.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });
  test("same-hash publishers converge; verified hit preserves inode and refuses corruption", async () => {
    const f = await fixture();
    const command = languagePackCacheCommand("typescript", f.root, f.descriptor, f.archive);
    const results = await Promise.all([execute(command), execute(command)]);
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const final = join(f.root, f.descriptor.id);
    const inode = (await stat(final)).ino;
    expect((await execute(languagePackCacheCommand("typescript", f.root, f.descriptor))).stdout).toBe(final);
    expect((await stat(final)).ino).toBe(inode);
    await writeFile(join(final, "typescript-language-server/lib/cli.mjs"), "corrupt");
    expect((await execute(command)).code).not.toBe(0);
  });
  test("profiles reject wrong language, missing runtime/license and partial caches", async () => {
    const valid = await fixture();
    const wrongProfile = await execute(languagePackCacheCommand("python", valid.root, valid.descriptor, valid.archive));
    expect(wrongProfile.code).not.toBe(0);
    expect(wrongProfile.stderr).toContain("invalid manifest");
    expect((await execute(languagePackCacheCommand("typescript", valid.root, valid.descriptor, valid.archive))).code).toBe(0);
    const wrongCachedProfile = await execute(languagePackCacheCommand("python", valid.root, valid.descriptor));
    expect(wrongCachedProfile.code).not.toBe(0);
    expect(wrongCachedProfile.stderr).toContain("invalid manifest");
    for (const missing of ["typescript-language-server/LICENSE", "typescript-language-server/node_modules/typescript/lib/tsserver.js"]) {
      const f = await fixture(missing);
      expect((await execute(languagePackCacheCommand("typescript", f.root, f.descriptor, f.archive))).code).not.toBe(0);
    }
    const partial = await fixture();
    await mkdir(join(partial.root, partial.descriptor.id), { recursive: true });
    expect((await execute(languagePackCacheCommand("typescript", partial.root, partial.descriptor, partial.archive))).code).not.toBe(0);
  });
  test("deployer validates local archive, hits without SCP and reports missing artifact", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "typescript-lsp-linux-arm64.json"), JSON.stringify(f.descriptor));
    await writeFile(join(f.dir, "typescript-lsp-linux-arm64.tar.gz"), await readFile(f.archive));
    const expected = `/home/test/.cache/omp-ssh-remote/language-packs/typescript/linux-arm64/${f.descriptor.id}`;
    const commands: string[][] = [];
    expect(await deployLanguagePack("typescript", { target: "example.com" }, "/home/test", "arm64", f.dir, async command => { commands.push(command); return expected; })).toBe(expected);
    expect(commands).toHaveLength(1); expect(commands[0]![0]).toBe("ssh");
    await writeFile(join(f.dir, "typescript-lsp-linux-arm64.tar.gz"), "corrupt");
    await expect(deployLanguagePack("typescript", { target: "example.com" }, "/home/test", "arm64", f.dir, async () => expected)).rejects.toThrow("checksum");
    await expect(deployLanguagePack("typescript", { target: "example.com" }, "/home/test", "x64", work, async () => "")).rejects.toThrow("prepare-typescript-lsp.ts x64");
  });
  test("host-only opt-ins are independent booleans and reject unknown fields", async () => {
    const dir = await mkdtemp(join(work, "hosts ")); await mkdir(join(dir, ".omp"));
    for (const lsp of [{ typescript: true }, { python: false, typescript: true }, { python: true, typescript: false }]) {
      await writeFile(join(dir, ".omp/ssh.json"), JSON.stringify({ hosts: { fixture: { host: "example.com", lsp } } }));
      const hosts = await loadConfiguredSshHosts(dir);
      expect(parseConnectArgs("fixture", hosts).typescriptLsp).toBe(lsp.typescript ? true : undefined);
      expect(parseConnectOptions({ target: "fixture" }, hosts).pythonLsp).toBe("python" in lsp && lsp.python ? true : undefined);
      expect(parseConnectArgs("user@example.com", hosts).typescriptLsp).toBeUndefined();
    }
    for (const lsp of [{ typescript: "true" }, { typescript: true, node: true }, { typescript: null }]) {
      await writeFile(join(dir, ".omp/ssh.json"), JSON.stringify({ hosts: { fixture: { host: "example.com", lsp } } }));
      await expect(loadConfiguredSshHosts(dir)).rejects.toThrow("invalid lsp");
    }
    expect(() => parseConnectArgs("example.com --typescript-lsp true")).toThrow("Unknown option");
    expect(parseConnectOptions({ target: "example.com", ...{ typescriptLsp: true } }).typescriptLsp).toBeUndefined();
  });
  test("worker shell scopes both literal pack paths, strips ambient opt-ins and leaves PATH unchanged", async () => {
    const dir = await mkdtemp(join(work, "worker ")); const worker = join(dir, "worker");
    await writeFile(worker, '#!/bin/sh\nprintf "%s\\n%s\\n" "${OMP_REMOTE_PYTHON_LSP_PACK-unset}" "${OMP_REMOTE_TYPESCRIPT_LSP_PACK-unset}"\n'); await chmod(worker, 0o755);
    const pack = join(dir, "pack's files");
    for (const enabled of [false, true]) {
      const command = buildSshWorkerCommand({ target: "example.com", workerPath: worker, ...(enabled ? { pythonLspPack: pack, typescriptLspPack: pack + " ts" } : {}) }).at(-1)!;
      expect(command).not.toContain("PATH=");
      const p = Bun.spawn(["sh", "-c", command], { env: { ...process.env, OMP_REMOTE_PYTHON_LSP_PACK: "/ambient", OMP_REMOTE_TYPESCRIPT_LSP_PACK: "/ambient" }, stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(p.stdout).text(); const stderr = await new Response(p.stderr).text();
      expect(await p.exited, stderr).toBe(0); expect(stdout.trim().split("\n")).toEqual(enabled ? [pack, pack + " ts"] : ["unset", "unset"]);
    }
    for (const invalid of ["", "relative", "/remote\npack", "/remote\0pack"]) expect(() => buildSshWorkerCommand({ target: "example.com", workerPath: worker, typescriptLspPack: invalid })).toThrow("absolute");
  });
});

const tls = "typescript-language-server";
const config = (command = tls): TypescriptServerCandidate => ({ command, fileTypes: [".ts", ".js"] });
function select(candidates: Record<string, TypescriptServerCandidate>, explicit = new Map<string, Set<string>>(), servers: Record<string, TypescriptServerCandidate> = {}, root = true, launcher: string | undefined = "/private/bin/typescript-language-server") {
  applyTypescriptLspFallback(candidates, servers, explicit, () => root, launcher); return servers;
}
describe("TypeScript fallback intent", () => {
  test("only missing native default receives launcher, retaining settings and args", () => {
    const candidate = { ...config(), settings: { project: true }, args: ["--stdio"] };
    expect(select({ [tls]: candidate })[tls]).toEqual({ ...candidate, initOptions: { disableAutomaticTypingAcquisition: true }, resolvedCommand: "/private/bin/typescript-language-server" });
    for (const key of ["command", "disabled", "fileTypes", "rootMarkers", "extensionToLanguage"]) expect(select({ [tls]: config() }, new Map([[tls, new Set([key])]]))[tls]).toBeUndefined();
    expect(select({ [tls]: config() }, new Map([[tls, new Set(["settings", "initOptions"])]]))[tls]).toBeDefined();
    expect(select({ [tls]: { ...config(), initOptions: { disableAutomaticTypingAcquisition: false, hostInfo: "project" } } })[tls]?.initOptions).toEqual({ disableAutomaticTypingAcquisition: false, hostInfo: "project" });
    expect(select({ [tls]: { ...config(), disabled: true } })[tls]).toBeUndefined();
    expect(select({ [tls]: config("custom-server") })[tls]).toBeUndefined();
    expect(select({ [tls]: config() }, new Map(), {}, false)[tls]).toBeUndefined();
    const resolved = { ...config(), resolvedCommand: "/project/tls" };
    expect(select({ [tls]: config() }, new Map(), { [tls]: resolved })[tls]).toBe(resolved);
  });
  test("semantic alternatives win; linters do not; native tsc version arbitration remains native", () => {
    expect(select({ [tls]: config(), denols: config("deno") }, new Map([["denols", new Set(["command"])]]))[tls]).toBeUndefined();
    expect(select({ [tls]: config(), vtsls: config("vtsls") }, new Map(), { vtsls: config("vtsls") })[tls]).toBeUndefined();
    expect(select({ [tls]: config(), biome: { ...config("biome"), isLinter: true } }, new Map(), { biome: config("biome") })[tls]).toBeDefined();
    for (const name of ["tailwindcss", "vscode-html-language-server", "vscode-css-language-server"]) {
      expect(select({ [tls]: config(), [name]: config(name) }, new Map(), { [name]: config(name) })[tls]).toBeDefined();
    }
    const native = config("tsc");
    expect(select({ [tls]: config(), "typescript-native": native }, new Map(), { "typescript-native": native })[tls]).toBeDefined();
    expect(select({ [tls]: config(), "typescript-native": native }, new Map([["typescript-native", new Set(["command"])]]))[tls]).toBeUndefined();
  });
});
