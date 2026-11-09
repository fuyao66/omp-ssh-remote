import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { JobWidgets } from "@oh-my-pi/pi-coding-agent/job-widgets/registry";
import { validateJobWidgetSpec, type JobWidgetSpec } from "@oh-my-pi/pi-coding-agent/job-widgets/spec";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { startRemoteAsyncBashJob } from "../src/omp/async-bash.ts";
import { RemoteJobCapture } from "../src/omp/remote-capture.ts";

let cwd: string;
let client: RemoteRuntimeClient;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "omp-worker-capture-"));
  client = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
  const ready = await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE);
  expect(ready.capabilities?.jobCapture).toBe("native-retained");
});
afterAll(async () => { try { await client.close(); } finally { await rm(cwd, { recursive: true, force: true }); } });

const text = (result: AgentToolResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
function localSession(manager: AsyncJobManager): ToolSession {
  return {
    cwd, settings: Settings.isolated({ "launch.enabled": false }), hasUI: false,
    asyncJobManager: manager, getAgentId: () => "Main", getSessionId: () => "capture-consumer",
    getSessionFile: () => null, getSessionSpawns: () => "",
  };
}
const spec: JobWidgetSpec = {
  title: "Remote pipeline progress",
  rules: [{ from: "pipe:*", match: "^step=(?<step>\\d+)$", count: "seen" }],
  blocks: [
    { kind: "meter", field: "step", agg: "last", total: 3, label: "steps" },
    { kind: "stat", items: [{ field: "seen", agg: "count", label: "matches" }] },
  ],
  headline: { field: "step", agg: "last", label: "step" },
};

describe("real worker capture through native local consumers", () => {
  test("pre-tail bytes feed proc streams and native validated numeric widgets exactly once", async () => {
    const manager = new AsyncJobManager({ onJobComplete: () => {} });
    let id = "";
    let authorCalls = 0;
    const authorRequests: unknown[] = [];
    expect(validateJobWidgetSpec(spec, [{ id: "pipe:1", lines: ["step=1", "step=2", "step=3"] }], "three steps, total 3")).toMatchObject({ ok: true });
    const live = Promise.withResolvers<JobWidgetView>();
    const firstPipe = Promise.withResolvers<void>();
    const widgets = new JobWidgets({ minIngestMs: 0, authorAfterMs: 0, author: async request => {
      authorCalls++;
      authorRequests.push({ sources: request.sources, rejected: request.rejected });
      expect(request.sources.some(source => source.id.startsWith("pipe:") && source.head.includes("step=1"))).toBe(true);
      return spec; // Deterministic model boundary; native validation, ingestion and rendering data are real.
    } });
    manager.widgets = widgets;
    const unsubscribe = widgets.subscribe(() => {
      const job = manager.getJob(id);
      const view = job && widgets.view(job);
      if (view?.state === "live") live.resolve(view);
    });
    const fifo = join(cwd, "pipeline-release.fifo");
    let gate: Awaited<ReturnType<typeof open>> | undefined;
    let released = false;
    const release = async () => {
      if (gate && !released) {
        await gate.write("release\n");
        released = true;
      }
    };
    try {
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // RDWR keeps release nonblocking even if the worker fails before opening the FIFO.
      gate = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      const command = '{ for n in 1 2 3; do printf "step=%s\\n" "$n"; done; read -r _ < pipeline-release.fifo; } | tail -1';
      const started = startRemoteAsyncBashJob({
        manager, ownerId: "Main", command, remoteCwd: cwd,
        params: { command, async: true, timeout: 0 },
        execute: async (params, signal, update, capture, scope) => client.execute("bash", "pipeline", params, signal, update, { bashScope: scope, onCapture: payload => {
          capture(payload);
          const job = manager.getJob(id);
          if (job) widgets.view(job);
          if (payload.kind === "pipe" && Buffer.from(payload.dataBase64, "base64").includes(Buffer.from("step=1"))) firstPipe.resolve();
        } }) as Promise<AgentToolResult>,
      });
      id = (started.details as { async: { jobId: string } }).async.jobId;
      const job = manager.getJob(id)!;
      await Promise.race([firstPipe.promise, job.promise.then(() => { throw new Error("No pre-tail capture while running"); })]);
      expect(job.status).toBe("running");
      const reader = new ReadTool(localSession(manager));
      expect(text(await reader.execute("streams", { path: `proc://${id}/streams` }))).toContain(`proc://${id}/streams/1`);
      expect(text(await reader.execute("pipe", { path: `proc://${id}/streams/1` }))).toContain("step=1");
      const view = await Promise.race([live.promise, job.promise.then(() => { throw new Error(`No native live widget before settlement: ${JSON.stringify({ status: job.status, error: job.errorText, authorCalls, authorRequests, pipe: job.process?.streams?.read(1)?.data.toString(), view: widgets.view(job) })}`); })]);
      expect(view.state).toBe("live");
      await release();
      await job.promise;
      expect(job.status).toBe("completed");
      expect(job.resultText).toContain("step=3");
      expect(job.resultText).not.toContain("step=1");
      expect(job.process?.pids()).toEqual([]);
      expect(job.process?.streams?.read(1)?.data).toEqual(Buffer.from("step=1\nstep=2\nstep=3\n"));
      const finalView = widgets.view(job)!;
      const meter = finalView.blocks.find(block => block.kind === "meter");
      const stat = finalView.blocks.find(block => block.kind === "stat");
      expect(meter?.kind === "meter" && meter.value).toBe(1);
      expect(stat?.kind === "stat" && stat.items[0]?.text).toBe("3");
      expect(authorCalls).toBe(1);
      expect(widgets.view(job)).toEqual(finalView);
    } finally {
      try { await release(); } finally {
        unsubscribe();
        try { await manager.dispose({ timeoutMs: 2000 }); } finally { await gate?.close(); }
      }
    }
  }, 15_000);

  test("native proc kill cancels the remote request and freezes the retained sources", async () => {
    const manager = new AsyncJobManager({ onJobComplete: () => {} });
    const captured = Promise.withResolvers<void>();
    try {
      const started = startRemoteAsyncBashJob({
        manager, ownerId: "Main", command: "cancel capture", remoteCwd: cwd,
        params: { command: "printf 'CAPTURE_READY\\n'; sleep 20; printf 'NEVER_REACH\\n'", async: true, timeout: 0 },
        execute: async (params, signal, update, capture, scope) => client.execute("bash", "cancel-capture", params, signal, update, {
          bashScope: scope, onCapture: payload => { capture(payload); if (payload.kind === "output" && payload.text.includes("CAPTURE_READY")) captured.resolve(); },
        }) as Promise<AgentToolResult>,
      });
      const id = (started.details as { async: { jobId: string } }).async.jobId;
      const job = manager.getJob(id)!;
      await captured.promise;
      await new WriteTool(localSession(manager)).execute("kill", { path: `proc://${id}/kill`, content: "" });
      await job.promise;
      expect(job.status).toBe("cancelled");
      const out = job.widgetInputs!.sources().find(source => source.id === "out")!.read(0);
      expect(out.open).toBe(false);
      expect(out.text).toContain("CAPTURE_READY");
      expect(out.text).not.toContain("NEVER_REACH");
    } finally { await manager.dispose({ timeoutMs: 2000 }); }
  }, 12_000);
});

describe("forwarded native shell visualization", () => {
  for (const enabled of [true, false]) {
    test(`visualization=${enabled} retains native traces independently of output and pipe capture`, async () => {
      const scratch = await mkdtemp(join(tmpdir(), "omp-worker-trace-"));
      const worker = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
      try {
        await worker.initialize(scratch, OMP_RUNTIME_HANDSHAKE, undefined, {
          settings: { "display.shellVisualization": enabled },
        });
        // Foreground-backed and immediately backgrounded shells share the capture
        // transport, but use distinct native execution paths and shell ownership.
        for (const scope of ["session", "job"] as const) {
          const fifo = join(scratch, `${scope}.fifo`);
          expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
          const gate = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
          const capture = new RemoteJobCapture();
          const pipeReady = Promise.withResolvers<void>();
          const traceReady = Promise.withResolvers<void>();
          const updates: AgentToolResult<Pick<BashToolDetails, "trace">>[] = [];
          let released = false;
          const release = async () => {
            if (!released) { released = true; await gate.write("release\n"); }
          };
          try {
            const command = `{ printf 'step=1\\nstep=2\\nstep=3\\n'; read -r _ < ${scope}.fifo; } | tail -1`;
            const running = worker.execute("bash", `trace-${scope}`, { command, timeout: 10 }, undefined, value => {
              const update = value as AgentToolResult<Pick<BashToolDetails, "trace">>;
              updates.push(update);
              if (update.details?.trace) traceReady.resolve();
            }, {
              bashScope: scope,
              onCapture: payload => {
                capture.apply(payload);
                if (payload.kind === "pipe" && Buffer.from(payload.dataBase64, "base64").includes(Buffer.from("step=1"))) pipeReady.resolve();
              },
            }) as Promise<AgentToolResult<Pick<BashToolDetails, "trace">>>;
            const ready = enabled ? Promise.all([pipeReady.promise, traceReady.promise]) : pipeReady.promise;
            await Promise.race([ready, running.then(() => { throw new Error("Shell completed before live capture/trace was observed"); })]);
            if (enabled) expect(updates.some(update => update.details?.trace !== undefined)).toBe(true);
            await release();
            const result = await running;
            expect(result.isError).not.toBe(true);
            expect(result.details?.trace !== undefined).toBe(enabled);
            if (!enabled) expect(updates.every(update => update.details?.trace === undefined)).toBe(true);
            expect(text(result).trim()).toBe("step=3");
            expect(capture.sources().find(source => source.id === "out")!.read(0)).toMatchObject({ text: "step=3\n", open: false });
            const pipes = capture.streams.list();
            expect(pipes).toHaveLength(1);
            expect(capture.streams.read(pipes[0]!.id)).toMatchObject({ data: Buffer.from("step=1\nstep=2\nstep=3\n"), open: false });
          } finally {
            try { await release(); } finally { capture.close(); await gate.close(); }
          }
        }
      } finally {
        try { await worker.close(); } finally { await rm(scratch, { recursive: true, force: true }); }
      }
    }, 30_000);
  }
});
