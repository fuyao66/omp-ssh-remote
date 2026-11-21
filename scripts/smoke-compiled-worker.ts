#!/usr/bin/env bun
/** Run on Linux x64 after `bun run build:worker:x64`; no SSH or installed omp required. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { probeDaemon } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { DAEMON_DIR_ENV, DAEMON_TCP_ENV, DAEMON_WORKER_ARG, projectScope, type DaemonClient } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { shellProcessArgs } from "@oh-my-pi/pi-coding-agent/exec/shell-process-protocol";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils/worker-host";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";
import { PROTOCOL_VERSION, decodeFrames, encodeMessage, parseMessage, type Message, type Request } from "../src/protocol.ts";

const binary = resolve(import.meta.dir, "../packages/omp/dist/worker-linux-x64");
const deadlineMs = 25_000;
const text = (result: AgentToolResult) => result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim();

type Companion = {
  child: Bun.Subprocess<"pipe", "pipe", "inherit">;
  execute(tool: "bash" | "eval", id: string, args: Record<string, unknown>): Promise<AgentToolResult>;
};

async function within<T>(pending: Promise<T>, label: string, ms = deadlineMs): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  try {
    return await Promise.race([pending, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

// Native service PIDs come from the private daemon. Compare exact Linux start
// ticks before acting so neither a stale row nor PID reuse targets another task.
async function liveStart(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  assert.equal(process.argv.length, 2, "usage: bun scripts/smoke-compiled-worker.ts");
  assert.ok(process.platform === "linux" && process.arch === "x64", "compiled worker smoke requires Linux x64");
  const root = await mkdtemp(join(tmpdir(), "omp-compiled-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const temp = join(root, "tmp");
  const bin = join(root, "bin");
  const env = {
    HOME: home, TMPDIR: temp, PATH: "/usr/bin:/bin",
    PI_CODING_AGENT_DIR: join(home, "agent"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
  };
  // Probe only the exact private endpoint the compiled entry derives from HOME.
  process.env[DAEMON_DIR_ENV] = join(home, ".cache/omp-ssh-remote-daemon");
  delete process.env[DAEMON_TCP_ENV];
  const ownedServices = new Map<number, string>();
  const children: { kill(signal: NodeJS.Signals): void; exited: Promise<number>; exitCode: number | null }[] = [];
  let daemon: DaemonClient | undefined;
  let daemonWorker: Bun.Subprocess<"ignore", "ignore", "inherit"> | undefined;
  try {
    await Promise.all([home, cwd, temp, bin].map(path => mkdir(path)));
    daemonWorker = Bun.spawn([binary, DAEMON_WORKER_ARG], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    const startedAt = performance.now();
    do {
      assert.equal(daemonWorker.exitCode, null, `compiled daemon selector exited early (${daemonWorker.exitCode})`);
      daemon = await probeDaemon();
      if (daemon) break;
      await Bun.sleep(40);
    } while (performance.now() - startedAt < deadlineMs);
    assert.ok(daemon, "compiled daemon selector never accepted a connection");
    assert.equal(daemon.welcome.daemon.pid, daemonWorker.pid, "handshake did not come from the compiled daemon child");
    const ping = await daemon.request({ op: "ping" }, AbortSignal.timeout(deadlineMs));
    assert.equal(ping.pid, daemonWorker.pid);
    console.log("PASS daemon: compiled selector authenticated and answered ping");

    const shell = Bun.spawn([binary, SHELL_PROCESS_SELECTOR, ...shellProcessArgs({
      command: "printf 'compiled-shell-stdout\\n'; printf 'compiled-shell-stderr\\n' >&2; exit 7",
    })], { cwd, env, stdout: "pipe", stderr: "pipe" });
    children.push(shell);
    const [status, stdout, stderr] = await within(Promise.all([
      shell.exited, new Response(shell.stdout).text(), new Response(shell.stderr).text(),
    ]), "compiled shell process");
    assert.equal(status, 7, stderr);
    assert.equal(stdout.trim(), "compiled-shell-stdout");
    assert.equal(stderr.trim(), "compiled-shell-stderr");
    console.log("PASS shell process: observed stdout, stderr and exit status from compiled selector");

    async function companion(path: string, sessionId: string, pathEnv = env.PATH): Promise<Companion> {
      const child = Bun.spawn([path], { cwd, env: { ...env, PATH: pathEnv }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      children.push(child);
      const frames = decodeFrames(child.stdout)[Symbol.asyncIterator]();
      const send = async (request: Request) => {
        child.stdin.write(encodeMessage(request));
        await child.stdin.flush();
      };
      const receive = async (label: string, accepts: (message: Message) => boolean) => within((async () => {
        for (;;) {
          const frame = await frames.next();
          assert.ok(!frame.done, `compiled companion closed stdout before ${label}`);
          const message = parseMessage(frame.value);
          if (message.type === "error") throw new Error(`${label}: ${message.error.message}`);
          if (accepts(message)) return message;
        }
      })(), label);
      await send({ type: "initialize", protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: OMP_RUNTIME_HANDSHAKE.runtimeVersion, hostVersion: SUPPORTED_SDK_VERSION,
        cwd, tools: ["bash", "eval"], sessionId, settings: { "bash.direnv": "off" } });
      const ready = await receive("companion handshake", frame => frame.type === "ready");
      assert.equal(ready.type, "ready");
      assert.equal(ready.cwd, cwd);
      assert.equal(ready.hostVersion, SUPPORTED_SDK_VERSION);
      assert.deepEqual(ready.tools.map(tool => tool.name).sort(), ["bash", "eval"]);
      const execute = async (tool: "bash" | "eval", id: string, args: Record<string, unknown>) => {
        await send({ type: "execute", id, toolCallId: id, tool, args });
        const frame = await receive(id, frame => frame.type === "result" && frame.id === id);
        assert.equal(frame.type, "result");
        const result = frame.result as AgentToolResult;
        assert.ok(!result.isError, `${id}: ${text(result)}`);
        return result;
      };
      return { child, execute };
    }

    async function checkEval(worker: Companion, fallback: boolean) {
      const result = await worker.execute("eval", fallback ? "eval-fallback-thread" : "eval-process", {
        language: "js", title: "Compiled Eval identity",
        code: `import { isMainThread } from "node:worker_threads"; import process from "node:process"; print("compiled-eval:" + isMainThread + ":" + process.pid);`,
      });
      const identity = /^compiled-eval:(true|false):(\d+)$/m.exec(text(result));
      assert.ok(identity, text(result));
      assert.equal(identity[1], fallback ? "false" : "true", `unexpected Eval runtime: ${text(result)}`);
      const evalPid = Number(identity[2]);
      if (fallback) assert.equal(evalPid, worker.child.pid);
      else {
        assert.notEqual(evalPid, worker.child.pid);
        assert.equal(await readlink(`/proc/${evalPid}/exe`), binary, "Eval process must re-enter this compiled image");
      }
      console.log(`PASS Eval ${fallback ? "fallback thread" : "process"}: code executed in the expected runtime`);
    }

    // Defeat subprocess re-entry without altering the release binary or
    // replacing its inode (same-build re-exec would use /proc/self/exe).
    const fallbackPath = join(root, "fallback-worker");
    await copyFile(binary, fallbackPath, constants.COPYFILE_FICLONE);
    await chmod(fallbackPath, 0o700);
    const fallback = await companion(fallbackPath, "compiled-fallback", bin);
    await chmod(fallbackPath, 0o600);
    await checkEval(fallback, true);
    await fallback.child.stdin.end();
    assert.equal(await within(fallback.child.exited, "fallback companion shutdown"), 0);

    const first = await companion(binary, "compiled-term");
    const result = await first.execute("bash", "companion-bash", { command: "printf 'compiled-companion-bash\\n'" });
    assert.equal(text(result), "compiled-companion-bash");
    console.log("PASS companion: handshake and foreground Bash over framed stdio");
    await checkEval(first, false);

    async function checkSignal(worker: Companion, signal: "SIGTERM" | "SIGHUP", code: number) {
      const key = `compiled-${signal.toLowerCase()}`;
      const launch = await worker.execute("bash", key, { name: key, pty: false,
        command: "printf 'compiled-service-ready\\n'; exec sleep 60", ready: { log: "compiled-service-ready", timeout: 8 } });
      const { unit } = await daemon!.request({ op: "describe", unit: { kind: "proc", scope: projectScope(cwd), key } }, AbortSignal.timeout(deadlineMs));
      const receipt = (launch.details as { service?: { ownership: string; id: string } }).service;
      assert.equal(receipt?.ownership, "owned");
      assert.equal(unit.generation, receipt.id);
      assert.ok(unit.pids.length > 0, "compiled service had no live process");
      for (const pid of unit.pids) {
        const start = await liveStart(pid);
        assert.ok(start, `compiled service PID ${pid} disappeared before ${signal}`);
        ownedServices.set(pid, start);
      }
      worker.child.kill(signal);
      assert.equal(await within(worker.child.exited, signal), code, `compiled companion did not convert ${signal} into a normal exit status`);
      for (const pid of unit.pids) {
        assert.notEqual(await liveStart(pid), ownedServices.get(pid), `service PID ${pid} survived ${signal} cleanup`);
        ownedServices.delete(pid);
      }
      console.log(`PASS ${signal}: companion exited ${code} after its owned service stopped`);
    }
    await checkSignal(first, "SIGTERM", 143);
    await checkSignal(await companion(binary, "compiled-hup"), "SIGHUP", 129);
    await daemon.request({ op: "shutdown" }, AbortSignal.timeout(deadlineMs));
    assert.equal(await within(daemonWorker.exited, "compiled daemon shutdown"), 0);
  } finally {
    // Stop only explicit children and service PIDs from the private daemon.
    // Let the daemon stop its units even when launch failed before we got a receipt.
    try {
      for (const child of children.reverse()) if (child.exitCode === null) child.kill("SIGKILL");
      if (daemonWorker?.exitCode === null) {
        daemonWorker.kill("SIGTERM");
        await within(daemonWorker.exited, "daemon failure cleanup", 5_000).catch(() => daemonWorker?.kill("SIGKILL"));
      }
      for (const [pid, start] of ownedServices) {
        if (await liveStart(pid) === start) {
          try { process.kill(pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      const exits = children.map(child => child.exited);
      if (daemonWorker) exits.push(daemonWorker.exited);
      await within(Promise.all(exits), "compiled smoke cleanup", 5_000);
    } finally {
      daemon?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

await main();
