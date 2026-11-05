import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { adaptNativeLspConfig } from "../src/native-lsp-config-adapter.ts";
import { adaptNativeMutationSettlement } from "../src/omp/native-mutation-adapter.ts";
import { SDK_SOURCE_ADAPTATIONS, SUPPORTED_SDK_VERSION, sdkAdaptationLabel } from "../src/omp/sdk-contract.ts";
import { SEMANTIC_SDK_CONTRACTS } from "./sdk-semantic-contracts.ts";

const root = resolve(import.meta.dir, "..");
const sdkPackages = [
  "@oh-my-pi/omptype", "@oh-my-pi/pi-agent-core", "@oh-my-pi/pi-natives",
  "@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-tui", "@oh-my-pi/pi-utils",
] as const;
type Manifest = { name?: string; version?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type Check = { check: string; status: "PASS" | "WARN" | "FAIL"; detail: string };

async function manifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

/** Follow Bun's actual entry resolution rather than assuming a node_modules layout or CLI on PATH. */
async function installedVersion(name: string): Promise<string> {
  let directory = dirname(Bun.resolveSync(name, root));
  while (true) {
    try {
      const value = await manifest(join(directory, "package.json"));
      if (value.name === name) {
        if (!value.version) throw new Error(`${name} has no version in ${directory}/package.json`);
        return value.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name}'s package.json from its resolved entry`);
    directory = parent;
  }
}

/** Include type-only imports/re-exports, dynamic imports and import types, not comments or arbitrary strings. */
function sdkImports(path: string, source: string): Set<string> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith("@oh-my-pi/")) imports.add(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const run = async (check: string, action: () => Promise<string>) => {
    try { checks.push({ check, status: "PASS", detail: await action() }); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({ check, status: "FAIL", detail: detail.split("\n")[0] });
      failures.push(`${check}: ${detail}`);
    }
  };
  const workspace = await manifest(join(root, "package.json"));
  const versions = new Map<string, string>();
  for (const name of sdkPackages) {
    await run(name, async () => {
      const version = await installedVersion(name);
      versions.set(name, version);
      const pin = workspace.dependencies?.[name];
      if (pin !== SUPPORTED_SDK_VERSION || version !== SUPPORTED_SDK_VERSION) {
        throw new Error(`requires exact pin and installed version ${SUPPORTED_SDK_VERSION}; package.json=${pin ?? "missing"}, installed=${version}; update pins and src/omp/sdk-contract.ts together, then bun install`);
      }
      return `${version} (exact pin + installed)`;
    });
  }
  const unexpected = Object.keys(workspace.dependencies ?? {}).filter(name => name.startsWith("@oh-my-pi/") && !sdkPackages.some(expected => expected === name));
  if (unexpected.length) {
    checks.push({ check: "SDK dependency inventory", status: "FAIL", detail: unexpected.join(", ") });
    failures.push(`Unregistered SDK dependencies: ${unexpected.join(", ")}; review and update scripts/check-sdk.ts's dependency inventory`);
  }
  await run("plugin peer floor", async () => {
    const plugin = await manifest(join(root, "packages/omp/package.json"));
    const expected = `>=${SUPPORTED_SDK_VERSION}`;
    const actual = plugin.peerDependencies?.["@oh-my-pi/pi-coding-agent"];
    if (actual !== expected) throw new Error(`packages/omp/package.json must declare @oh-my-pi/pi-coding-agent ${expected}, got ${actual ?? "missing"}`);
    return expected;
  });
  for (const adaptation of SDK_SOURCE_ADAPTATIONS) {
    await run(adaptation.id, async () => {
      try {
        const version = versions.get("@oh-my-pi/pi-coding-agent");
        if (!version) throw new Error("Cannot determine installed SDK version; run bun install first");
        const source = await readFile(Bun.resolveSync(adaptation.sdkModule, root), "utf8");
        if (adaptation.kind === "lsp-config") {
          adaptNativeLspConfig(source, version, join(root, "src/python-lsp-fallback.ts"));
        } else {
          adaptNativeMutationSettlement(source, version, adaptation.module, join(root, "src/omp/mutation-settlement.ts"));
        }
        return `${Object.keys(adaptation.anchors).length} anchors; ${adaptation.sdkModule}`;
      } catch (error) {
        throw new Error(`${sdkAdaptationLabel(adaptation)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  await run("plugin SDK imports", async () => {
    const origins = new Map<string, string[]>();
    for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })) {
      for (const specifier of sdkImports(path, await readFile(join(root, path), "utf8"))) {
        const files = origins.get(specifier) ?? [];
        files.push(path);
        origins.set(specifier, files);
      }
    }
    if (!origins.size) throw new Error("No SDK imports found under src/**/*.ts; check the source scan before trusting this check");
    const unresolved: string[] = [];
    for (const [specifier, paths] of [...origins].sort(([left], [right]) => left.localeCompare(right))) {
      try { Bun.resolveSync(specifier, root); }
      catch { unresolved.push(`${specifier} (imported by ${paths.join(", ")})`); }
    }
    if (unresolved.length) throw new Error(`Unresolvable SDK imports; update callers for the installed SDK:\n${unresolved.join("\n")}`);
    return `${origins.size} unique specifiers resolve from repository root`;
  });
  await run("semantic SDK contracts", async () => {
    const sdkSource = dirname(Bun.resolveSync("@oh-my-pi/pi-coding-agent/sdk", root));
    const ids = new Set<string>();
    for (const contract of SEMANTIC_SDK_CONTRACTS) {
      if (ids.has(contract.id)) throw new Error(`Duplicate semantic contract id: ${contract.id}`);
      ids.add(contract.id);
      for (const [base, paths] of [[root, contract.plugin], [sdkSource, contract.native]] as const) {
        for (const path of paths) {
          if (!(await stat(join(base, path))).isFile()) throw new Error(`${contract.id}: not a file: ${join(base, path)}`);
        }
      }
      for (const test of contract.coveredBy) {
        const source = await readFile(join(root, test.path), "utf8");
        if (test.name && !source.includes(test.name)) throw new Error(`${contract.id}: test name ${JSON.stringify(test.name)} not found in ${test.path}`);
      }
    }
    const gaps = SEMANTIC_SDK_CONTRACTS.filter(contract => contract.gap).length;
    return `${SEMANTIC_SDK_CONTRACTS.length} entries; paths + test references verified; ${gaps} manual-review gaps (not semantic verification)`;
  });
  for (const contract of SEMANTIC_SDK_CONTRACTS) {
    if (contract.gap) checks.push({ check: `semantic gap: ${contract.id}`, status: "WARN", detail: contract.gap });
  }
  console.log(`OMP SDK contract: ${SUPPORTED_SDK_VERSION}`);
  console.table(checks);
  if (failures.length) {
    console.error(`\n${failures.join("\n\n")}\n\nFollow README.md: Upgrading OMP. Do not loosen anchors or version guards to bypass drift.`);
    process.exitCode = 1;
  }
}

await main().catch(error => {
  console.error(`check:sdk failed: ${error instanceof Error ? error.message : String(error)}; run bun install and follow README.md: Upgrading OMP`);
  process.exitCode = 1;
});
