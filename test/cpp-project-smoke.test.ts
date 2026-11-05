import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let projectMode: (...args: unknown[]) => Promise<void>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cpp project acceptance "));
  await mkdir(join(root, "build")); await mkdir(join(root, "scratch"));
  await writeFile(join(root, "consumer.cpp"), "int answer();\nint main() { return answer(); }\n");
  await writeFile(join(root, "definition.cpp"), "int answer() { return 42; }\n");
  await writeFile(join(root, "build/compile_commands.json"), JSON.stringify([
    { directory: root, file: "consumer.cpp", arguments: ["c++", "-c", "consumer.cpp"] },
  ]));
  const source = await readFile(new URL("../scripts/smoke-cpp-lsp.ts", import.meta.url), "utf8");
  const start = source.indexOf("      const realRoot = process.env.REMOTE_CPP_PROJECT_ROOT;");
  const end = source.indexOf("      assert.equal(modelTurns, 0);", start);
  assert(start > 0 && end > start, "Project smoke acceptance block must remain identifiable");
  const transformed = await new Bun.Transpiler({ loader: "ts" }).transform(source.slice(start, end));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  projectMode = new AsyncFunction("process", "assert", "shell", "quote", "scratch", "clangd", "exit", "connect", "reconnectArgs", "lsp", "untilReferences", "count", "report", transformed);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function run(overrides: Record<string, string | undefined> = {}, diagnostics = "OK") {
  const reports: Array<{ check: string; evidence: unknown }> = [];
  const env = {
    REMOTE_CPP_PROJECT_ROOT: root, REMOTE_CPP_PROJECT_DATABASE: "build/compile_commands.json",
    REMOTE_CPP_PROJECT_FILE: "consumer.cpp", REMOTE_CPP_PROJECT_SYMBOL: "answer", REMOTE_CPP_PROJECT_LINE: "2",
    REMOTE_CPP_PROJECT_DEFINITION_FILE: "definition.cpp", REMOTE_CPP_PROJECT_DEFINITION_LINE: "1", REMOTE_CPP_PROJECT_REFERENCE_COUNT: "3",
    ...overrides,
  };
  const scratch = await mkdtemp(join(root, "scratch/run-"));
  const shell = async (command: string) => {
    const child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(status, 0, stderr); return stdout;
  };
  const count = (text: string, label: string) => Number(text.match(new RegExp(`Found (\\d+) ${label}\\(s\\)`))?.[1]);
  await projectMode({ env }, assert, shell, (value: string) => `'${value.replaceAll("'", "'\\''")}'`, scratch, "/fixture/clangd",
    async () => {}, async () => {}, (cwd: string) => cwd,
    async (action: string, params: { symbol?: string; line?: number }) => {
      if (action === "definition") {
        assert.equal(params.symbol, "answer"); assert.equal(params.line, 2);
        return `Found 1 definition(s)\n${root}/definition.cpp:1:1`;
      }
      return action === "diagnostics" ? diagnostics : "symbols";
    },
    async (file: string, symbol: string, expected: number, line: number) => {
      assert.equal(file, `${root}/consumer.cpp`); assert.equal(symbol, "answer"); assert.equal(expected, 3); assert.equal(line, 2);
      return "Found 3 reference(s)";
    }, count, (check: string, evidence: unknown) => reports.push({ check, evidence }));
  return reports;
}

test("generic project smoke uses explicit paths, exact locations/counts and read-only compile provenance", async () => {
  const reports = await run();
  expect(reports.map(report => report.check)).toEqual(["real_compile_database", "real_cross_file_definition", "real_references", "real_diagnostics", "real_readonly"]);
  expect(reports[0]!.evidence).toMatchObject({ selected: { file: `${root}/consumer.cpp` }, existingSources: 1 });
  expect(reports.at(-1)!.evidence).toMatchObject({ unchangedSourceAndDatabaseHashes: 3 });
});

test("generic project smoke rejects missing inputs, wrong definitions and unexplained diagnostics", async () => {
  await expect(run({ REMOTE_CPP_PROJECT_SYMBOL: undefined })).rejects.toThrow("REMOTE_CPP_PROJECT_SYMBOL is required");
  await expect(run({ REMOTE_CPP_PROJECT_DEFINITION_LINE: "2" })).rejects.toThrow();
  await expect(run({}, "[warning] expected project warning")).rejects.toThrow("DIAGNOSTIC_PATTERN");
  await expect(run({ REMOTE_CPP_PROJECT_DIAGNOSTIC_PATTERN: "expected project warning" }, "[warning] expected project warning")).resolves.toHaveLength(5);
  await expect(run({ REMOTE_CPP_PROJECT_DIAGNOSTIC_PATTERN: ".*" }, "[error] 'missing.hpp' file not found")).rejects.toThrow();
});

test("generic project smoke rejects a database basename clangd would not load", async () => {
  await writeFile(join(root, "build/custom-commands.json"), await readFile(join(root, "build/compile_commands.json")));
  await expect(run({ REMOTE_CPP_PROJECT_DATABASE: "build/custom-commands.json" })).rejects.toThrow(
    "REMOTE_CPP_PROJECT_DATABASE must resolve to a file named compile_commands.json",
  );
});
