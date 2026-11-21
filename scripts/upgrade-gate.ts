/**
 * Upgrade gate: `bun run upgrade:gate [--release | --lsp] [--hosts a,b]`.
 *
 * Local checks, both worker builds, then the core real-host acceptance on every configured host:
 * the lifecycle smoke and the native task acceptance (subagent inheritance, reconnect, nested Eval,
 * output capture, restart fail-closed). `--lsp` adds the LSP matrix, plus the C/C++ suite on hosts
 * that configure `cppEnv`. Run it only after `bun run upgrade:assess` says what changed upstream.
 * `--release` requires x64 and arm64 hosts, the complete LSP matrix, and a compiled worker smoke.
 *
 * Hosts come from the untracked `.omp/acceptance.json`:
 *   { "hosts": [
 *       { "name": "CohortX", "arch": "x64", "connect": "CohortX /scratch/dir", "auditSsh": ["ssh", "CohortX"] },
 *       { "name": "910B", "arch": "arm64", "connect": "910B /scratch/dir", "auditSsh": ["ssh", "910B"],
 *         "cppEnv": { "REMOTE_CPP_PROJECT_ROOT": "..." } }
 *   ] }
 * `connect` is the `/remote-connect` argument string; `auditSsh` is the explicit SSH argv the task
 * acceptance uses to audit remote processes (it never kills them).
 *
 * Real-host steps drive `$OMP_BINARY` (default `omp`); it must report the pinned SDK version, so a
 * candidate can be accepted from an isolated install before the global OMP is replaced.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";

const root = resolve(import.meta.dir, "..");
type Host = { name: string; arch?: "x64" | "arm64"; connect: string; auditSsh: string[]; cppEnv?: Record<string, string> };
type Step = { label: string; command: string[]; env?: Record<string, string> };
type Outcome = { label: string; ok: boolean; seconds: number };

function parseArgs(): { release: boolean; lsp: boolean; only?: Set<string> } {
  const args = process.argv.slice(2);
  const hostsIndex = args.indexOf("--hosts");
  const unknown = args.filter((arg, index) =>
    !["--lsp", "--release", "--hosts"].includes(arg) && (hostsIndex < 0 || index !== hostsIndex + 1));
  const hostArg = hostsIndex < 0 ? undefined : args[hostsIndex + 1];
  if (unknown.length || (hostsIndex >= 0 && (!hostArg || hostArg.startsWith("-")))) {
    console.error("usage: bun run upgrade:gate [--release | --lsp] [--hosts a,b]");
    process.exit(2);
  }
  const release = args.includes("--release");
  return { release, lsp: release || args.includes("--lsp"), only: hostArg ? new Set(hostArg.split(",")) : undefined };
}

async function loadHosts(only?: Set<string>): Promise<Host[]> {
  const path = join(root, ".omp/acceptance.json");
  if (!existsSync(path)) throw new Error(`Configure acceptance hosts in ${path} (see the header of scripts/upgrade-gate.ts)`);
  const hosts = (JSON.parse(await readFile(path, "utf8")) as { hosts?: Host[] }).hosts ?? [];
  for (const host of hosts) {
    if (!host.name || !host.connect || !Array.isArray(host.auditSsh) || host.auditSsh[0] !== "ssh") {
      throw new Error(`Invalid acceptance host entry: ${JSON.stringify(host)}`);
    }
  }
  const selected = only ? hosts.filter(host => only.has(host.name)) : hosts;
  if (!selected.length) throw new Error("No acceptance hosts selected");
  return selected;
}

async function runStep(step: Step): Promise<Outcome> {
  const started = performance.now();
  console.log(`\n▶ ${step.label}\n  $ ${step.command.join(" ")}`);
  const proc = Bun.spawn(step.command, { cwd: root, env: { ...Bun.env, ...step.env }, stdout: "inherit", stderr: "inherit" });
  const ok = (await proc.exited) === 0;
  const seconds = (performance.now() - started) / 1000;
  console.log(`${ok ? "✔" : "✘"} ${step.label} (${seconds.toFixed(1)}s)`);
  return { label: step.label, ok, seconds };
}

async function main(): Promise<void> {
  const { release, lsp, only } = parseArgs();
  const hosts = await loadHosts(only);
  if (release) {
    const arches = new Set(hosts.map(host => host.arch));
    if (hosts.some(host => host.arch !== "x64" && host.arch !== "arm64") || !arches.has("x64") || !arches.has("arm64")) {
      throw new Error("--release requires an arch of x64 or arm64 on every selected host, and at least one host of each");
    }
    if (!hosts.some(host => host.cppEnv?.REMOTE_CPP_PROJECT_ROOT)) {
      throw new Error("--release requires cppEnv with REMOTE_CPP_PROJECT_ROOT on at least one selected host for the C/C++ LSP suite");
    }
  }
  const local: Step[] = [
    { label: "check:sdk", command: ["bun", "run", "check:sdk"] },
    { label: "typecheck + build + tests", command: ["bun", "run", "check"] },
    { label: "workers (arm64, x64)", command: ["bun", "run", "build:worker:all"] },
    ...(release ? [{ label: "compiled worker smoke", command: ["bun", "scripts/smoke-compiled-worker.ts"] }] : []),
    { label: "acceptance helpers", command: ["bun", "scripts/build-smoke.ts", "all"] },
  ];
  const outcomes: Outcome[] = [];
  // Acceptance against a different host OMP than the pins would accept the wrong pairing.
  const binary = Bun.env.OMP_BINARY ?? "omp";
  const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim();
  if (version !== `omp/${SUPPORTED_SDK_VERSION}`) {
    console.error(`${binary} --version reports "${version}", expected omp/${SUPPORTED_SDK_VERSION}; set OMP_BINARY`);
    outcomes.push({ label: "host OMP version", ok: false, seconds: 0 });
    return report(outcomes);
  }
  for (const step of local) {
    const outcome = await runStep(step);
    outcomes.push(outcome);
    // Real-host acceptance of a build that failed locally proves nothing.
    if (!outcome.ok) return report(outcomes);
  }
  for (const host of hosts) {
    const env = { REMOTE_CONNECT_ARGS: host.connect };
    const steps: Step[] = [
      { label: `${host.name}: lifecycle`, command: ["bun", "scripts/run-smoke.ts", "lifecycle"], env },
      { label: `${host.name}: native tasks`, command: ["bun", "scripts/run-task-acceptance.ts"], env: { ...env, TASK_ACCEPTANCE_AUDIT_SSH: JSON.stringify(host.auditSsh) } },
    ];
    if (lsp) {
      steps.push({ label: `${host.name}: LSP`, command: ["bun", "scripts/run-smoke.ts", "lsp"], env });
      if (host.cppEnv) steps.push({ label: `${host.name}: C/C++ LSP`, command: ["bun", "scripts/run-smoke.ts", "cpp-lsp"], env: { ...env, ...host.cppEnv } });
    }
    for (const step of steps) outcomes.push(await runStep(step));
  }
  report(outcomes);
}

function report(outcomes: Outcome[]): void {
  console.log("\nUpgrade gate summary");
  console.table(outcomes.map(({ label, ok, seconds }) => ({ step: label, result: ok ? "PASS" : "FAIL", seconds: Number(seconds.toFixed(1)) })));
  if (outcomes.some(outcome => !outcome.ok)) process.exitCode = 1;
}

await main();
