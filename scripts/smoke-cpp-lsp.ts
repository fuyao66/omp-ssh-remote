// Run with build-smoke.ts/run-smoke.ts cpp-lsp and REMOTE_CONNECT_ARGS selecting lsp.cpp:true.
// Optional read-only project acceptance requires REMOTE_CPP_PROJECT_{ROOT,DATABASE,FILE,SYMBOL,
// LINE,DEFINITION_FILE,DEFINITION_LINE,REFERENCE_COUNT}; paths are remote, absolute or root-relative.
// REMOTE_CPP_PROJECT_DIAGNOSTIC_PATTERN optionally permits known diagnostic messages (JavaScript regexp).
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveLocalHostSession } from "../src/omp/host-session.ts";
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
    const session = resolveLocalHostSession(ctx.sessionManager.getSessionFile(), ctx);
    assert(session, "Native session must be registered on its home thread");
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
        const required = (key: string): string => {
          const value = process.env[`REMOTE_CPP_PROJECT_${key}`];
          if (!value?.trim()) throw new Error(`REMOTE_CPP_PROJECT_${key} is required in project mode`);
          return value;
        };
        const projectPath = (key: string): string => {
          const value = required(key);
          return value.startsWith("/") ? value : `${realRoot}/${value}`;
        };
        const integer = (key: string, minimum: number): number => {
          const value = required(key);
          assert.match(value, /^\d+$/, `REMOTE_CPP_PROJECT_${key} must be an integer`);
          const result = Number(value);
          assert(Number.isSafeInteger(result) && result >= minimum, `Invalid REMOTE_CPP_PROJECT_${key}`);
          return result;
        };
        const realFile = projectPath("FILE"), database = projectPath("DATABASE");
        const definitionFile = projectPath("DEFINITION_FILE"), definitionLine = integer("DEFINITION_LINE", 1);
        const symbol = required("SYMBOL"), line = integer("LINE", 1), referenceCount = integer("REFERENCE_COUNT", 0);
        const diagnosticPattern = process.env.REMOTE_CPP_PROJECT_DIAGNOSTIC_PATTERN;
        const allowedDiagnostic = diagnosticPattern ? new RegExp(diagnosticPattern) : undefined;
        const inspect = [
          "import json,pathlib,hashlib,shlex",
          `db=pathlib.Path(${JSON.stringify(database)}).resolve(); p=pathlib.Path(${JSON.stringify(realFile)}).resolve()`,
          'assert db.name=="compile_commands.json","REMOTE_CPP_PROJECT_DATABASE must resolve to a file named compile_commands.json"',
          'd=json.loads(db.read_text())',
          'def source(entry):',
          '    path=pathlib.Path(entry["file"]); directory=pathlib.Path(entry["directory"])',
          '    return (path if path.is_absolute() else directory/path).resolve()',
          'selected=[x for x in d if source(x)==p]',
          'assert len(selected)==1,"Expected exactly one compile command for the selected file"',
          'entry=selected[0]; argv=entry.get("arguments") or shlex.split(entry["command"])',
          `paths={db,p,pathlib.Path(${JSON.stringify(definitionFile)}).resolve()}`,
          'print(json.dumps({"entries":len(d),"existingSources":sum(source(x).is_file() for x in d),',
          '"databaseDirectory":str(db.parent),"selected":{"file":str(p),"directory":entry["directory"],"driver":argv[0],"argumentCount":len(argv),',
          '"commandSha256":hashlib.sha256(json.dumps(argv).encode()).hexdigest()},',
          '"hashes":{str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in paths}}))',
        ].join("\n");
        const inspectProject = async () => {
          const output = (await shell(`python3 -c ${quote(inspect)}`)).trim();
          assert.doesNotMatch(output, /truncated|artifact:\/\//i, "Project metadata transport was truncated");
          return JSON.parse(output);
        };
        const baseline = await inspectProject();
        assert(baseline.existingSources > 0); report("real_compile_database", baseline);
        // Keep index/configuration writes in scratch; existing source and compile commands stay unchanged.
        const realScratch = `${scratch}/real-project`;
        await shell(`mkdir -- ${quote(realScratch)}`);
        const config = { servers: { clangd: { command: clangd, args: ["--background-index=false", "--clang-tidy", "--header-insertion=iwyu", `--compile-commands-dir=${baseline.databaseDirectory}`], rootMarkers: ["."] } } };
        await shell(`printf %s ${quote(JSON.stringify(config))} > ${quote(`${realScratch}/lsp.json`)}`);
        await exit(); await connect(reconnectArgs(realScratch));
        await lsp("symbols", { file: definitionFile }); await lsp("symbols", { file: realFile });
        const definition = await lsp("definition", { file: realFile, line, symbol });
        assert(count(definition, "definition") >= 1);
        assert(definition.includes(`${definitionFile}:${definitionLine}:`), definition);
        report("real_cross_file_definition", definition);
        const references = await untilReferences(realFile, symbol, referenceCount, line);
        report("real_references", { expected: referenceCount, actual: count(references, "reference"), references });
        const diagnostics = await lsp("diagnostics", { file: realFile });
        assert.doesNotMatch(diagnostics, /no diagnostics report yet|file_not_found|file not found|'[^']+' file not found/i);
        const messages = diagnostics.split("\n").filter(message => /\[(?:error|warning|info|hint)\]/i.test(message));
        if (diagnostics.trim() !== "OK") {
          assert(messages.length > 0, `No classified diagnostic messages: ${diagnostics}`);
          assert(allowedDiagnostic, `Project diagnostics require an explicit REMOTE_CPP_PROJECT_DIAGNOSTIC_PATTERN: ${diagnostics}`);
          for (const message of messages) assert.match(message, allowedDiagnostic);
        }
        report("real_diagnostics", { diagnostics, allowedPattern: diagnosticPattern ?? null, messages: messages.length }, messages.length ? "expected-project-diagnostics" : "positive");
        assert.deepEqual((await inspectProject()).hashes, baseline.hashes);
        report("real_readonly", { unchangedSourceAndDatabaseHashes: Object.keys(baseline.hashes).length, backgroundIndex: false, configurationInScratch: true });
      }
      assert.equal(modelTurns, 0); assert.equal(rows.length, realRoot ? 18 : 13);
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
