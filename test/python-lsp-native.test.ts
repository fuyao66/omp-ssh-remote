import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptNativeLspConfig } from "../src/native-lsp-config-adapter.ts";

const root = resolve(import.meta.dir, "..");
let work: string;
let bundled: string;
beforeAll(async () => {
  await mkdir(join(root, ".cache"), { recursive: true });
  work = await mkdtemp(join(root, ".cache/native-lsp-test-"));
  const entry = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/lsp/config"));
  bundled = join(work, "config.js");
  const result = await Bun.build({ entrypoints: [entry], target: "bun", outdir: work, naming: "config.js",
    external: ["@oh-my-pi/pi-natives"], plugins: [{ name: "production-python-lsp-adapter", setup(build) {
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({ path: "omp-legacy-pi-modules", namespace: "python-lsp-test" }));
      build.onLoad({ filter: /^omp-legacy-pi-modules$/, namespace: "python-lsp-test" }, () => ({
        contents: "export const BUNDLED_PI_MODULE_LOADERS = {};", loader: "js",
      }));
      build.onLoad({ filter: /[/\\]lsp[/\\]config\.ts$/ }, async args => ({
        contents: adaptNativeLspConfig(await readFile(args.path, "utf8"), "18.15.0", join(root, "src/python-lsp-fallback.ts")), loader: "ts",
      }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, "Native config regression fixture build failed");
});
afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });

async function runCase(servers: unknown = {}, bins: string[] = [], marker = true, optin = true, reload: boolean | "same" = false, pathBin = false) {
  const dir = await mkdtemp(join(work, "project with spaces-"));
  const pack = join(dir, "private pack");
  await mkdir(join(pack, "bin"), { recursive: true });
  const launcher = join(pack, "bin/pyright-langserver");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n"); await chmod(launcher, 0o755);
  if (marker) await writeFile(join(dir, "pyproject.toml"), "[project]\nname='fixture'\n");
  await writeFile(join(dir, "lsp.json"), JSON.stringify({ servers }));
  const bin = pathBin ? join(dir, "path bin") : join(dir, ".venv/bin");
  await mkdir(bin, { recursive: true });
  for (const name of bins) { await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, name), 0o755); }
  const script = `import {getConfig,configCache} from ${JSON.stringify(bundled)};
    import {writeFileSync} from 'node:fs';
    const cwd=${JSON.stringify(dir)};
    const first=getConfig(cwd);
    if (${reload !== false}) { if (${reload === true}) writeFileSync(cwd+'/lsp.json', JSON.stringify({servers:{pyright:{disabled:true}}})); configCache.delete(cwd); }
    console.log(JSON.stringify({first,second:getConfig(cwd)}));`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, env: { ...process.env,
    HOME: dir, PI_CODING_AGENT_DIR: join(dir, "user"), PATH: pathBin ? bin : "", OMP_REMOTE_PYTHON_LSP_PACK: optin ? pack : "" }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  const errors = await new Response(proc.stderr).text();
  if (await proc.exited !== 0) throw new Error(errors);
  return { ...JSON.parse(output.trim().split("\n").at(-1)!), launcher, bin };
}

describe("production-adapted native LSP configuration", () => {
  test("default fallback retains native args/settings and paths with spaces", async () => {
    const {first,launcher} = await runCase();
    expect(first.servers.pyright.resolvedCommand).toBe(launcher);
    expect(first.servers.pyright.command).toBe("pyright-langserver");
    expect(first.servers.pyright.args).toEqual(["--stdio"]);
    expect(first.servers.pyright.settings.python.analysis.autoSearchPaths).toBe(true);
  });
  test("no opt-in and no root marker leave native missing-server behavior unchanged", async () => {
    expect((await runCase({}, [], true, false)).first.servers.pyright).toBeUndefined();
    expect((await runCase({}, [], false)).first.servers.pyright).toBeUndefined();
  });
  test("explicit disabled, custom/matching commands and marker overrides preserve intent", async () => {
    for (const override of [{ disabled: true }, {command:"missing-custom"}, {command:"pyright-langserver"}, {rootMarkers:["pyproject.toml"]}, {fileTypes:[".py"]}]) {
      expect((await runCase({pyright:override})).first.servers.pyright).toBeUndefined();
    }
  });
  test("settings-only project interpreter configuration permits fallback without rewriting settings", async () => {
    const settings = { python: { pythonPath: "/remote project/venv/bin/python", analysis:{typeCheckingMode:"basic"} } };
    const { first, launcher } = await runCase({pyright:{settings}});
    expect(first.servers.pyright.resolvedCommand).toBe(launcher);
    expect(first.servers.pyright.settings).toEqual(settings);
  });
  test("project-local and PATH Pyright executables take priority", async () => {
    for (const fromPath of [false,true]) {
      const result=await runCase({}, ["pyright-langserver"], true, true, false, fromPath);
      expect(result.first.servers.pyright.resolvedCommand).toBe(join(result.bin,"pyright-langserver"));
    }
  });
  test("installed semantic alternatives suppress duplicate Pyright, Ruff does not", async () => {
    for (const command of ["basedpyright-langserver","pylsp","ty"]) {
      expect((await runCase({}, [command])).first.servers.pyright).toBeUndefined();
    }
    expect((await runCase({}, ["ruff"])).first.servers.pyright).toBeDefined();
  });
  test("explicit missing alternative preserves selection intent", async () => {
    for (const servers of [{pylsp:{command:"missing-pylsp"}}, {custom:{command:"missing",fileTypes:[".py"],rootMarkers:["pyproject.toml"]}}]) {
      expect((await runCase(servers)).first.servers.pyright).toBeUndefined();
    }
  });
  test("native-equivalent Python extension spellings preserve alternative server intent", async () => {
    for (const fileType of [".PY", "PY", "py", ".PyI", "PYI"]) {
      const result = await runCase({ custom: {command:"missing-custom",fileTypes:[fileType],rootMarkers:["pyproject.toml"]} });
      expect(result.first.servers.pyright).toBeUndefined();
    }
  });
  test("native linter-only custom Python configuration does not suppress semantic fallback", async () => {
    const result = await runCase({ formatter: {command:"missing-formatter",fileTypes:[".py"],rootMarkers:["pyproject.toml"],isLinter:true} });
    expect(result.first.servers.pyright).toBeDefined();
  });
  test("native reload discovers the same private fallback again", async () => {
    const result = await runCase({}, [], true, true, "same");
    expect(result.first.servers.pyright.resolvedCommand).toBe(result.launcher);
    expect(result.second.servers.pyright.resolvedCommand).toBe(result.launcher);
  });
  test("native reload cache deletion re-runs fallback and new disabled config", async () => {
    const { first, second } = await runCase({}, [], true, true, true);
    expect(first.servers.pyright).toBeDefined();
    expect(second.servers.pyright).toBeUndefined();
  });
  test("adapter refuses SDK and source drift", async () => {
    expect(() => adaptNativeLspConfig("", "18.14.0", "fallback.ts")).toThrow("requires SDK");
    expect(() => adaptNativeLspConfig("", "18.15.0", "fallback.ts")).toThrow("anchor drift");
  });
});

async function runTypescriptCase(servers: unknown = {}, compiler?: "5" | "7", installedServer = false, reload = false, supplementalServer = false) {
  const dir = await mkdtemp(join(work, "typescript project "));
  const pack = join(dir, "private pack"); const bin = join(dir, "node_modules/.bin");
  await mkdir(join(pack, "bin"), { recursive: true }); await mkdir(bin, { recursive: true });
  const launcher = join(pack, "bin/typescript-language-server");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n"); await chmod(launcher, 0o755);
  await writeFile(join(dir, "package.json"), "{}");
  await writeFile(join(dir, "lsp.json"), JSON.stringify({ servers }));
  if (compiler) {
    await writeFile(join(bin, "tsc"), `#!/bin/sh\nprintf 'Version ${compiler}.0.0\\n'\n`); await chmod(join(bin, "tsc"), 0o755);
  }
  if (installedServer) {
    await writeFile(join(bin, "typescript-language-server"), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, "typescript-language-server"), 0o755);
  }
  if (supplementalServer) {
    await writeFile(join(dir, "tailwind.config.js"), "module.exports = {};\n");
    await writeFile(join(bin, "tailwindcss-language-server"), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, "tailwindcss-language-server"), 0o755);
  }
  const script = `import {getConfig,configCache} from ${JSON.stringify(bundled)};
    const cwd=${JSON.stringify(dir)}; const first=getConfig(cwd); if (${reload}) configCache.delete(cwd);
    console.log(JSON.stringify({first,second:getConfig(cwd)}));`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, env: { ...process.env,
    HOME: dir, PI_CODING_AGENT_DIR: join(dir, "user"), PATH: "", OMP_REMOTE_PYTHON_LSP_PACK: "", OMP_REMOTE_TYPESCRIPT_LSP_PACK: pack }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text(); const errors = await new Response(proc.stderr).text();
  if (await proc.exited !== 0) throw new Error(errors);
  return { ...JSON.parse(output.trim().split("\n").at(-1)!), launcher, bin };
}

describe("production-adapted native TypeScript selection", () => {
  const name = "typescript-language-server";
  test("private fallback preserves native defaults and survives native reload", async () => {
    const result = await runTypescriptCase({}, undefined, false, true);
    expect(result.first.servers[name].resolvedCommand).toBe(result.launcher);
    expect(result.first.servers[name].args).toEqual(["--stdio"]);
    expect(result.first.servers[name].initOptions.disableAutomaticTypingAcquisition).toBe(true);
    expect(result.second.servers[name].resolvedCommand).toBe(result.launcher);
  });
  test("project installed TLS and native TS7 win; TS5 compiler retains TLS fallback", async () => {
    const installed = await runTypescriptCase({}, undefined, true);
    expect(installed.first.servers[name].resolvedCommand).toBe(join(installed.bin, name));
    const supplemental = await runTypescriptCase({}, undefined, false, false, true);
    expect(supplemental.first.servers.tailwindcss).toBeDefined();
    expect(supplemental.first.servers[name].resolvedCommand).toBe(supplemental.launcher);
    const oldCompiler = await runTypescriptCase({}, "5");
    expect(oldCompiler.first.servers[name].resolvedCommand).toBe(oldCompiler.launcher);
    expect(oldCompiler.first.servers["typescript-native"]).toBeUndefined();
    const nativeCompiler = await runTypescriptCase({}, "7");
    expect(nativeCompiler.first.servers[name]).toBeUndefined();
    expect(nativeCompiler.first.servers["typescript-native"].resolvedCommand).toBe(join(nativeCompiler.bin, "tsc"));
  });
  test("explicit native disable/command and custom semantic intent are not replaced", async () => {
    for (const override of [{ disabled: true }, { command: name }, { command: "missing-custom" }, { fileTypes: [".ts"] }, { rootMarkers: ["package.json"] }]) {
      expect((await runTypescriptCase({ [name]: override })).first.servers[name]).toBeUndefined();
    }
    expect((await runTypescriptCase({ custom: { command: "missing-custom", fileTypes: [".ts"], rootMarkers: ["package.json"] } })).first.servers[name]).toBeUndefined();
    const initializationOptions = { tsserver: { path: "/remote/project/typescript/lib/tsserver.js" }, disableAutomaticTypingAcquisition: false };
    const configured = await runTypescriptCase({ [name]: { initOptions: initializationOptions } });
    expect(configured.first.servers[name].initOptions).toEqual(initializationOptions);
  });
});
