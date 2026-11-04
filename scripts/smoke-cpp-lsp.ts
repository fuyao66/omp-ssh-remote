// Run with build-smoke.ts/run-smoke.ts cpp-lsp and REMOTE_CONNECT_ARGS selecting lsp.cpp:true.
// Optional REMOTE_CPP_PROJECT_ROOT enables read-only acceptance against an existing build/compile_commands.json.
// Real-project overrides: REMOTE_CPP_PROJECT_FILE, REMOTE_CPP_PROJECT_SYMBOL, REMOTE_CPP_PROJECT_API,
// REMOTE_CPP_SDK_ROOT. Paths and source locations are discovered remotely; no personal host data belongs here.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveHostSessionRef } from "../src/omp/host-session.ts";
import { parseConnectArgs } from "../src/connect-options.ts";
import { bootstrapSmokeHost } from "./smoke-host.ts";

const text = (result: any): string => result.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const count = (value: string, label: string): number => {
  const match = value.match(new RegExp(`Found (\\d+) ${label}\\(s\\)`));
  assert(match, `Missing numerical ${label} result: ${value}`);
  return Number(match[1]);
};
const sources: Record<string, string> = {
  "math.hpp": "#pragma once\n#include <vector>\nint sum_values(const std::vector<int>& values);\n",
  "math.cpp": '#include "math.hpp"\n#include <numeric>\nint sum_values(const std::vector<int>& values) {\n  return std::accumulate(values.begin(), values.end(), 0);\n}\n',
  "main.cpp": '#include "math.hpp"\n#include <iostream>\nint main() {\n  std::vector<int> values{1, 2, 3};\n  std::cout << sum_values(values) << "\\n";\n  return sum_values(values) == 6 ? 0 : 1;\n}\n',
  "diagnostic.cpp": "int clean_value() { return 1; }\n",
};

export default async function cppLspSmoke(pi: ExtensionAPI) {
  const args = process.env.REMOTE_CONNECT_ARGS;
  if (!args) throw new Error("REMOTE_CONNECT_ARGS must select an SSH alias with lsp.cpp:true");
  const commands = await bootstrapSmokeHost(pi);
  pi.registerCommand("remote-cpp-lsp-smoke", { description: "Native packaged clangd acceptance (scratch plus optional read-only project)", async handler(_, ctx) {
    const session = resolveHostSessionRef(ctx.sessionManager.getSessionFile(), ctx)?.session;
    assert(session, "Native session not registered");
    const rows: { check: string; outcome: string; evidence: unknown }[] = [];
    const report = (check: string, evidence: unknown, outcome = "positive") => {
      rows.push({ check, outcome, evidence }); console.log("CPP_LSP_CHECK", JSON.stringify(rows.at(-1)));
    };
    const previousBridge = session.clientBridge;
    const previousPrompt = session.agent.prompt;
    const previousStreaming = session.agent.state.isStreaming;
    const settings: { key: AnySetting; previous: unknown }[] = [];
    session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
    session.agent.state.isStreaming = true;
    let modelTurns = 0;
    session.agent.prompt = async () => { modelTurns++; throw new Error("Unexpected model turn in C++ acceptance"); };
    let connected = false;
    let scratch: string | undefined;
    const invoke = async (name: string, params: object): Promise<any> => {
      const tool = session.getToolByName(name); assert(tool, `Missing native tool ${name}`);
      const result = await tool.execute(crypto.randomUUID(), params, AbortSignal.timeout(60_000), undefined,
        { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
      assert(!result.isError && result.details?.success !== false, `${name} ${JSON.stringify(params)}: ${text(result)}`);
      return result;
    };
    const lsp = async (action: string, params: object = {}) => text(await invoke("lsp", { action, ...params }));
    const shell = async (command: string) => text(await invoke("bash", { command }));
    const disk = (path: string) => shell(`cat -- ${quote(path)}`);
    const put = (path: string, content: string) => invoke("write", { path, content });
    const reconnectArgs = (cwd: string): string => {
      const request = parseConnectArgs(args);
      return [quote(request.displayTarget), quote(cwd), ...(request.port ? ["--port", String(request.port)] : []),
        ...(request.identityFile ? ["--identity", quote(request.identityFile)] : []),
        ...(request.knownHostsFile ? ["--known-hosts", quote(request.knownHostsFile)] : [])].join(" ");
    };
    const connect = async (value: string) => { await commands.get("remote-connect")!.handler(value, ctx); connected = true; };
    const exit = async () => { await commands.get("remote-exit")!.handler("", ctx); connected = false; };
    const untilReferences = async (file: string, symbol: string, expected: number, line = 3): Promise<string> => {
      const deadline = performance.now() + 20_000;
      let result = "";
      do {
        result = await lsp("references", { file, line, symbol });
        if (result.startsWith("Found ") && count(result, "reference") === expected) return result;
        assert(performance.now() < deadline, `Expected ${expected} indexed references: ${result}`);
        await Bun.sleep(50);
      } while (true);
    };
    try {
      for (const [name, value] of Object.entries({ "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": true, "lsp.diagnosticsOnEdit": true, "lsp.requestTimeout": 30 })) {
        const key = lookup(name); assert(key, `Native setting unavailable: ${name}`);
        settings.push({ key, previous: key.get(session.settings) }); key.override(session.settings, value as never);
      }
      await connect(args);
      scratch = (await shell("mktemp -d /tmp/omp-cpp-lsp-XXXXXXXX")).trim();
      assert.match(scratch, /^\/tmp\/omp-cpp-lsp-[A-Za-z0-9]+$/);
      const compiler = (await shell("command -v g++")).trim(); assert.match(compiler, /^\//);
      const pack = (await shell("printenv OMP_REMOTE_CPP_LSP_PACK")).trim();
      assert.match(pack, /^\//, "Worker must expose its validated private C++ pack");
      const clangd = `${pack}/bin/clangd`;
      await shell(`test -x ${quote(clangd)}`);
      const clangdVersion = (await shell(`${quote(clangd)} --version`)).trim();
      assert.match(clangdVersion, /clangd version/i);
      const database = Object.keys(sources).filter(name => name.endsWith(".cpp")).map(name => ({
        directory: scratch, file: `${scratch}/${name}`, arguments: [compiler, "-std=c++17", "-I", scratch!, "-c", `${scratch}/${name}`],
      }));
      for (const [name, content] of Object.entries({ ...sources, "compile_commands.json": JSON.stringify(database) })) {
        await shell(`printf %s ${quote(content)} > ${quote(`${scratch}/${name}`)}`);
      }
      await exit(); await connect(reconnectArgs(scratch));
      const main = `${scratch}/main.cpp`, math = `${scratch}/math.cpp`, header = `${scratch}/math.hpp`, diagnostic = `${scratch}/diagnostic.cpp`;
      const capabilities = await lsp("capabilities", { file: main });
      assert.match(capabilities, /definitionProvider/); report("packaged_server", { capabilities, compiler, clangd, clangdVersion, compileDatabaseEntries: database.length });
      const mathSymbols = await lsp("symbols", { file: math }); assert.match(mathSymbols, /sum_values/);
      const mainSymbols = await lsp("symbols", { file: main }); assert.match(mainSymbols, /main/);
      await lsp("symbols", { file: header }); report("symbols", { documentFunction: "sum_values", consumer: "main" });
      for (const file of [math, main]) assert.equal((await lsp("diagnostics", { file })).trim(), "OK", `${file}: standard C++ headers must resolve`);
      report("standard_headers_clean", { files: 2, headers: ["vector", "numeric", "iostream"] });
      const hover = await lsp("hover", { file: main, line: 5, symbol: "sum_values" });
      assert.match(hover, /int/); assert.match(hover, /vector/); report("hover", hover);
      const definition = await lsp("definition", { file: main, line: 5, symbol: "sum_values" });
      assert(count(definition, "definition") >= 1); assert.match(definition, /math\.cpp:3/); report("cross_file_definition", definition);
      const references = await untilReferences(math, "sum_values", 4);
      assert.match(references, /main\.cpp:5/); assert.match(references, /main\.cpp:6/); assert.match(references, /math\.hpp:3/);
      report("cross_file_references", { expected: 4, actual: count(references, "reference"), references });
      const before = await Promise.all([header, math, main].map(disk));
      await lsp("rename", { file: math, line: 3, symbol: "sum_values", new_name: "total_values", apply: false });
      assert.deepEqual(await Promise.all([header, math, main].map(disk)), before);
      report("rename_preview", { unchangedFiles: 3 });
      await lsp("rename", { file: math, line: 3, symbol: "sum_values", new_name: "total_values", apply: true });
      const after = await Promise.all([header, math, main].map(disk));
      assert.deepEqual(after, before.map(source => source.replaceAll("sum_values", "total_values")));
      report("rename_apply_disk", { changedFiles: 3, expectedOccurrences: 4, actualOccurrences: after.join("").match(/total_values/g)?.length });
      const clean = sources["diagnostic.cpp"];
      await put(diagnostic, "int clean_value() { return 1 }\n");
      const syntax = await lsp("diagnostics", { file: diagnostic }); assert.match(syntax, /expected.*';'|expected_semi/i); report("syntax_diagnostic", syntax);
      await put(diagnostic, clean); assert.equal((await lsp("diagnostics", { file: diagnostic })).trim(), "OK");
      await put(diagnostic, 'int clean_value() { int value = "wrong type"; return value; }\n');
      const type = await lsp("diagnostics", { file: diagnostic }); assert.match(type, /cannot initialize|incompatible|cannot convert/i); report("type_diagnostic", type);
      await put(diagnostic, clean); assert.equal((await lsp("diagnostics", { file: diagnostic })).trim(), "OK");
      await put(diagnostic, '#include "omp_acceptance_missing_header.hpp"\nint clean_value() { return 1; }\n');
      const missing = await lsp("diagnostics", { file: diagnostic }); assert.match(missing, /omp_acceptance_missing_header\.hpp/); assert.match(missing, /not found|file_not_found/i);
      report("unresolved_header", missing, "configuration-error-control");
      await put(diagnostic, clean); assert.equal((await lsp("diagnostics", { file: diagnostic })).trim(), "OK");
      report("clean_controls", { syntaxCleared: true, typeCleared: true, missingHeaderCleared: true });
      const reload = await lsp("reload", { file: math }); assert.match(reload, /reload|restart/i);
      const reloadedReferences = await untilReferences(math, "total_values", 4);
      assert.equal((await lsp("diagnostics", { file: main })).trim(), "OK");
      report("reload", { references: count(reloadedReferences, "reference"), standardHeadersClean: true });
      const realRoot = process.env.REMOTE_CPP_PROJECT_ROOT;
      if (realRoot) {
        assert.match(realRoot, /^\//, "REMOTE_CPP_PROJECT_ROOT must be absolute");
        const realFile = `${realRoot}/${process.env.REMOTE_CPP_PROJECT_FILE ?? "src/host/init/backends/shmem_init_backend.cpp"}`;
        const realSymbol = process.env.REMOTE_CPP_PROJECT_SYMBOL ?? "setup_trusted_pids";
        const realApi = process.env.REMOTE_CPP_PROJECT_API ?? "aclrtDeviceGetBareTgid";
        const realHeader = `${realRoot}/${process.env.REMOTE_CPP_PROJECT_HEADER ?? "include/host/init/shmem_host_init.h"}`;
        const publicSymbol = process.env.REMOTE_CPP_PROJECT_PUBLIC_SYMBOL ?? "aclshmem_finalize";
        const publicImplementation = `${realRoot}/${process.env.REMOTE_CPP_PROJECT_IMPLEMENTATION ?? "src/host/init/shmem_init.cpp"}`;
        const sdk = process.env.REMOTE_CPP_SDK_ROOT ?? "/usr/local/Ascend/ascend-toolkit/latest";
        const inspect = [
          "import json,pathlib,hashlib,shlex",
          `r=pathlib.Path(${JSON.stringify(realRoot)}); p=pathlib.Path(${JSON.stringify(realFile)})`,
          'db=r/"build/compile_commands.json"; d=json.loads(db.read_text())',
          'selected=[x for x in d if pathlib.Path(x["file"]).resolve()==p.resolve()]',
          'assert len(selected)==1,"Expected exactly one real compile command"',
          'entry=selected[0]; argv=entry.get("arguments") or shlex.split(entry["command"])',
          `header=pathlib.Path(${JSON.stringify(realHeader)}); implementation=pathlib.Path(${JSON.stringify(publicImplementation)})`,
          'paths=[db,p,header,implementation]',
          'def locations(file,symbol):',
          '    return [i for i,line in enumerate(file.read_text().splitlines(),1) if symbol+"(" in line]',
          `symbol_lines=locations(p,${JSON.stringify(realSymbol)}); api_lines=locations(p,${JSON.stringify(realApi)})`,
          `declaration_lines=locations(header,${JSON.stringify(publicSymbol)}); implementation_lines=locations(implementation,${JSON.stringify(publicSymbol)})`,
          'assert len(symbol_lines)>=2 and api_lines and declaration_lines and implementation_lines,"Missing expected project symbols"',
          'print(json.dumps({"entries":len(d),"existingSources":sum(pathlib.Path(x["file"]).is_file() for x in d),',
          '"selected":{"file":entry["file"],"directory":entry["directory"],"driver":argv[0],"argumentCount":len(argv),"commandSha256":hashlib.sha256(json.dumps(argv).encode()).hexdigest()},',
          '"locations":{"symbolDefinition":symbol_lines[0],"symbolUse":symbol_lines[1],"apiLine":api_lines[0],"declarationLine":declaration_lines[0],"implementationLine":implementation_lines[0]},',
          '"hashes":{str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in paths}},indent=2))',
        ].join("\n");
        const inspectProject = async () => {
          const output = (await shell(`python3 -c ${quote(inspect)}`)).trim();
          assert.doesNotMatch(output, /truncated|artifact:\/\//i, "Real-project metadata transport was truncated");
          try { return JSON.parse(output); }
          catch (error) { throw new Error(`Invalid real-project metadata (${output.length} characters): ${error}`); }
        };
        const baseline = await inspectProject();
        assert(baseline.existingSources > 0); report("real_compile_database", baseline);
        const { symbolDefinition, symbolUse, apiLine, declarationLine, implementationLine } = baseline.locations;
        // An isolated native config changes only index persistence and compile-database discovery.
        // Absolute real files still use their unchanged existing compile commands (including vendor flags).
        // Pack launch provenance is taken from this worker, never a system clangd substitution.
        const realScratch = `${scratch}/real-project`;
        await shell(`mkdir -- ${quote(realScratch)}`);
        const config = { servers: { clangd: { command: clangd, args: ["--background-index=false", "--clang-tidy", "--header-insertion=iwyu", `--compile-commands-dir=${realRoot}/build`], rootMarkers: ["."] } } };
        await shell(`printf %s ${quote(JSON.stringify(config))} > ${quote(`${realScratch}/lsp.json`)}`);
        await exit(); await connect(reconnectArgs(realScratch));
        await lsp("symbols", { file: publicImplementation }); await lsp("symbols", { file: realHeader });
        const publicDefinition = await lsp("definition", { file: realHeader, line: declarationLine, symbol: publicSymbol });
        assert(count(publicDefinition, "definition") >= 1);
        assert(publicDefinition.includes(`${publicImplementation}:${implementationLine}:`), publicDefinition);
        report("real_cross_file_definition", publicDefinition);
        await lsp("symbols", { file: realFile });
        const localDefinition = await lsp("definition", { file: realFile, line: symbolUse, symbol: realSymbol });
        assert(localDefinition.includes(`${realFile}:${symbolDefinition}:`), localDefinition);
        const realReferences = await untilReferences(realFile, realSymbol, 2, symbolDefinition);
        assert(realReferences.includes(`${realFile}:${symbolUse}:`), realReferences);
        report("real_references", { expected: 2, actual: count(realReferences, "reference"), definition: localDefinition, references: realReferences });
        const apiDefinition = await lsp("definition", { file: realFile, line: apiLine, symbol: realApi });
        assert(count(apiDefinition, "definition") >= 1);
        const canonicalSdk = (await shell(`readlink -f -- ${quote(sdk)}`)).trim();
        assert(apiDefinition.includes(`${sdk}/`) || apiDefinition.includes(`${canonicalSdk}/`), apiDefinition);
        assert.match(apiDefinition, /\/acl\/acl_rt\.h:\d+:/);
        report("real_cann_header_resolution", { api: realApi, definition: apiDefinition });
        const realDiagnostics = await lsp("diagnostics", { file: realFile });
        console.log("CPP_LSP_REAL_DIAGNOSTICS", JSON.stringify({ file: realFile, diagnostics: realDiagnostics }));
        assert.doesNotMatch(realDiagnostics, /no diagnostics report yet|file_not_found|file not found|'[^']+' file not found/i);
        const messages = realDiagnostics.split("\n").filter(line => /\[(?:error|warning|info|hint)\]/i.test(line));
        const counts = { error: 0, warning: 0, info: 0, hint: 0 };
        let projectWarnings = 0, vendorBoundaries = 0;
        if (realDiagnostics.trim() !== "OK") {
          assert(messages.length > 0, `No classified diagnostic messages: ${realDiagnostics}`);
          for (const message of messages) {
            const severity = message.match(/\[(error|warning|info|hint)\]/i)![1].toLowerCase() as keyof typeof counts;
            counts[severity]++;
            if (severity === "warning" && /\[clangd\].*Included header .* is not used directly.*\(unused-includes\)\s*$/.test(message)) {
              projectWarnings++;
            } else {
              assert.match(message,
                /__aicore__|__gm__|__global__|unknown.*attribute|unknown.*type.*half|unsupported option|unknown argument|undeclared identifier.*(?:Ascend|ASCEND)/i,
                `Unclassified real-project diagnostic requires investigation: ${message}`);
              vendorBoundaries++;
            }
          }
        }
        report("real_diagnostics", { diagnostics: realDiagnostics, counts, projectWarnings, vendorBoundaries },
          vendorBoundaries ? "upstream-vendor-dialect-boundary" : projectWarnings ? "project-diagnostics" : "positive");
        const afterReal = await inspectProject();
        assert.deepEqual(afterReal.hashes, baseline.hashes);
        report("real_readonly", { unchangedSourceHeaderAndDatabaseHashes: Object.keys(baseline.hashes).length, backgroundIndex: false, configurationInScratch: true });
      }
      assert.equal(modelTurns, 0); assert.equal(rows.length, realRoot ? 19 : 13);
      console.log("CPP_LSP_SMOKE_PASS", JSON.stringify({ checks: rows.length, modelTurns, classifications: rows.filter(row => row.outcome !== "positive"), realProject: !!realRoot }));
    } catch (error) {
      console.error("CPP_LSP_SMOKE_FAILED", JSON.stringify({ completedChecks: rows, error: error instanceof Error ? error.stack : String(error) })); throw error;
    } finally {
      try {
        if (scratch) {
          if (!connected) await connect(reconnectArgs(scratch));
          await shell(`rm -rf -- ${quote(scratch)}`);
        }
      } finally {
        if (connected) await exit();
        session.yieldQueue.clear(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE);
        session.agent.prompt = previousPrompt; session.agent.state.isStreaming = previousStreaming;
        session.setClientBridge(previousBridge);
        for (const { key, previous } of settings) key.override(session.settings, previous as never);
      }
    }
    process.exit(0);
  }});
}
