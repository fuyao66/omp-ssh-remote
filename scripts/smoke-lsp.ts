// Run through build-smoke.ts/run-smoke.ts lsp; never invoke this file as a standalone mock host.
// REMOTE_CONNECT_ARGS selects an existing SSH alias (with lsp.python/typescript opted in).
// Everything written remotely lives in a fresh mktemp directory, removed in finally.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveLocalHostSession } from "../src/omp/host-session.ts";
import { parseConnectArgs } from "../src/connect-options.ts";
import { lspFixtureSource } from "./fixtures/lsp-server.ts";
import { bootstrapSmokeHost } from "./smoke-host.ts";

const text = (result: any): string => result.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const count = (value: string, label: string): number => {
  const match = value.match(new RegExp(`Found (\\d+) ${label}\\(s\\)`));
  assert(match, `Missing numerical ${label} result: ${value}`);
  return Number(match[1]);
};
const mathSource = [
  "interface Shape { area(): number; }",
  "class Circle implements Shape { area(): number { return 1; } }",
  "const shape: Shape = new Circle();",
  "function add(a: number, b: number): number { return a + b; }",
  "const first = add(1, 2);",
  "const second = add(3, 4);",
  "export { shape, first, second };", "",
].join("\n");

export default async function lspSmoke(pi: ExtensionAPI) {
  const args = process.env.REMOTE_CONNECT_ARGS;
  if (!args) throw new Error("REMOTE_CONNECT_ARGS must select an SSH test host; use an alias with Python/TypeScript LSP opt-ins");
  const commands = await bootstrapSmokeHost(pi);
  pi.registerCommand("remote-lsp-smoke", { description: "Native LSP semantic and deferred-delivery acceptance (scratch only)", async handler(_, ctx) {
    const session = resolveLocalHostSession(ctx.sessionManager.getSessionFile(), ctx);
    assert(session, "Native session must be registered on its home thread");
    const rows: { check: string; outcome: string; evidence: unknown }[] = [];
    const report = (check: string, evidence: unknown, outcome = "positive") => {
      rows.push({ check, outcome, evidence });
      console.log("LSP_CHECK", JSON.stringify(rows.at(-1)));
    };
    const originalBridge = session.clientBridge;
    const originalPrompt = session.agent.prompt;
    const originalStreaming = session.agent.state.isStreaming;
    const settings: { key: AnySetting; previous: unknown }[] = [];
    session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
    // Hold native idle flushing while this command inspects/drains the actual queue.
    // This is a test scheduling gate, not a replacement dispatcher or provider.
    session.agent.state.isStreaming = true;
    let modelTurns = 0;
    session.agent.prompt = async () => { modelTurns++; throw new Error("Unexpected model turn in LSP acceptance"); };
    let connected = false;
    let scratch: string | undefined;
    const invoke = async (name: string, params: object, signal?: AbortSignal): Promise<any> => {
      const tool = session.getToolByName(name); assert(tool, `Missing native tool ${name}`);
      const timeout = AbortSignal.timeout(45_000);
      return tool.execute(crypto.randomUUID(), params, signal ? AbortSignal.any([signal, timeout]) : timeout, undefined,
        { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
    };
    const ok = async (name: string, params: object): Promise<any> => {
      const result = await invoke(name, params);
      assert(!result.isError && result.details?.success !== false, `${name} ${JSON.stringify(params)}: ${text(result)}`);
      return result;
    };
    const lsp = (action: string, params: object = {}) => ok("lsp", { action, ...params });
    // Native bash appends "Wall time: …" to slow commands; file-content checks compare only the output.
    const shell = async (command: string): Promise<string> => {
      const result = await ok("bash", { command });
      return result.details?.wallTimeNoticeEmitted ? text(result).replace(/\n\nWall time: [^\n]*$/, "") : text(result);
    };
    const disk = async (path: string): Promise<string> => shell(`cat -- ${quote(path)}`);
    const write = (path: string, content: string) => ok("write", { path, content });
    const failure = async (params: object, expected: RegExp): Promise<string> => {
      const result = await invoke("lsp", params).catch(error => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
      assert(result.isError || result.details?.success === false, `Expected failure: ${text(result)}`);
      assert.match(text(result), expected); return text(result);
    };
    const until = async (description: string, predicate: () => Promise<boolean> | boolean, timeout = 6_000): Promise<void> => {
      const deadline = performance.now() + timeout;
      while (!await predicate()) {
        assert(performance.now() < deadline, `Timed out: ${description}`);
        await Bun.sleep(25);
      }
    };
    const drain = (): any[] => session.yieldQueue.drainLazy().map(build => build()).filter(Boolean);
    const lateFiles = (messages: any[]): any[] => messages.filter(message => message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE).flatMap(message => message.details?.files ?? []);
    const reconnectArgs = (cwd: string): string => {
      const request = parseConnectArgs(args);
      return [quote(request.displayTarget), quote(cwd), ...(request.port ? ["--port", String(request.port)] : []),
        ...(request.identityFile ? ["--identity", quote(request.identityFile)] : []),
        ...(request.knownHostsFile ? ["--known-hosts", quote(request.knownHostsFile)] : [])].join(" ");
    };
    const connect = async (value: string) => { await commands.get("remote-connect")!.handler(value, ctx); connected = true; };
    const exit = async () => { await commands.get("remote-exit")!.handler("", ctx); connected = false; };
    try {
      for (const [name, value] of Object.entries({ "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": true, "lsp.diagnosticsOnEdit": true, "lsp.diagnosticsDeduplicate": true, "lsp.requestTimeout": 15 })) {
        const key = lookup(name); assert(key, `Native setting unavailable: ${name}`);
        settings.push({ key, previous: key.get(session.settings) }); key.override(session.settings, value as never);
      }
      await connect(args);
      scratch = (await shell("mktemp -d /tmp/omp-lsp-smoke-XXXXXXXX")).trim();
      assert.match(scratch, /^\/tmp\/omp-lsp-smoke-[A-Za-z0-9]+$/);
      // Setup uses bash to avoid accidental formatting/diagnostics under the initial cwd.
      const files: Record<string, string> = {
        "package.json": '{"private":true,"type":"module"}\n',
        "tsconfig.json": '{"compilerOptions":{"strict":true,"noUnusedLocals":true,"target":"ES2020","module":"ESNext","moduleResolution":"node"},"include":["*.ts"]}\n',
        "pyproject.toml": '[project]\nname="lsp-smoke"\nversion="0.0.0"\n',
        "math.ts": mathSource,
        "model.ts": "export const marker = 7;\n",
        "consumer.ts": 'import { marker } from "./model";\nexport const consumed = marker;\n',
        "actions.ts": "export const actionResult = marker;\n",
        "sample.py": "def add(a: int, b: int) -> int:\n    return a + b\n\nfirst = add(1, 2)\nsecond = add(3, 4)\n",
        "fixture.py": lspFixtureSource,
        "source.smoke": "CLEAN_SOURCE_BEFORE\n",
        "lsp.json": JSON.stringify({ servers: { "smoke-fixture": { command: "python3", args: ["-u", `${scratch}/fixture.py`, `${scratch}/fixture.log`], fileTypes: [".smoke"], rootMarkers: ["lsp.json"], languageId: "plaintext" } } }),
      };
      for (const [name, content] of Object.entries(files)) await shell(`printf %s ${quote(content)} > ${quote(`${scratch}/${name}`)}`);
      await exit(); await connect(reconnectArgs(scratch));
      const file = `${scratch}/math.ts`;
      const fixture = `${scratch}/late.smoke`;
      const uri = `file://${fixture}`;
      const request = (query: string, payload: object = {}, signal?: AbortSignal) => invoke("lsp", { action: "request", file: fixture, query, payload: JSON.stringify(payload) }, signal);
      const release = (version?: number) => request("smoke/release", { uri, ...(version !== undefined ? { version } : {}) });
      const fixtureState = async () => {
        const result = await request("smoke/state"); assert(result.details?.success, text(result));
        return JSON.parse(text(result).slice(text(result).indexOf("\n") + 1));
      };
      const status = text(await lsp("status")); assert.match(status, /configured|started/i); report("status", status);
      const caps = text(await lsp("capabilities", { file })); assert.match(caps, /definitionProvider/); report("capabilities", caps);
      const symbols = text(await lsp("symbols", { file })); assert.match(symbols, /Shape/); assert.match(text(await lsp("symbols", { file: "*", query: "Circle" })), /Circle/); report("symbols", "document Shape and workspace Circle");
      const hover = text(await lsp("hover", { file, line: 5, symbol: "add" })); assert.match(hover, /a: number/); report("hover", hover);
      const definition = text(await lsp("definition", { file, line: 5, symbol: "add" })); assert.equal(count(definition, "definition"), 1); assert.match(definition, /math\.ts:4/); report("definition", { count: 1, targetLine: 4 });
      const type = text(await lsp("type_definition", { file, line: 3, symbol: "shape" })); assert.equal(count(type, "type definition"), 1); assert.match(type, /math\.ts:1/); report("type_definition", { count: 1, targetLine: 1 });
      const implementation = text(await lsp("implementation", { file, line: 1, symbol: "Shape" })); assert.equal(count(implementation, "implementation"), 1); assert.match(implementation, /math\.ts:2/); report("implementation", { count: 1, targetLine: 2 });
      const references = text(await lsp("references", { file, line: 4, symbol: "add" })); assert.equal(count(references, "reference"), 3); report("references", { expected: 3, actual: count(references, "reference") });
      await lsp("rename", { file, line: 4, symbol: "add", new_name: "sum", apply: false }); assert.equal(await disk(file), mathSource);
      await lsp("rename", { file, line: 4, symbol: "add", new_name: "sum", apply: true }); const renamed = await disk(file); assert.equal(renamed, mathSource.replaceAll("add(", "sum(")); report("rename", { expectedOccurrences: 3, actualOccurrences: renamed.match(/sum\(/g)?.length, previewUnchanged: true });
      const model = `${scratch}/model.ts`; const moved = `${scratch}/renamed.ts`;
      await lsp("rename_file", { file: model, new_name: moved, apply: false }); assert.equal(await disk(model), files["model.ts"]);
      await lsp("rename_file", { file: model, new_name: moved, apply: true }); assert.equal(await disk(moved), files["model.ts"]); assert.equal((await shell(`test ! -e ${quote(model)} && printf absent`)).trim(), "absent"); assert.match(await disk(`${scratch}/consumer.ts`), /["']\.\/renamed["']/); report("rename_file", { sourceAbsent: true, destinationBytes: files["model.ts"].length, importUpdated: true });
      const actionsFile = `${scratch}/actions.ts`; const beforeActions = await disk(actionsFile);
      // Missing-name diagnostics are semantic errors, unlike unused-declaration
      // suggestions; seed the native diagnostic cache before requesting quick fixes.
      const actionDiagnostics = text(await lsp("diagnostics", { file: actionsFile })); assert.match(actionDiagnostics, /2304|Cannot find name ['"]marker['"]/);
      const actions = text(await lsp("code_actions", { file: actionsFile, line: 1, symbol: "marker" }));
      assert.match(actions, /Add import.*renamed/); assert.equal(await disk(actionsFile), beforeActions);
      const appliedAction = text(await lsp("code_actions", { file: actionsFile, line: 1, symbol: "marker", query: "Add import", apply: true })); assert.match(appliedAction, /Applied/);
      const afterActions = await disk(actionsFile); assert.match(afterActions, /import\s*\{\s*marker\s*\}\s*from\s*["']\.\/renamed["']/); assert.match(afterActions, /export const actionResult = marker;/);
      const afterActionDiagnostics = text(await lsp("diagnostics", { file: actionsFile })); assert.equal(afterActionDiagnostics.trim(), "OK");
      report("code_actions", { previewUnchanged: true, importInserted: true, diagnosticBefore: actionDiagnostics, diagnosticAfter: afterActionDiagnostics });
      const rawHover = await lsp("request", { file, query: "textDocument/hover", line: 5, symbol: "sum" }); assert.match(text(rawHover), /number/); report("request", "real server textDocument/hover");
      await failure({ action: "request", file, query: "textDocument/hover", payload: "{" }, /invalid JSON/); report("invalid_payload", "invalid JSON rejected", "error");
      const unknown = await failure({ action: "request", file, query: "smoke/notImplemented" }, /[Mm]ethod|not found|unhandled/i); report("unknown_method", unknown, "unsupported");
      const reloaded = text(await lsp("reload", { file })); assert.match(reloaded, /[Rr]eload|[Rr]estart/); assert.equal(count(text(await lsp("references", { file, line: 4, symbol: "sum" })), "reference"), 3); report("reload", "references remain exactly 3 after reload");
      const unformatted = "export function twice(x:number){return x*2}\n"; const formatFile = `${scratch}/format.ts`;
      const formattedResult = await write(formatFile, unformatted); const formatted = await disk(formatFile);
      assert.notEqual(formatted, unformatted, `formatOnWrite did not change bytes: ${JSON.stringify(formattedResult.details)}`); assert.match(formatted, /x: number/); report("format_on_write", { beforeBytes: Buffer.byteLength(unformatted), afterBytes: Buffer.byteLength(formatted), bytesDiffer: formatted !== unformatted, formatter: formattedResult.details?.diagnostics?.formatter });
      const python = `${scratch}/sample.py`;
      const pyDef = text(await lsp("definition", { file: python, line: 4, symbol: "add" })); assert.equal(count(pyDef, "definition"), 1); assert.match(pyDef, /sample\.py:1/);
      const pyRefs = text(await lsp("references", { file: python, line: 1, symbol: "add" })); assert.equal(count(pyRefs, "reference"), 3); report("python_semantics", { definitions: 1, references: 3 });
      await write(`${scratch}/invalid.ts`, 'export const bad: number = "not a number";\n');
      const tsDiagnostics = text(await lsp("diagnostics", { file: `${scratch}/invalid.ts` })); assert.match(tsDiagnostics, /2322|not assignable/);
      await write(`${scratch}/invalid.py`, 'def broken(:\n    pass\n');
      const pyDiagnostics = text(await lsp("diagnostics", { file: `${scratch}/invalid.py` })); assert.match(pyDiagnostics, /error|Expected|expected/);
      // Deterministic fixture results below are transport contracts, not TS/Pyright semantics.
      const sourceFile = `${scratch}/source.smoke`;
      const sourceBefore = files["source.smoke"];
      const sourceActions = text(await lsp("code_actions", { file: sourceFile, line: 1 }));
      assert.match(sourceActions, /^1 code action\(s\):/); assert.match(sourceActions, /Fixture organize imports/);
      const narrowedSourceActions = text(await lsp("code_actions", { file: sourceFile, line: 1, query: "source.organizeImports" }));
      assert.match(narrowedSourceActions, /^1 code action\(s\):/); assert.equal(await disk(sourceFile), sourceBefore);
      const sourceApplied = text(await lsp("code_actions", { file: sourceFile, line: 1, query: "Fixture organize imports", apply: true }));
      assert.match(sourceApplied, /Applied "Fixture organize imports"/);
      assert.equal(await disk(sourceFile), "CLEAN_SOURCE_APPLIED\n");
      assert.equal(text(await lsp("diagnostics", { file: sourceFile })).trim(), "OK");
      const sourceRequests = (await disk(`${scratch}/fixture.log`)).trim().split("\n").map(line => JSON.parse(line))
        .filter(row => row.event === "code-action" && row.uri === `file://${sourceFile}`);
      assert.equal(sourceRequests.length, 5);
      assert.equal(sourceRequests.filter(row => row.only == null).length, 2);
      assert.equal(sourceRequests.filter(row => JSON.stringify(row.only) === '["source"]').length, 2);
      assert.equal(sourceRequests.filter(row => JSON.stringify(row.only) === '["source.organizeImports"]').length, 1);
      assert(sourceRequests.every(row => row.diagnostics.length === 0), "Source actions must work without quick-fix diagnostics");
      report("source_code_action", { source: "deterministic-fixture", listed: 1, previewUnchanged: true, appliedExactBytes: true, ordinaryRequests: 2, sourceRequests: 2, narrowedRequests: 1, diagnosticsAfter: "OK" });
      const inline = await write(fixture, "INLINE_ERROR\n"); assert.match(JSON.stringify(inline.details), /INLINE_ERROR/);
      const explicitDiagnostics = text(await lsp("diagnostics", { file: fixture })); assert.match(explicitDiagnostics, /1 error\(s\)/); assert.match(explicitDiagnostics, /INLINE_ERROR/);
      report("write_diagnostics", { source: "deterministic-fixture-inline-and-real-servers", inline: true, explicitDiagnostics, tsDiagnostics, pyDiagnostics });
      const read = text(await ok("read", { path: fixture })); const header = read.match(/\[[^\]\n]+#[A-Fa-f0-9]+\]/)?.[0]; assert(header, read);
      const edited = await ok("edit", { input: `${header}\nPUT 1.=1:\n+EDIT_ERROR` }); assert.match(JSON.stringify(edited.details), /EDIT_ERROR/); assert.equal(await disk(fixture), "EDIT_ERROR\n"); report("edit_diagnostics", { source: "deterministic-fixture", inline: true });
      drain();
      const unsupported = await failure({ action: "implementation", file: fixture, line: 1, symbol: "EDIT_ERROR" }, /[Mm]ethod not found/);
      await failure({ action: "request", file: fixture, query: "smoke/fail" }, /intentional fixture failure/); report("unsupported_vs_failure", { unsupported, explicitFailure: "intentional fixture failure" }, "classified");
      const controller = new AbortController();
      const hanging = request("smoke/hang", {}, controller.signal).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
      await until("fixture observed hanging request", async () => (await disk(`${scratch}/fixture.log`)).includes('"method":"smoke/hang"'));
      controller.abort(); const cancelled = await hanging;
      if (cancelled.error) assert.match(String(cancelled.error), /abort|cancel/i);
      else { assert(cancelled.result?.isError || cancelled.result?.details?.success === false); assert.match(text(cancelled.result), /abort|cancel/i); }
      await until("LSP cancellation notification", async () => (await disk(`${scratch}/fixture.log`)).includes('"event":"cancelled"'));
      assert.deepEqual((await fixtureState()).pending, []); report("cancellation", "cancelRequest observed; fixture has no pending request");
      const held = await write(fixture, "HOLD_LATE_ERROR\n"); assert.equal(held.details?.diagnostics?.messages?.length ?? 0, 0, "Diagnostics were not deferred");
      await release(); await until("late diagnostics in native queue", () => session.yieldQueue.hasDeliverable(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE));
      const delivered = lateFiles(drain()).filter(entry => entry.path === fixture); assert.equal(delivered.length, 1);
      assert.equal(delivered[0].errored, true); assert.equal(delivered[0].messages.length, 1); assert.match(delivered[0].messages[0], /HOLD_LATE_ERROR/);
      report("deferred_delivery", { nativeKind: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entries: delivered.length, pathMatches: true, errored: delivered[0].errored, messages: delivered[0].messages });
      await write(fixture, "HOLD_LATE_ERROR\n"); await release();
      // Absence needs a bounded observation window: a request response alone does not
      // prove the independent native diagnostics waiter has completed its settle interval.
      await fixtureState(); const quietUntil = performance.now() + 1_000;
      while (performance.now() < quietUntil) { assert.equal(lateFiles(drain()).length, 0); await Bun.sleep(25); }
      report("deduplication", { repeatedDiagnosticDeliveries: 0, observationMs: 1_000 });
      await write(fixture, "HOLD_STALE_ERROR\n"); await release();
      await until("stale candidate queued", () => session.yieldQueue.has(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE));
      const staleThunks = session.yieldQueue.drainLazy();
      await write(fixture, "CLEAN\n");
      assert.equal(lateFiles(staleThunks.map(build => build()).filter(Boolean)).length, 0); assert.equal(lateFiles(drain()).length, 0);
      await write(fixture, "HOLD_SOURCE_STALE_ERROR\n"); await release();
      await until("source-action stale candidate queued", () => session.yieldQueue.has(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE));
      const sourceStaleThunks = session.yieldQueue.drainLazy();
      await lsp("code_actions", { file: fixture, line: 1, query: "Fixture organize imports", apply: true });
      assert.equal(await disk(fixture), "CLEAN_SOURCE_APPLIED\n");
      assert.equal(lateFiles(sourceStaleThunks.map(build => build()).filter(Boolean)).length, 0); assert.equal(lateFiles(drain()).length, 0); report("stale_generation", { cleanWriteDroppedOldDiagnostic: true, sourceActionDroppedOldDiagnostic: true });
      await write(fixture, "HOLD_DISCONNECT_ERROR\n"); await release();
      await until("disconnect candidate queued", () => session.yieldQueue.has(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE));
      const disconnectThunks = session.yieldQueue.drainLazy();
      await exit();
      assert.equal(lateFiles(disconnectThunks.map(build => build()).filter(Boolean)).length, 0); report("binding_ownership", "old binding diagnostic rejected after remote-exit");
      assert.equal(modelTurns, 0); assert.equal(rows.length, 26, `Expected 26 checks, got ${rows.length}`);
      console.log("LSP_SMOKE_PASS", JSON.stringify({ checks: rows.length, positive: rows.filter(row => row.outcome === "positive").length, classifications: rows.filter(row => row.outcome !== "positive"), modelTurns,
        limitations: ["Host read-only/device-only policy forwarding has no supported native getter; this smoke does not claim coverage"] }));
    } catch (error) {
      console.error("LSP_SMOKE_FAILED", JSON.stringify({ completedChecks: rows, error: error instanceof Error ? error.stack : String(error) })); throw error;
    } finally {
      try {
        if (scratch) {
          if (!connected) await connect(reconnectArgs(scratch));
          await shell(`rm -rf -- ${quote(scratch)}`);
        }
      } finally {
        if (connected) await exit();
        session.yieldQueue.clear(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE);
        session.agent.prompt = originalPrompt; session.agent.state.isStreaming = originalStreaming;
        session.setClientBridge(originalBridge);
        for (const { key, previous } of settings) key!.override(session.settings, previous as never);
      }
    }
    process.exit(0);
  }});
}
