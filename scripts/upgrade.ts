import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import ts from "typescript";
import { SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";
import { SEMANTIC_SDK_CONTRACTS } from "./sdk-semantic-contracts.ts";
import { contractNativeFile, SDK_PACKAGES, type UpgradeAssessment } from "./upgrade-assess.ts";

const root = resolve(import.meta.dir, "..");
const sdkPackage = "@oh-my-pi/pi-coding-agent";
const plugin = "omp-ssh-remote";
const manifests = ["package.json", "packages/omp/package.json"] as const;
const sdkContract = "src/omp/sdk-contract.ts";
const allowedFiles = [...manifests, sdkContract, "bun.lock"];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type ReviewContract = { id: string; native: readonly string[]; review?: string };
export type EligibilityInput = {
  gatePassed: boolean;
  unexpectedChanges: readonly string[];
  assessment: UpgradeAssessment | undefined;
  baseline: string;
  target: string;
  bunVersion: string;
  contracts: readonly ReviewContract[];
};
type Blocker = { code: string; detail: string };

/** All independent blockers, even when the first is already decisive. */
export function upgradeBlockers(input: EligibilityInput): Blocker[] {
  const { gatePassed, unexpectedChanges, assessment, baseline, target, bunVersion, contracts } = input;
  const blockers: Blocker[] = [];
  const add = (code: string, detail: string) => blockers.push({ code, detail });
  if (!gatePassed) add("gate", "The release gate did not pass (failed or not run).");
  for (const path of unexpectedChanges) add("diff", `Outside the mechanical diff whitelist: ${path}`);
  if (!assessment) {
    add("assessment", "No machine-readable assessment was produced.");
    return blockers;
  }
  if (assessment.baseline !== baseline || assessment.target !== target) {
    add("assessment-range", `Expected ${baseline} → ${target}; assessment covered ${assessment.baseline} → ${assessment.target}.`);
  }
  if (assessment.anchorFailures !== 0) add("anchors", `${assessment.anchorFailures} source adaptation anchors failed; see the assessment.`);
  for (const file of assessment.missing) add("missing", `Missing ${file.pkg}/${file.file} (${file.reasons.join("; ")}).`);
  for (const entry of assessment.breaking) add("breaking", `Upstream breaking change: ${entry}`);
  if (!assessment.changelogFound) add("changelog", "The target package has no CHANGELOG.md.");
  if (assessment.bunRequirement !== null && !Bun.semver.satisfies(bunVersion, assessment.bunRequirement)) {
    add("bun", `Bun ${bunVersion} does not satisfy ${assessment.bunRequirement}.`);
  }
  const changed = new Set(assessment.changed.map(file => `${file.pkg}/${file.file}`));
  for (const contract of contracts) {
    const review = (contract as { review?: string }).review?.trim();
    if (!review) continue;
    for (const native of contract.native) {
      const { pkg, file } = contractNativeFile(native);
      if (changed.has(`${pkg}/${file}`)) add("review", `${pkg}/${file} changed (${contract.id}): ${review}`);
    }
  }
  return blockers;
}

async function capture(command: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd: options.cwd ?? root, env: options.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${stderr.trim()}`);
  return stdout;
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<number> {
  console.log(`\n> ${command.join(" ")}`);
  return Bun.spawn(command, { cwd: options.cwd ?? root, env: options.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
}

async function requireRun(command: string[], options: Parameters<typeof run>[1] = {}): Promise<void> {
  const code = await run(command, options);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

const gitAt = (cwd: string, ...args: string[]) => capture(["git", ...args], { cwd });
const status = (cwd: string) => gitAt(cwd, "status", "--porcelain=v1", "--untracked-files=all");
const head = (cwd: string) => gitAt(cwd, "rev-parse", "HEAD").then(value => value.trim());
const branchName = (cwd: string) => gitAt(cwd, "branch", "--show-current").then(value => value.trim());

function replaceExact(text: string, before: string, after: string, file: string): string {
  if (text.split(before).length !== 2) throw new Error(`${file}: expected exactly one ${before}`);
  return text.replace(before, after);
}

async function unexpectedDiff(cwd: string, base: string, expected: ReadonlyMap<string, string>): Promise<string[]> {
  const git = (...args: string[]) => gitAt(cwd, ...args);
  const changed = (await git("diff", "--name-only", "--no-renames", "-z", base)).split("\0").filter(Boolean);
  const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const problems = [...changed.filter(path => !allowedFiles.includes(path)), ...untracked];
  const summary = await git("diff", "--summary", "--no-renames", base);
  if (summary.trim()) problems.push(`unexpected file creation, deletion or mode change: ${summary.trim()}`);
  for (const [path, text] of expected) {
    if (await Bun.file(join(cwd, path)).text().catch(() => undefined) !== text) problems.push(`${path} (unexpected contents)`);
  }
  // Gate steps must not populate the index or hide staged edits behind unstaged ones.
  if ((await git("diff", "--cached", "--name-only")).trim()) problems.push("the index contains unexpected staged changes");
  return [...new Set(problems)];
}

/** Nothing built or installed for the gate can overwrite the live plugin's dist. */
async function copyAcceptanceInputs(worktree: string): Promise<void> {
  const config = ".omp/acceptance.json";
  if (await Bun.file(join(root, config)).exists()) {
    await mkdir(join(worktree, ".omp"), { recursive: true });
    await copyFile(join(root, config), join(worktree, config));
  }
  const dist = "packages/omp/dist";
  const files = await readdir(join(root, dist)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const packs = files.filter(name => /-lsp-linux-.*\.(?:tar\.gz|json)$/.test(name));
  if (!packs.length) return;
  await mkdir(join(worktree, dist), { recursive: true });
  for (const pack of packs) await copyFile(join(root, dist, pack), join(worktree, dist, pack));
}

function freshEnv(directory: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SHELL", "LANG", "LC_ALL", "TERM"]) if (Bun.env[name]) env[name] = Bun.env[name]!;
  return Object.assign(env, {
    HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"),
  });
}

async function checkOmpVersion(binary: string, target: string, options: Parameters<typeof capture>[1] = {}): Promise<void> {
  const actual = (await capture([binary, "--version"], options)).trim();
  if (actual !== `omp/${target}`) throw new Error(`${binary} reports ${actual}, expected omp/${target}`);
  console.log(`${binary}: ${actual}`);
}

type PluginEntry = { version: string; enabled: boolean; enabledFeatures?: string[] | null };
type PluginLock = { plugins?: Record<string, PluginEntry>; settings?: Record<string, unknown> };
const pluginLock = "omp-plugins.lock.json";

/** RPC through normal plugin discovery; never transmit a prompt or connect. */
async function verifyPlugin(binary: string, directory: string, linkedPackage: string, entry: PluginEntry): Promise<void> {
  const env = freshEnv(directory);
  // Match the child environment, not the launcher's PI_CONFIG_DIR override.
  env.PI_CONFIG_DIR = ".omp";
  const registry = join(env.HOME, env.PI_CONFIG_DIR, "plugins");
  const cwd = join(directory, "project");
  const config = join(directory, "config.json");
  const modules = join(registry, "node_modules");
  await Promise.all([cwd, env.TMPDIR, modules].map(path => mkdir(path, { recursive: true })));
  await symlink(linkedPackage, join(modules, plugin), "dir");
  await writeFile(join(registry, pluginLock), JSON.stringify({ plugins: { [plugin]: entry } }));
  await writeFile(config, JSON.stringify({ memory: { enabled: false }, autolearn: { enabled: false }, compaction: { enabled: false } }));
  // Keep plugin discovery under this HOME, independent of the launcher’s XDG override.
  delete env.XDG_DATA_HOME;
  env.OPENAI_API_KEY = "unused-local-command-only";
  const child = Bun.spawn([binary, "--mode", "rpc", "--no-ui", "--no-title", "--no-skills", "--no-rules", "--config", config,
    "--session-dir", join(directory, "sessions"), "--model", "openai/gpt-4o-mini"], {
    cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const frames: string[] = [];
  let buffer = "", admitted = false;
  const required = ["remote-connect", "remote-status", "remote-reconnect", "remote-exit"];
  async function consume(line: string): Promise<void> {
    if (!line.trim()) return;
    frames.push(line);
    let frame: { type?: string; id?: string; command?: string; success?: boolean; data?: { commands?: { name: string; source: string }[] } };
    try { frame = JSON.parse(line); } catch { throw new Error(`Non-JSON output from RPC: ${line}`); }
    if (frame.type === "extension_error" || frame.type === "agent_start") throw new Error(`Unexpected RPC event: ${line}`);
    if (frame.type !== "response" || frame.id !== "upgrade-admission") return;
    if (admitted || frame.command !== "get_available_commands" || frame.success !== true || !Array.isArray(frame.data?.commands)) {
      throw new Error(`Invalid command-list response: ${line}`);
    }
    const names = new Set(frame.data.commands.filter(command => command.source === "extension").map(command => command.name));
    const missing = required.filter(name => !names.has(name));
    if (missing.length) throw new Error(`Normal plugin loader did not register: ${missing.join(", ")}`);
    admitted = true;
    await child.stdin.end();
  }
  try {
    child.stdin.write(`${JSON.stringify({ id: "upgrade-admission", type: "get_available_commands" })}\n`);
    await child.stdin.flush();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) await consume(line);
    }
    await consume(buffer);
    const code = await child.exited;
    if (code !== 0 || !admitted) throw new Error(`RPC admission did not complete (exit ${code})`);
    if (/failed to load|extension[^\n]*(?:error|failed)/i.test(await stderr)) throw new Error("OMP startup reported an extension load error");
  } finally {
    reader.releaseLock();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.all([writeFile(join(directory, "stderr.log"), await stderr), writeFile(join(directory, "rpc.jsonl"), frames.join("\n"))]);
  }
  console.log(`RPC admission passed (${binary}): ${required.join(", ")}; no model turn`);
}

function lockEntry(text: string): PluginEntry | undefined {
  return (JSON.parse(text) as PluginLock).plugins?.[plugin];
}

/** Byte comparison of sibling entries/settings, independent of their offsets in the JSON document. */
function unrelatedLockBytes(text: string): string {
  const source = ts.parseJsonText(pluginLock, text);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) throw new Error("Expected a plugin lock object");
  const entries: string[] = [];
  for (const property of statement.expression.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error("Invalid plugin lock property");
    if (property.name.text !== "plugins") entries.push(property.getText(source));
    else {
      if (!ts.isObjectLiteralExpression(property.initializer)) throw new Error("Invalid plugin lock entries");
      for (const entry of property.initializer.properties) {
        if (!ts.isPropertyAssignment(entry) || !ts.isStringLiteral(entry.name)) throw new Error("Invalid plugin lock entry");
        if (entry.name.text !== plugin) entries.push(entry.getText(source));
      }
    }
  }
  return JSON.stringify(entries);
}

async function refreshGlobalLink(binary: string, directory: string, registry: string, pkg: string, nextVersion: string): Promise<PluginEntry> {
  const path = join(registry, pluginLock);
  const link = join(registry, "node_modules", plugin);
  if (!(await lstat(link)).isSymbolicLink() || await realpath(link) !== await realpath(pkg)) {
    throw new Error(`Expected ${link} to already link to ${pkg}; refusing to replace it`);
  }
  const before = await readFile(path, "utf8");
  await writeFile(join(directory, "original-plugin-lock.json"), before, { mode: 0o600, flag: "wx" });
  try {
    await requireRun([binary, "plugin", "link", pkg], { cwd: directory });
    const after = await readFile(path, "utf8");
    if (unrelatedLockBytes(after) !== unrelatedLockBytes(before)) throw new Error("OMP changed an unrelated plugin lock entry or setting");
    const entry = lockEntry(after);
    if (entry?.version !== nextVersion || entry.enabled !== true || await realpath(link) !== await realpath(pkg)) {
      throw new Error(`Global plugin registry does not record enabled ${plugin}@${nextVersion} linked to ${pkg}`);
    }
    return entry;
  } catch (error) {
    const restore = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(restore, before, { mode: 0o600, flag: "wx" });
    await rename(restore, path);
    throw error;
  }
}

async function verifyInstallLock(path: string, names: readonly string[], target: string): Promise<void> {
  const lock = Bun.JSONC.parse(await readFile(path, "utf8")) as { packages?: Record<string, [string, ...unknown[]]> };
  for (const name of names) if (lock.packages?.[name]?.[0] !== `${name}@${target}`) throw new Error(`${path} does not resolve ${name}@${target}`);
}

async function main(): Promise<void> {
  const [target, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run"), skipGate = flags.includes("--skip-gate"), reviewed = flags.includes("--reviewed");
  if (!target || !versionPattern.test(target) || flags.some(flag => !["--dry-run", "--skip-gate", "--reviewed"].includes(flag)) || (skipGate && !dryRun)) {
    console.error("usage: bun run upgrade <x.y.z> [--reviewed] [--dry-run [--skip-gate]]");
    process.exitCode = 2;
    return;
  }
  const baseline = SUPPORTED_SDK_VERSION;
  const branch = `upgrade/omp-${target}`;
  const reportPath = join(root, `.cache/upgrade-${target}.md`);
  let directory: string | undefined, worktree: string | undefined, base: string | undefined, commit: string | undefined;
  let stage = "preflight", mainUpdated = false, pushed = false, globalInstallAttempted = false;
  const blockers: Blocker[] = [];
  // Review notes a person has read for this exact target; recorded, never silently dropped.
  const acknowledged: Blocker[] = [];
  try {
    if (await branchName(root) !== "main" || await status(root)) throw new Error("Start from a clean main worktree (including untracked files).");
    base = await head(root);
    stage = "create candidate worktree";
    directory = await mkdtemp(join(tmpdir(), "omp-upgrade-"));
    worktree = join(directory, "worktree");
    await requireRun(["git", "worktree", "add", "-b", branch, worktree, base]);

    stage = "isolated OMP install";
    console.log(`Candidate install and diagnostics: ${directory}\nUpgrade worktree: ${worktree}`);
    const isolated = freshEnv(directory);
    const prefix = join(directory, "bun"), globalDir = join(prefix, "install/global"), bin = join(prefix, "bin");
    const installEnv = { ...isolated, BUN_INSTALL: prefix, BUN_INSTALL_GLOBAL_DIR: globalDir, BUN_INSTALL_BIN: bin };
    await mkdir(isolated.HOME, { recursive: true });
    await mkdir(isolated.TMPDIR, { recursive: true });
    await requireRun(["bun", "add", "-g", `${sdkPackage}@${target}`], { cwd: directory, env: installEnv });
    const binary = join(bin, "omp");
    await verifyInstallLock(join(globalDir, "bun.lock"), [sdkPackage], target);
    await checkOmpVersion(binary, target, { cwd: directory, env: isolated });

    stage = "pin SDK";
    if (await branchName(worktree) !== branch || await head(worktree) !== base || await status(worktree)) throw new Error("Upgrade worktree changed during candidate install");
    const expected = new Map<string, string>();
    const pins = SDK_PACKAGES.map(name => `@oh-my-pi/${name}`);
    let rootPackage = await readFile(join(worktree, manifests[0]), "utf8");
    for (const name of pins) rootPackage = replaceExact(rootPackage, `"${name}": "${baseline}"`, `"${name}": "${target}"`, manifests[0]);
    expected.set(manifests[0], rootPackage);
    expected.set(manifests[1], replaceExact(await readFile(join(worktree, manifests[1]), "utf8"), `"${sdkPackage}": ">=${baseline}"`, `"${sdkPackage}": ">=${target}"`, manifests[1]));
    expected.set(sdkContract, replaceExact(await readFile(join(worktree, sdkContract), "utf8"), `SUPPORTED_SDK_VERSION = "${baseline}"`, `SUPPORTED_SDK_VERSION = "${target}"`, sdkContract));
    for (const [path, text] of expected) await writeFile(join(worktree, path), text);
    const candidate = { cwd: worktree };
    if (target !== baseline) await requireRun(["bun", "install", "--lockfile-only"], candidate);
    await requireRun(["bun", "install", "--frozen-lockfile"], candidate);
    await verifyInstallLock(join(worktree, "bun.lock"), pins, target);
    expected.set("bun.lock", await readFile(join(worktree, "bun.lock"), "utf8"));

    stage = "assess candidate";
    const json = join(directory, "assessment.json");
    const markdown = join(directory, "assessment.md");
    const assessExit = await run(["bun", "run", "upgrade:assess", target, "--from", baseline, "--json", json, "--out", markdown], candidate);
    const assessment = await Bun.file(json).exists() ? await Bun.file(json).json() as UpgradeAssessment : undefined;
    if (assessExit !== 0 && (!assessment || (!assessment.anchorFailures && !assessment.missing.length))) {
      blockers.push({ code: "assess-exit", detail: `upgrade:assess exited ${assessExit}; inspect its output.` });
    }

    stage = "release gate";
    let gateExit: number | undefined;
    if (!skipGate) {
      try {
        await copyAcceptanceInputs(worktree);
        gateExit = await run(["bun", "run", "upgrade:gate", "--release"], { ...candidate, env: { ...Bun.env, OMP_BINARY: binary } });
      } catch (error) {
        blockers.push({ code: "gate-setup", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    stage = "release eligibility";
    console.log(`\nEvaluating release eligibility (${skipGate ? "gate skipped; cannot publish" : gateExit === undefined ? "gate did not start" : `gate exit ${gateExit}`})`);
    if (await branchName(worktree) !== branch || await head(worktree) !== base) blockers.push({ code: "git", detail: "The upgrade branch moved while the gate ran." });
    const eligibility = upgradeBlockers({ assessment, baseline, target, gatePassed: gateExit === 0,
      unexpectedChanges: await unexpectedDiff(worktree, base, expected), bunVersion: Bun.version, contracts: SEMANTIC_SDK_CONTRACTS });
    for (const blocker of eligibility) (reviewed && blocker.code === "review" ? acknowledged : blockers).push(blocker);
    if (blockers.length || dryRun) return;

    stage = "bump plugin patch version";
    const oldPlugin = (JSON.parse(expected.get(manifests[0])!) as { version: string }).version;
    const version = versionPattern.exec(oldPlugin);
    if (!version || (JSON.parse(expected.get(manifests[1])!) as { version: string }).version !== oldPlugin) throw new Error("Expected matching plugin versions in both manifests");
    const nextPlugin = `${version[1]}.${version[2]}.${BigInt(version[3]) + 1n}`;
    for (const path of manifests) {
      const text = replaceExact(expected.get(path)!, `"version": "${oldPlugin}"`, `"version": "${nextPlugin}"`, path);
      expected.set(path, text);
      await writeFile(join(worktree, path), text);
    }
    await requireRun(["bun", "install", "--lockfile-only"], candidate);
    await verifyInstallLock(join(worktree, "bun.lock"), pins, target);
    expected.set("bun.lock", await readFile(join(worktree, "bun.lock"), "utf8"));
    stage = "build and verify the final plugin with candidate OMP";
    await requireRun(["bun", "run", "build"], candidate);
    await requireRun(["bun", "run", "build:worker:all"], candidate);
    await verifyPlugin(binary, join(directory, "candidate-admission"), join(worktree, "packages/omp"), { version: nextPlugin, enabled: true, enabledFeatures: null });
    const pkg = join(root, "packages/omp");
    const registry = getPluginsDir();
    const globalLink = join(registry, "node_modules", plugin);
    if (!(await lstat(globalLink)).isSymbolicLink() || await realpath(globalLink) !== await realpath(pkg) ||
        !lockEntry(await readFile(join(registry, pluginLock), "utf8"))?.enabled) throw new Error("Expected an enabled global plugin link to this checkout before publishing");

    stage = "commit release";
    const unexpected = await unexpectedDiff(worktree, base, expected);
    if (unexpected.length) throw new Error(unexpected.join("; "));
    if (await branchName(worktree) !== branch || await head(worktree) !== base) throw new Error("Upgrade branch moved while the gate ran");
    const reviewedBody = acknowledged.length ? ["-m", ["Review notes acknowledged with --reviewed:", ...acknowledged.map(({ detail }) => `- ${detail}`)].join("\n")] : [];
    await requireRun(["git", "commit", "-m", `Upgrade OMP to ${target} (Remote ${nextPlugin})`, ...reviewedBody, "--", ...allowedFiles], candidate);
    commit = await head(worktree);
    const git = (...args: string[]) => gitAt(worktree!, ...args);
    const committedPaths = (await git("diff", "--name-only", "--no-renames", "-z", base, commit)).split("\0").filter(Boolean);
    if (await status(worktree) || committedPaths.some(path => !allowedFiles.includes(path)) || (await git("diff", "--summary", base, commit)).trim()) {
      throw new Error("Commit differs from the verified release changes");
    }
    for (const [path, text] of expected) if (await git("show", `${commit}:${path}`) !== text) throw new Error(`Commit changed verified ${path}`);

    stage = "fast-forward main";
    if (await branchName(root) !== "main" || await head(root) !== base || await status(root)) {
      throw new Error("The main checkout changed while the gate ran; refusing to merge");
    }
    await requireRun(["git", "merge", "--ff-only", commit]);
    mainUpdated = true;
    if (await head(root) !== commit || await status(root)) throw new Error("main is not the verified release commit in a clean worktree");
    stage = "rebuild in the main checkout";
    await requireRun(["bun", "install", "--frozen-lockfile"]);
    await requireRun(["bun", "run", "build"]);
    await requireRun(["bun", "run", "build:worker:all"]);
    if (await branchName(root) !== "main" || await head(root) !== commit || await status(root)) throw new Error("The main checkout changed during release builds");
    stage = "push main";
    await requireRun(["git", "push", "origin", `${commit}:refs/heads/main`]);
    pushed = true;

    stage = "global OMP install";
    globalInstallAttempted = true;
    await requireRun(["bun", "add", "-g", `${sdkPackage}@${target}`]);
    const globalDirLine = (await capture(["bun", "pm", "ls", "-g"])).split("\n")[0];
    const globalInstall = /^(.+) node_modules \(/.exec(globalDirLine)?.[1];
    if (!globalInstall) throw new Error("Cannot locate the global Bun lockfile from `bun pm ls -g`");
    await verifyInstallLock(join(globalInstall, "bun.lock"), [sdkPackage], target);
    const globalBinary = join((await capture(["bun", "pm", "bin", "-g"])).trim(), "omp");
    await checkOmpVersion(globalBinary, target);
    stage = "refresh and verify global plugin registry";
    const entry = await refreshGlobalLink(globalBinary, directory, registry, pkg, nextPlugin);
    await verifyPlugin(globalBinary, join(directory, "global-admission"), globalLink, entry);
    stage = "complete";
  } catch (error) {
    blockers.push({ code: stage, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    const branchNow = await branchName(root).catch(() => "unknown");
    const headNow = await head(root).catch(() => "unknown");
    const working = worktree ? await status(worktree).catch(() => "unknown") : "";
    const rollback = pushed ? (globalInstallAttempted
      ? `Inspect the installed OMP version and both lockfiles. Until the versions match, the plugin on main rejects remote connections (fail closed). Fix forward with OMP ${target}, or revert the published commit on main, reinstall the prior OMP ${baseline}, and rebuild the prior plugin and workers.`
      : `The release is already on origin/main. Use a revert commit for rollback; do not rewrite main.`)
      : mainUpdated ? `main was fast-forwarded locally. Check origin/main before retrying the push or reverting the release locally; a failed push can have an uncertain outcome.`
      : `No release was pushed. Keep the candidate worktree for review. When done, save its changes or deliberately remove the worktree and delete the upgrade branch; the main checkout needs no rebuild.`;
    const lines = [`# OMP upgrade: ${baseline} → ${target}`, "", `Stage: ${stage}${dryRun ? " (dry run)" : ""}`,
      `Main checkout: ${branchNow || "detached"} @ ${headNow}; baseline commit ${base ?? "not recorded"}; release commit ${commit ?? "none"}`,
      `Upgrade branch: ${branch}`, `Upgrade worktree: ${worktree ?? "not created"}`, `Isolated install and reports: ${directory ?? "not created"}`,
      `main fast-forwarded: ${mainUpdated}; push confirmed: ${pushed}; global install attempted: ${globalInstallAttempted}`,
      "", "## Blockers", "", ...blockers.map(({ code, detail }) => `- **${code}**: ${detail.replaceAll("\n", "\n  ")}`),
      ...(!blockers.length ? [dryRun ? "None. Dry run: no release or global changes performed." : "None. Release complete."] : []),
      ...(acknowledged.length ? ["", "## Review notes acknowledged with --reviewed", "", ...acknowledged.map(({ detail }) => `- ${detail}`)] : []),
      "", "## Recovery", "", rollback,
      ...(working.trim() ? ["", "```text", working.trimEnd(), "```"] : []), ""];
    if (blockers.length || dryRun) {
      try {
        await mkdir(join(root, ".cache"), { recursive: true });
        await writeFile(reportPath, lines.join("\n"));
        console.log(`Report: ${reportPath}`);
      } catch (error) { console.error(`Unable to write ${reportPath}: ${error}`); }
      console.log(lines.join("\n"));
      if (blockers.length) process.exitCode = 1;
    } else {
      console.log(`Released ${commit}; global OMP ${target} admitted the plugin.`);
      try {
        // This is our temporary worktree; force permits generated files ignored by Git.
        if (worktree && !await status(worktree)) {
          await requireRun(["git", "worktree", "remove", "--force", worktree]);
          // Already fast-forwarded into main, so the safe -d delete succeeds.
          await requireRun(["git", "branch", "-d", branch]);
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      } catch (error) { console.warn(`Could not remove ${directory}: ${error}`); }
    }
  }
}

if (import.meta.main) await main();
