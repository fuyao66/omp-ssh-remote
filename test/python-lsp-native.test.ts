import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptNativePythonLspConfig } from "../src/python-lsp-native-adapter.ts";

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
        contents: adaptNativePythonLspConfig(await readFile(args.path, "utf8"), "18.13.1", join(root, "src/python-lsp-fallback.ts")), loader: "ts",
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
    expect(() => adaptNativePythonLspConfig("", "18.14.0", "fallback.ts")).toThrow("requires SDK");
    expect(() => adaptNativePythonLspConfig("", "18.13.1", "fallback.ts")).toThrow("anchor drift");
  });
});
