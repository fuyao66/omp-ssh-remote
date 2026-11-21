import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { probeDaemon } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";
import { RemoteRuntimeClient } from "../../src/client.ts";
import { createCapturedBashTool } from "../../src/omp/captured-bash.ts";
import { mergeProcessListings } from "../../src/omp/process-routing.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../../src/omp/runtime-contract.ts";
import { completeProcReceipt, startRemoteService } from "../../src/omp/service-jobs.ts";

const cwd = process.cwd();
const owner = "native-narrow-owner";
let nextArtifact = 0;
const text = (result: AgentToolResult) => result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
const images = (result: AgentToolResult) => result.content.filter(block => block.type === "image");

function session(manager: AsyncJobManager): ToolSession {
  return {
    cwd, hasUI: false, asyncJobManager: manager,
    getSessionFile: () => null, getSessionSpawns: () => "", getSessionId: () => owner, getAgentId: () => null,
    settings: Settings.isolated({ "launch.enabled": false, "async.enabled": true, "bash.direnv": "off", "bash.gitGuard": false }),
    allocateOutputArtifact: async () => {
      const id = `native-${++nextArtifact}`;
      return { id, path: join(cwd, id) };
    },
  };
}

async function withCompanion<T>(
  run: (client: RemoteRuntimeClient) => Promise<T>,
  settings: Record<string, unknown> = { "bash.direnv": "off" },
): Promise<T> {
  const client = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../../src/worker.ts")], cwd });
  try {
    await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE, 8_000, { settings, sessionId: owner });
    return await run(client);
  } finally {
    await client.close(3_000);
    assert.equal(await client.waitForExit(), 0, "companion did not shut down cleanly");
  }
}

function execute(client: RemoteRuntimeClient, tool: "bash" | "read" | "write", id: string, args: Record<string, unknown>) {
  return client.execute(tool, id, args, AbortSignal.timeout(6_000)) as Promise<AgentToolResult>;
}

function launch(client: RemoteRuntimeClient, key: string, id: string) {
  return execute(client, "bash", id, { name: key, command: "printf 'native-narrow-ready\\n'; exec sleep 30", pty: false,
    ready: { log: "native-narrow-ready", timeout: 4 } });
}

async function stop(client: RemoteRuntimeClient, key: string, id: string) {
  const result = await execute(client, "write", id, { path: `proc://${key}/kill`, content: "" });
  assert.ok(!result.isError, text(result));
  return result;
}

async function renderProcList() {
  const manager = new AsyncJobManager({ onJobComplete() {} });
  const pending = Promise.withResolvers<string>();
  try {
    const job = manager.register("bash", "Narrow native job label", () => pending.promise);
    const local = await new ReadTool(session(manager)).execute("native-local-list", { path: "proc://" });
    await withCompanion(async client => {
      const key = "narrow-native-service";
      const launchResult = await launch(client, key, "native-launch");
      assert.ok(!launchResult.isError, text(launchResult));
      const remote = await execute(client, "read", "native-remote-list", { path: "proc://" });
      assert.ok(!remote.isError, text(remote));
      const details = remote.details as { proc?: { daemons?: { key: string; generation: string; pids: number[]; state: string; policy: object }[] } };
      const unit = details?.proc?.daemons?.find(unit => unit.key === key);
      assert.ok(unit, "native daemon snapshot missing from proc listing");
      assert.ok(unit.pids.some(pid => pid > 0) && unit.policy && unit.generation, "native daemon snapshot incomplete");
      assert.match(unit.state, /^(ready|running)$/);

      const merged = mergeProcessListings(local, remote);
      const theme = await getThemeByName("dark");
      assert.ok(theme);
      // Keep model-facing text out of the assertion: these must be structured rows.
      const rendered = readToolRenderer.renderResult({ ...merged, content: [] }, { expanded: true, isPartial: false }, theme, { path: "proc://" })
        .render(160).map(line => Bun.stripANSI(line));
      assert.ok(rendered.some(line => line.includes(job) && line.includes("Narrow native job label")), rendered.join("\n"));
      assert.ok(rendered.some(line => line.includes(key) && line.includes("service") && line.includes(unit.state)), rendered.join("\n"));
      await stop(client, key, "native-list-cleanup");
    });
  } finally {
    pending.resolve("done");
    await manager.dispose();
  }
}

async function captureImages() {
  // A single-pixel PNG, sent twice via Kitty APC: ESC _ G ... ; base64 ESC \\.
  // The SDK retains both frames in latestDetails, but its async terminal update
  // carries only text. This exercises both restoration and deduplication.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7p0AAAAASUVORK5CYII=";
  const frame = `\\033_Ga=T,t=d,f=100,q=2,m=0;${png}\\033\\\\`;
  const command = `printf '${frame}${frame}\\nimage-capture-sentinel\\n'`;
  const manager = new AsyncJobManager({ onJobComplete() {} });
  try {
    const nativeSession = session(manager);
    const registered = await new BashTool(nativeSession).execute("native-images", { command, async: true });
    const id = registered.details?.async?.jobId;
    const nativeJob = id && manager.getJob(id);
    assert.ok(nativeJob, "image fixture did not register a native asynchronous job");
    await nativeJob.promise;
    assert.equal(nativeJob.status, "completed", nativeJob.errorText ?? "native image job did not complete");
    const retained = nativeJob.latestDetails?.images;
    assert.equal(retained?.length, 2, "native Bash must retain both Kitty frames");
    assert.deepEqual(retained?.[0], retained?.[1]);
    assert.equal(retained?.[0]?.mimeType, "image/png");
    const capture = createCapturedBashTool(nativeSession, async () => {});
    const result = await capture.execute("captured-images", { command }, AbortSignal.timeout(6_000)) as AgentToolResult;
    assert.ok(!result.isError, text(result));
    assert.match(text(result), /image-capture-sentinel/);
    assert.deepEqual(images(result), [retained?.[0]], "capture must restore exactly one PNG from the two retained frames");
  } finally {
    await manager.dispose();
    releaseShellSessions(owner);
  }
}

async function serviceStop() {
  const manager = new AsyncJobManager({ maxRunningJobs: 1, onJobComplete() {} });
  const occupied = Promise.withResolvers<string>();
  try {
    await withCompanion(async client => {
      const key = "narrow-tracked-service";
      const launchSlot = manager.register("bash", "Occupied", () => occupied.promise, { ownerId: owner });
      const blocker = manager.getJob(launchSlot)!;
      let launchCalls = 0;
      const trackedLaunch = () => {
        launchCalls++;
        return launch(client, key, "tracked-launch");
      };
      await assert.rejects(startRemoteService(client, key, owner, manager, trackedLaunch), /maximum|capacity|limit|too many/i);
      assert.equal(launchCalls, 0, "capacity rejection must occur before issuing any remote launch");
      occupied.resolve("slot released");
      await blocker.promise;

      // Two genuine write receipts under the same key, from distinct daemon generations.
      const previous = await launch(client, key, "previous-launch");
      assert.ok(!previous.isError, text(previous));
      const stale = await stop(client, key, "previous-stop");
      const receipt = (result: AgentToolResult) => {
        const proc = (result.details as { proc?: { action: string; daemon: { key: string; generation: string } } }).proc;
        assert.equal(proc?.action, "stop");
        assert.equal(proc.daemon.key, key);
        assert.ok(proc.daemon.generation);
        return proc.daemon.generation;
      };
      const staleGeneration = receipt(stale);
      const current = await startRemoteService(client, key, owner, manager, trackedLaunch);
      assert.ok(!current.isError, text(current));
      assert.equal(launchCalls, 1, "a freed slot must admit exactly one remote launch");
      const job = manager.getAllJobs({ ownerId: owner }).find(job => job.status === "running");
      assert.ok(job, "the owned remote service must have a running local job");
      assert.equal(completeProcReceipt(client, stale), false, "an earlier real stop may not settle the current generation");
      assert.equal(job.status, "running");
      const stopped = await stop(client, key, "current-stop");
      assert.notEqual(receipt(stopped), staleGeneration);
      assert.equal(completeProcReceipt(client, stopped), true);
      await job.promise;
      assert.equal(job.status, "completed", job.errorText ?? "matched stop did not complete the local job");
      assert.equal(JSON.parse(job.resultText!).operation, "stop");
    });
  } finally {
    occupied.resolve("done");
    await manager.dispose();
  }
}

async function shellSettings() {
  await mkdir(".omp");
  await writeFile(".omp/config.yml", "bash:\n  direnv: off\n  direnvLoadTimeoutMs: 1\n");
  const project = await Settings.loadReadOnly({ cwd });
  assert.equal(lookup("bash.direnv")?.get(project), "off", "the conflicting project config must be discoverable");
  assert.equal(lookup("bash.direnvLoadTimeoutMs")?.get(project), 1);
  await writeFile(".envrc", "# direnv discovery marker; the test executable implements the export.\n");
  const bin = join(cwd, "bin");
  await mkdir(bin);
  const direnv = join(bin, "direnv");
  await writeFile(direnv, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'export json') process.exit(2);\nawait Bun.write('direnv-called', 'export json');\nawait Bun.sleep(400);\nconsole.log(JSON.stringify({ NARROW_DIRENV_VALUE: 'from-direnv' }));\n`);
  await chmod(direnv, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  for (const { mode, budget, value, called } of [
    { mode: "auto", budget: 3_000, value: "from-direnv", called: true },
    { mode: "auto", budget: 150, value: "unset", called: true },
    { mode: "off", budget: 3_000, value: "unset", called: false },
  ] as const) {
    await Bun.file("direnv-called").delete().catch(() => {});
    await withCompanion(async client => {
      // No caller command timeout to clamp the independent direnv budget. An
      // unnamed foreground Bash command consumes the process-wide Settings.init.
      const result = await execute(client, "bash", "direnv-probe", {
        command: 'printf "value=%s\\n" "${NARROW_DIRENV_VALUE-unset}"', timeout: 0,
      });
      assert.ok(!result.isError, text(result));
      assert.equal(text(result).trim(), `value=${value}`, `forwarded ${mode}/${budget}ms lost to a prior singleton or project settings`);
      assert.equal(await Bun.file("direnv-called").exists(), called, `unexpected direnv dispatch for ${mode}/${budget}ms`);
      if (called) assert.equal(await readFile("direnv-called", "utf8"), "export json");
    }, { "bash.direnv": mode, "bash.direnvLoadTimeoutMs": budget });
  }
}

try {
  switch (process.argv[2]) {
    case "proc-list": await renderProcList(); break;
    case "capture-images": await captureImages(); break;
    case "service-stop": await serviceStop(); break;
    case "shell-settings": await shellSettings(); break;
    default: throw new Error(`Unknown scenario: ${process.argv[2]}`);
  }
} finally {
  // The subprocess can only discover the daemon in its own fresh HOME.
  const daemon = await probeDaemon();
  if (daemon) {
    try { await daemon.request({ op: "shutdown" }, AbortSignal.timeout(3_000)); }
    finally { daemon.close(); }
  }
}
