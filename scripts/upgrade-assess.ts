/**
 * Read-only OMP upgrade assessment: `bun run upgrade:assess <version> [--from <version>] [--out report.md] [--json report.json]`.
 *
 * The baseline is the installed SDK, or `--from` when the pins were already bumped.
 *
 * Downloads the target SDK packages into a fresh temporary directory (never executed), then reports
 * what an upgrade must review: source-adaptation anchors against the target, every native file the
 * plugin imports or names in a semantic contract that changed or disappeared, and the target
 * CHANGELOG's breaking changes since the supported version. It changes nothing in the repository.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { SDK_SOURCE_ADAPTATIONS, SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";
import { SEMANTIC_SDK_CONTRACTS } from "./sdk-semantic-contracts.ts";

const root = resolve(import.meta.dir, "..");
export const SDK_PACKAGES = ["omptype", "pi-agent-core", "pi-natives", "pi-coding-agent", "pi-tui", "pi-utils"] as const;
type SdkPackage = (typeof SDK_PACKAGES)[number];

/** One native file, keyed as `<package>/<path inside the package>`, with the reasons the plugin depends on it. */
type Dependency = { pkg: SdkPackage; file: string; reasons: Set<string> };

type NativeFile = { pkg: SdkPackage; file: string };
type AssessedFile = NativeFile & { reasons: string[] };
type ChangedFile = AssessedFile & { added?: string; removed?: string };

export interface UpgradeAssessment {
  baseline: string;
  target: string;
  anchorFailures: number;
  missing: AssessedFile[];
  changed: ChangedFile[];
  breaking: string[];
  changelogFound: boolean;
  bunRequirement: string | null;
}

/** Contract paths are relative to coding-agent/src, including links to sibling packages. */
export function contractNativeFile(native: string): NativeFile {
  const sibling = /^\.\.\/\.\.\/([^/]+)\/(.+)$/.exec(native);
  if (!sibling) return { pkg: "pi-coding-agent", file: `src/${native}` };
  const pkg = sibling[1] as SdkPackage;
  if (!SDK_PACKAGES.includes(pkg)) throw new Error(`Unknown SDK package in semantic contract: ${native}`);
  return { pkg, file: sibling[2]! };
}

function usage(): never {
  console.error("usage: bun run upgrade:assess <version> [--from <version>] [--out report.md] [--json report.json]");
  process.exit(2);
}

async function run(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  // `git diff --no-index` exits 1 when files differ; that is a result, not a failure.
  if (code !== 0 && !(command[0] === "git" && code === 1)) throw new Error(`${command.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout;
}

function installedPackageDir(pkg: SdkPackage): string {
  let directory = dirname(Bun.resolveSync(`@oh-my-pi/${pkg}`, root));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate installed @oh-my-pi/${pkg}`);
    directory = parent;
  }
  return directory;
}

/** Each package gets its own empty directory; archives are extracted, never executed. */
async function fetchTarget(pkg: SdkPackage, version: string, scratch: string): Promise<string> {
  const directory = join(scratch, pkg);
  await mkdir(directory, { recursive: true });
  const tarball = (await run(["npm", "pack", `@oh-my-pi/${pkg}@${version}`, "--silent", "--registry=https://registry.npmjs.org"], directory)).trim().split("\n").at(-1);
  if (!tarball) throw new Error(`npm pack produced no archive for @oh-my-pi/${pkg}@${version}`);
  await run(["tar", "xzf", tarball], directory);
  return join(directory, "package");
}

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Map an import specifier to the package file Bun would load from source (`src/<subpath>.ts` or `/index.ts`). */
function importedFile(specifier: string, packageDir: string): string | undefined {
  const match = /^@oh-my-pi\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!match) return undefined;
  const subpath = match[2] ?? "index";
  for (const candidate of [`src/${subpath}.ts`, `src/${subpath}/index.ts`, `src/${subpath}`]) {
    if (existsSync(join(packageDir, candidate)) && candidate.endsWith(".ts")) return candidate;
  }
  return undefined;
}

async function collectDependencies(installed: Record<SdkPackage, string>, baseline: Record<SdkPackage, string>): Promise<Map<string, Dependency>> {
  const dependencies = new Map<string, Dependency>();
  const add = (pkg: SdkPackage, file: string, reason: string) => {
    const key = `${pkg}/${file}`;
    const entry = dependencies.get(key) ?? { pkg, file, reasons: new Set<string>() };
    entry.reasons.add(reason);
    dependencies.set(key, entry);
  };
  for await (const path of walk(join(root, "src"))) {
    const source = await readFile(path, "utf8");
    for (const [, staticImport, dynamicImport] of source.matchAll(/from\s+["'](@oh-my-pi\/[^"']+)["']|import\(\s*["'](@oh-my-pi\/[^"']+)["']\s*\)/g)) {
      const specifier = staticImport ?? dynamicImport;
      if (!specifier) continue;
      const pkg = /^@oh-my-pi\/([^/]+)/.exec(specifier)?.[1] as SdkPackage | undefined;
      if (!pkg || !SDK_PACKAGES.includes(pkg)) continue;
      const file = importedFile(specifier, baseline[pkg]) ?? importedFile(specifier, installed[pkg]);
      if (file) add(pkg, file, `import in ${relative(root, path)}`);
    }
  }
  for (const contract of SEMANTIC_SDK_CONTRACTS) {
    for (const native of contract.native) {
      const { pkg, file } = contractNativeFile(native);
      add(pkg, file, `contract ${contract.id}`);
    }
  }
  for (const adaptation of SDK_SOURCE_ADAPTATIONS) {
    add("pi-coding-agent", adaptation.upstreamPath.replace(/^packages\/coding-agent\//, ""), `adaptation ${adaptation.id}`);
  }
  return dependencies;
}

function changelogSince(changelog: string, from: string, target: string): string[] {
  const breaking: string[] = [];
  const sections = [...changelog.matchAll(/^## \[([^\]\r\n]+)\][^\r\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)];
  const start = sections.findIndex(section => section[1] === target);
  const end = sections.findIndex((section, index) => index >= start && section[1] === from);
  if (start < 0 || end < 0) throw new Error(`Cannot locate changelog range ${from} → ${target}; inspect the upstream changelog manually`);
  for (const [, version, body] of sections.slice(start, end)) {
    const block = /^### Breaking Changes[ \t]*\r?\n([\s\S]*?)(?=^### |(?![\s\S]))/mi.exec(body)?.[1];
    if (!block?.trim()) continue;
    const items = block.trim().split(/\r?\n(?=[-+*] |\d+\. )/);
    for (const item of items) breaking.push(`${version}: ${item.replace(/^(?:[-+*] |\d+\. )/, "").trim()}`);
  }
  return breaking;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.shift();
  if (!target || target.startsWith("-")) usage();
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i]!, args[i + 1]];
    if (!["--out", "--from", "--json"].includes(name) || options.has(name) || !value || value.startsWith("-")) usage();
    options.set(name, value);
  }
  const out = options.get("--out");
  const from = options.get("--from");
  const json = options.get("--json");

  const scratch = await mkdtemp(join(tmpdir(), "omp-upgrade-assess-"));
  try {
    // Consult both versions so a dependency that disappeared from the installed target is still reported.
    const resolver = Object.fromEntries(SDK_PACKAGES.map(pkg => [pkg, installedPackageDir(pkg)])) as Record<SdkPackage, string>;
    const installed = {} as Record<SdkPackage, string>;
    const targets = {} as Record<SdkPackage, string>;
    for (const pkg of SDK_PACKAGES) {
      targets[pkg] = await fetchTarget(pkg, target, join(scratch, "to"));
      installed[pkg] = from === target ? targets[pkg] : from ? await fetchTarget(pkg, from, join(scratch, "from")) : resolver[pkg];
    }
    const baseline = from ?? SUPPORTED_SDK_VERSION;

    const lines: string[] = [`# OMP upgrade assessment: ${baseline} → ${target}`, ""];
    const agentManifest = JSON.parse(await readFile(join(targets["pi-coding-agent"], "package.json"), "utf8")) as { engines?: { bun?: string } };
    const bunRequirement = agentManifest.engines?.bun ?? null;
    lines.push(`- Target requires Bun ${bunRequirement ?? "(unspecified)"}; local Bun ${Bun.version}.`, "");

    lines.push("## Source adaptations against the target", "", "| adaptation | anchor | expected | found |", "|---|---|---|---|");
    let anchorFailures = 0;
    for (const adaptation of SDK_SOURCE_ADAPTATIONS) {
      const path = join(targets["pi-coding-agent"], adaptation.upstreamPath.replace(/^packages\/coding-agent\//, ""));
      const source = existsSync(path) ? await readFile(path, "utf8") : "";
      for (const [id, anchor] of Object.entries(adaptation.anchors) as [string, { text: string; expectedCount: number }][]) {
        const found = source.split(anchor.text).length - 1;
        if (found !== anchor.expectedCount) anchorFailures++;
        lines.push(`| ${adaptation.id} | ${id} | ${anchor.expectedCount} | ${found === anchor.expectedCount ? found : `**${found}**`} |`);
      }
    }
    lines.push("");

    const dependencies = [...(await collectDependencies(resolver, installed)).values()].sort((a, b) => `${a.pkg}/${a.file}`.localeCompare(`${b.pkg}/${b.file}`));
    const changed: ChangedFile[] = [];
    const missing: AssessedFile[] = [];
    let unchanged = 0;
    for (const dependency of dependencies) {
      const before = join(installed[dependency.pkg], dependency.file);
      const after = join(targets[dependency.pkg], dependency.file);
      const entry = { pkg: dependency.pkg, file: dependency.file, reasons: [...dependency.reasons].sort() };
      if (!existsSync(after)) { missing.push(entry); continue; }
      if (!existsSync(before)) { changed.push(entry); continue; }
      const numstat = (await run(["git", "diff", "--no-index", "--numstat", before, after], root)).trim();
      if (!numstat) { unchanged++; continue; }
      const [added, removed] = numstat.split(/\s+/);
      changed.push({ ...entry, added, removed });
    }
    lines.push(`## Native dependencies (${dependencies.length}: ${changed.length} changed, ${missing.length} missing, ${unchanged} unchanged)`, "");
    const formatEntry = ({ pkg, file, reasons, added, removed }: ChangedFile, changed = false) =>
      `- \`${pkg}/${file}\`${changed ? added === undefined ? " (new in target)" : ` +${added} −${removed}` : ""} — ${reasons.join("; ")}`;
    if (missing.length) lines.push("### Missing in target (must fix)", "", ...missing.map(item => formatEntry(item)), "");
    if (changed.length) lines.push("### Changed (review the diff against the listed contract or import)", "", ...changed.map(item => formatEntry(item, true)), "");

    const changelogPath = join(targets["pi-coding-agent"], "CHANGELOG.md");
    const changelogFound = existsSync(changelogPath);
    const breaking = changelogFound ? changelogSince(await readFile(changelogPath, "utf8"), baseline, target) : [];
    lines.push(`## Breaking changes since ${baseline}`, "");
    if (!changelogFound) lines.push("**Manual review required: the target package has no CHANGELOG.md.**", "");
    else if (breaking.length) lines.push("**Manual review required: upstream declares breaking changes.**", "", ...breaking.map(item => `- ${item}`), "");
    else lines.push("None listed.", "");
    lines.push("Contract assumptions: scripts/sdk-semantic-contracts.ts. Procedure: README › Upgrading OMP.", "");

    const report = lines.join("\n");
    if (out) await writeFile(resolve(out), report);
    if (json) {
      const assessment: UpgradeAssessment = { baseline, target, anchorFailures, missing, changed, breaking, changelogFound, bunRequirement };
      await writeFile(resolve(json), `${JSON.stringify(assessment, null, 2)}\n`);
    }
    console.log(report);
    if (anchorFailures || missing.length) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
