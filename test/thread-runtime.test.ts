import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Identity = { pid: number; start: string; parent: number };
type AuthenticationReport = { authenticated: boolean; rejected: boolean; closeCalls: number; replyWrites: number };
type Scenario = "facade" | "exit" | "terminate" | "commit-resolve" | "commit-reject"
  | "lease-identity" | "authentication-fence";
type Report = {
  listeners?: number[];
  acknowledged?: boolean;
  revoked?: boolean;
  disposed: number | boolean;
  identity?: Identity;
  mode?: "exit" | "terminate";
  mainPid?: number;
  peer?: Identity;
  survivor?: Identity;
  guardRejected?: boolean;
  outcome?: "commit-resolve" | "commit-reject";
  commitCalls?: number;
  ownerClosed?: boolean;
  facadeClosed?: boolean;
  preparationCalls?: number;
  firstAborted?: boolean;
  secondHealthy?: boolean;
  firstDisposalHeld?: boolean;
  executed?: boolean;
  authenticationControl?: AuthenticationReport;
  authenticationFault?: AuthenticationReport;
};

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  // Failure deadline only: real process exit and socket readiness cannot be advanced by fake time.
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), 15_000);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function killExactCompanions(root: string): Promise<void> {
  let records: string;
  try { records = await readFile(join(root, "companions.jsonl"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const record of records.trim().split("\n").filter(Boolean)) {
    const identity = JSON.parse(record) as Identity;
    try {
      const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      // Failure cleanup must never signal an unrelated process after PID reuse.
      if (fields[19] === identity.start) process.kill(identity.pid, "SIGKILL");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

async function scenario(mode: Scenario): Promise<Report> {
  const root = await mkdtemp(join(tmpdir(), "omp-thread-owner-test-"));
  const launcher = join(root, "ssh");
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    // PATH and launcher environment belong only to this subprocess. Other tests
    // can use real SSH concurrently; neither process.env nor spawn is patched.
    await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fixtures/thread-runtime-ssh-companion.ts"))} "$@"\n`);
    await chmod(launcher, 0o700);
    const harness = mode === "commit-resolve" || mode === "commit-reject"
      ? "thread-runtime-commit-harness.ts"
      : mode === "lease-identity" ? "thread-runtime-lease-identity-harness.ts"
      : mode === "authentication-fence" ? "thread-runtime-authentication-harness.ts" : "thread-runtime-owner-harness.ts";
    child = spawn(process.execPath, [join(import.meta.dir, "fixtures", harness), mode], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, TEST_THREAD_SOCKET_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    closed = once(child, "close");
    void closed.catch(() => {});
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
    const [code, signal] = await deadline(exited, `${mode} ownership harness exit`);
    await deadline(closed, `${mode} ownership harness stream closure`);
    if (code !== 0 || signal) throw new Error(`Socket owner harness failed (${code ?? signal}):\n${stderr}\n${stdout}`);
    return JSON.parse(stdout.trim()) as Report;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { if (closed) await deadline(closed, "ownership harness cleanup"); }
    finally {
      try { await killExactCompanions(root); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}

// PID plus /proc start-time identity is deliberate: process.kill(pid, 0) alone
// neither proves actual exit nor protects the cleanup path against PID reuse.
describe.skipIf(process.platform !== "linux")("main-owned thread runtime socket facade", () => {
  test("holds an early event for all listeners and revokes work without revoking close, wait or dispose", async () => {
    const report = await scenario("facade");
    expect(report.listeners).toEqual([1, 1]);
    expect(report.acknowledged).toBe(true);
    expect(report.revoked).toBe(true);
    expect(report.disposed).toBe(1);
    expect(report.identity?.pid).toBeGreaterThan(0);
    expect(report.identity?.start).toMatch(/^\d+$/);
  }, 20_000);

  for (const mode of ["exit", "terminate"] as const) {
    test(`reaps the actual fake-SSH companion after abrupt peer ${mode} while the main process survives`, async () => {
      const report = await scenario(mode);
      expect(report.mode).toBe(mode);
      expect(report.guardRejected).toBe(true);
      expect(report.disposed).toBe(true);
      expect(report.peer?.parent).toBe(report.mainPid);
      expect(report.survivor?.parent).toBe(report.mainPid);
      expect(report.peer?.start).toMatch(/^\d+$/);
      expect(report.survivor?.start).toMatch(/^\d+$/);
      expect(report.peer?.pid).not.toBe(report.mainPid);
      expect(report.survivor?.pid).not.toBe(report.mainPid);
    }, 20_000);
  }

  for (const outcome of ["commit-resolve", "commit-reject"] as const) {
    test(`withholds owner close and facade ACK until an admitted cache commit settles (${outcome}) after revocation`, async () => {
      const report = await scenario(outcome);
      expect(report.outcome).toBe(outcome);
      expect(report.revoked).toBe(true);
      expect(report.commitCalls).toBe(1);
      expect(report.ownerClosed).toBe(true);
      expect(report.facadeClosed).toBe(true);
      expect(report.disposed).toBe(1);
    }, 20_000);
  }

  test("uses the caller's healthy lease signal when an aborted same-artifact lease is still disposing", async () => {
    const report = await scenario("lease-identity");
    expect(report.preparationCalls).toBe(2);
    expect(report.firstAborted).toBe(true);
    expect(report.secondHealthy).toBe(true);
    expect(report.firstDisposalHeld).toBe(true);
    expect(report.executed).toBe(true);
    expect(report.disposed).toBe(1);
    expect(report.identity?.pid).toBeGreaterThan(0);
    expect(report.identity?.start).toMatch(/^\d+$/);
  }, 20_000);

  test("rejects facade publication when one socket write carries a valid attach reply followed by an invalid header", async () => {
    const report = await scenario("authentication-fence");
    expect(report.authenticationControl?.authenticated).toBe(true);
    expect(report.authenticationControl?.rejected).toBe(false);
    expect(report.authenticationControl?.closeCalls).toBe(1);
    expect(report.authenticationFault?.authenticated).toBe(true);
    expect(report.authenticationFault?.rejected).toBe(true);
    expect(report.authenticationFault?.replyWrites).toBe(1);
    expect(report.authenticationFault?.closeCalls).toBe(0);
    expect(report.disposed).toBe(true);
  }, 20_000);
});
