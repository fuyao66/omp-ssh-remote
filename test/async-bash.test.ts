import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
  resolveJobOwnerId,
  resolveLocalAsyncJobManager,
  runRemoteForegroundBashJob,
  type RemoteAsyncBashJobOptions,
  startRemoteAsyncBashJob,
} from "../src/omp/async-bash.ts";
import type { JobCapturePayload } from "../src/omp/job-capture.ts";

function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function settle(manager: AsyncJobManager, id: string): Promise<void> {
  const job = manager.getJob(id);
  if (!job) throw new Error(`job ${id} missing`);
  await job.promise;
}

describe("remote async bash job bridge", () => {
  let manager: AsyncJobManager;
  beforeEach(() => {
    manager = new AsyncJobManager({ maxRunningJobs: 4, retentionMs: 60_000 });
  });
  afterEach(async () => {
    await manager.dispose({ timeoutMs: 1_000 });
  });

  test("returns a backgrounded result and completes the local job from the remote result", async () => {
    let seenParams: Record<string, unknown> | undefined;
    const updates: AgentToolResult[] = [];
    let emitRemoteUpdate: ((update: unknown) => void) | undefined;
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 1; echo done",
      params: { command: "sleep 1; echo done", async: true, timeout: 60 },
      remoteCwd: "/srv/project",
      onUpdate: (update) => updates.push(update),
      execute: async (params, _signal, onUpdate) => {
        seenParams = params;
        emitRemoteUpdate = onUpdate;
        onUpdate({ ...textResult("partial"), details: { output: "partial", timeoutSeconds: 60 } });
        return { ...textResult("done\n"), details: { output: "done\n", exitCode: 0 } };
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    expect(started.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(started)).toContain(`Backgrounded as job ${jobId}`);
    expect(JSON.stringify(started)).toContain("/srv/project");
    expect(seenParams?.async).toBeUndefined();
    expect(seenParams?.command).toBe("sleep 1; echo done");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      content: [{ type: "text", text: "partial" }],
      details: { async: { state: "running", jobId, type: "bash" }, remoteCwd: "/srv/project", timeoutSeconds: 60 },
    });

    await settle(manager, jobId);
    const job = manager.getJob(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.resultText).toBe("done\n");
    expect(job?.ownerId).toBe("Main");
    expect(job?.latestDetails).toMatchObject({
      async: { state: "completed", jobId, type: "bash" },
    });
    expect(job?.latestDetails?.output).toBe("done\n");
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({
      content: [{ type: "text", text: "done\n" }],
      details: { async: { state: "completed", jobId, type: "bash" }, remoteCwd: "/srv/project", exitCode: 0 },
    });
    emitRemoteUpdate?.(textResult("late output"));
    expect(updates).toHaveLength(2);
    expect(job?.progressText).toBe("done\n");
  });

  test("marks the job failed when the remote result is an error", async () => {
    const updates: AgentToolResult[] = [];
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "false",
      params: { command: "false", async: true },
      remoteCwd: "/srv",
      onUpdate: (update) => updates.push(update),
      execute: async () => textResult("exit 1", true),
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.status).toBe("failed");
    expect(manager.getJob(jobId)?.errorText).toBe("exit 1");
    expect(updates).toEqual([{
      content: [{ type: "text", text: "exit 1" }],
      details: { async: { state: "failed", jobId, type: "bash" }, remoteCwd: "/srv" },
    }]);
    expect(manager.getJob(jobId)?.latestDetails).toMatchObject({
      async: { state: "failed", jobId, type: "bash" },
    });
  });

  test("local cancel aborts the remote execution signal", async () => {
    let aborted = false;
    const updates: AgentToolResult[] = [];
    let emitRemoteUpdate: ((update: unknown) => void) | undefined;
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 30",
      params: { command: "sleep 30", async: true },
      remoteCwd: "/srv",
      onUpdate: (update) => updates.push(update),
      execute: (_params, signal, onUpdate) => {
        emitRemoteUpdate = onUpdate;
        onUpdate(textResult("started"));
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("Remote tool call cancelled"));
          });
        });
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    expect(manager.cancel(jobId)).toBe(true);
    emitRemoteUpdate?.(textResult("output after abort"));
    await settle(manager, jobId);
    expect(aborted).toBe(true);
    expect(manager.getJob(jobId)?.status).toBe("cancelled");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.details).toMatchObject({ async: { state: "running", jobId } });
    expect(updates[1]).toEqual({
      content: [{ type: "text", text: "Remote tool call cancelled" }],
      details: { async: { state: "cancelled", jobId, type: "bash" }, remoteCwd: "/srv" },
    });
    expect(manager.getJob(jobId)?.latestDetails).toMatchObject({ async: { state: "cancelled", jobId } });
    emitRemoteUpdate?.(textResult("late output"));
    expect(updates).toHaveLength(2);
  });

  test("transport loss fails the job closed", async () => {
    const updates: AgentToolResult[] = [];
    let emitRemoteUpdate: ((update: unknown) => void) | undefined;
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 30",
      params: { command: "sleep 30", async: true },
      remoteCwd: "/srv",
      onUpdate: (update) => updates.push(update),
      execute: async (_params, _signal, onUpdate) => {
        emitRemoteUpdate = onUpdate;
        throw new Error("Remote runtime exited with code 255");
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.status).toBe("failed");
    expect(manager.getJob(jobId)?.errorText).toContain("exited with code 255");
    expect(updates).toEqual([{
      content: [{ type: "text", text: "Remote runtime exited with code 255" }],
      details: { async: { state: "failed", jobId, type: "bash" }, remoteCwd: "/srv" },
    }]);
    expect(manager.getJob(jobId)?.latestDetails).toMatchObject({ async: { state: "failed", jobId } });
    emitRemoteUpdate?.(textResult("late output"));
    expect(updates).toHaveLength(1);
    expect(manager.getJob(jobId)?.progressText).toBe("Remote runtime exited with code 255");
  });

  test("keeps the card cancelled when the remote execution resolves after abort", async () => {
    const updates: AgentToolResult[] = [];
    let finish!: (result: AgentToolResult) => void;
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 30",
      params: { command: "sleep 30", async: true },
      remoteCwd: "/srv",
      onUpdate: (update) => updates.push(update),
      execute: () => new Promise((resolve) => { finish = resolve; }),
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    expect(manager.cancel(jobId)).toBe(true);
    finish(textResult("remote finished during cancellation"));
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.status).toBe("cancelled");
    expect(updates).toEqual([{
      content: [{ type: "text", text: "remote finished during cancellation" }],
      details: { async: { state: "cancelled", jobId, type: "bash" }, remoteCwd: "/srv" },
    }]);
  });

  test("forwards metadata-only running updates under the local job identity", async () => {
    const updates: AgentToolResult[] = [];
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "true",
      params: { command: "true", async: true },
      remoteCwd: "/srv",
      onUpdate: (update) => updates.push(update),
      execute: async (_params, _signal, onUpdate) => {
        onUpdate({
          content: [],
          details: { timeoutSeconds: 60, async: { state: "running", jobId: "remote-id" }, remoteCwd: "/wrong" },
        });
        return textResult("");
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    expect(updates[0]).toEqual({
      content: [{ type: "text", text: "" }],
      details: { timeoutSeconds: 60, async: { state: "running", jobId, type: "bash" }, remoteCwd: "/srv" },
    });
    await settle(manager, jobId);
    expect(updates).toHaveLength(2);
    expect(updates[1]?.details).toMatchObject({ async: { state: "completed", jobId } });
  });

  test.each([false, true])("keeps final images available for native async delivery (isError=%s)", async isError => {
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const updates: AgentToolResult[] = [];
    const started = startRemoteAsyncBashJob({
      manager, ownerId: "Main", command: "plot", params: { command: "plot", async: true }, remoteCwd: "/srv",
      onUpdate: update => updates.push(update),
      execute: async () => ({ content: [{ type: "text", text: "plot" }, image], isError, details: { meta: { artifactId: "plot" } } }),
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.latestDetails?.images).toEqual([image]);
    expect(updates.at(-1)?.details).toMatchObject({ images: [image], meta: { artifactId: "plot" } });
    expect(manager.getJob(jobId)?.status).toBe(isError ? "failed" : "completed");
  });

  test("registers only genuine command output and pipeline capture as widget inputs", async () => {
    const result = Promise.withResolvers<AgentToolResult>();
    let capture!: (payload: JobCapturePayload) => void;
    let update!: (payload: unknown) => void;
    let scope: string | undefined;
    const started = startRemoteAsyncBashJob({
      manager, ownerId: "Main", command: "printf raw | cat", params: { command: "printf raw | cat", async: true, i: "Read Raw Bytes" }, remoteCwd: "/srv",
      execute: (_params, _signal, onUpdate, onCapture, requestedScope) => {
        update = onUpdate;
        capture = onCapture;
        scope = requestedScope;
        return result.promise;
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    const job = manager.getJob(jobId)!;
    update(textResult("rendered preview, not bytes"));
    expect(job.widgetInputs?.sources()[0]?.read(0).text).toBe("");
    capture({ kind: "output", start: 0, end: 3, text: "raw", open: true });
    capture({ kind: "pipe", info: { id: 7, producer: "printf raw", consumer: "cat", total: 3, open: true }, start: 0, end: 3, dataBase64: Buffer.from("raw").toString("base64") });
    expect(scope).toBe("job");
    expect(job.process).toMatchObject({ command: "printf raw | cat", cwd: "/srv" });
    expect(job.process?.streams?.list()).toEqual([{ id: 7, producer: "printf raw", consumer: "cat", total: 3, open: true }]);
    expect(job.process?.streams?.read(7, 0)?.data.toString()).toBe("raw");
    expect(job.widgetInputs?.sources()[0]?.read(0)).toMatchObject({ text: "raw", start: 0, end: 3, open: true });
    expect(job.widgetInputs?.sources()).toHaveLength(2);
    expect(job.widgetInputs?.brief()).toMatchObject({ kind: "bash", command: "printf raw | cat", intent: "Read Raw Bytes" });
    result.resolve(textResult("formatted final, not bytes"));
    await job.promise;
    expect(job.widgetInputs?.sources()[0]?.read(0)).toMatchObject({ text: "raw", open: false });
    expect(job.process?.streams?.read(7, 0)).toMatchObject({ open: false });
    capture({ kind: "output", start: 3, end: 7, text: "late", open: true });
    expect(job.widgetInputs?.sources()[0]?.read(0).text).toBe("raw");
  });
});

describe("remote foreground bash job bridge", () => {
  let manager: AsyncJobManager;
  let options: Omit<RemoteAsyncBashJobOptions, "execute">;
  beforeEach(() => {
    manager = new AsyncJobManager({ maxRunningJobs: 4, retentionMs: 60_000 });
    options = { manager, ownerId: "Main", command: "sleep 1; echo done", params: { command: "sleep 1; echo done", timeout: 60 }, remoteCwd: "/srv" };
  });
  afterEach(async () => {
    await manager.dispose({ timeoutMs: 1_000 });
  });

  test.each([false, true])("fast completion returns the original native result (isError=%s) and removes the hidden row", async isError => {
    const registration = spyOn(manager, "register");
    const updates: AgentToolResult[] = [];
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const native: AgentToolResult = { content: [{ type: "text", text: "done" }, image], isError, details: { meta: { artifactId: "original" }, exitCode: isError ? 1 : 0 } };
    let seenScope: string | undefined;
    const returned = await runRemoteForegroundBashJob({
      ...options, thresholdMs: 60_000, onUpdate: update => updates.push(update),
      execute: async (_params, _signal, update, _capture, scope) => {
        seenScope = scope;
        expect(manager.getAllJobs()).toEqual([]);
        update({ ...textResult("partial"), details: { output: "partial", timeoutSeconds: 60 } });
        return native;
      },
    });
    const jobId = registration.mock.results[0]!.value as string;
    const job = manager.getJob(jobId);
    if (job) await job.promise;
    expect(returned).toBe(native);
    expect(seenScope).toBe("session");
    expect(registration.mock.calls[0]?.[3]?.foreground).toBe(true);
    expect(updates[0]?.details).toEqual({ timeoutSeconds: 60, remoteCwd: "/srv" });
    expect(updates.every(update => !(update.details as Record<string, unknown>)?.async)).toBe(true);
    expect(manager.getJob(jobId)).toBeUndefined();
    expect(manager.getDeliveryState().pendingJobIds).toEqual([]);
  });

  test("threshold promotion keeps the same request, changes frames, and unlinks caller abort", async () => {
    const result = Promise.withResolvers<AgentToolResult>();
    const caller = new AbortController();
    const updates: AgentToolResult[] = [];
    let signal!: AbortSignal;
    let emit!: (update: unknown) => void;
    let calls = 0;
    const waiting = runRemoteForegroundBashJob({
      ...options, thresholdMs: 1, signal: caller.signal, onUpdate: update => updates.push(update),
      execute: (_params, runSignal, onUpdate, _capture, scope) => {
        calls++;
        expect(scope).toBe("session");
        signal = runSignal;
        emit = onUpdate;
        emit(textResult("before promotion"));
        return result.promise;
      },
    });
    expect(manager.getAllJobs()).toEqual([]);
    expect(updates[0]?.details).not.toHaveProperty("async");
    const notice = await waiting;
    const jobId = (notice.details as { async: { jobId: string } }).async.jobId;
    expect(manager.getRunningJobs().map(job => job.id)).toEqual([jobId]);
    expect(JSON.stringify(notice)).toContain("before promotion");
    caller.abort();
    expect(signal.aborted).toBe(false);
    emit(textResult("after promotion"));
    expect(updates.at(-1)?.details).toMatchObject({ async: { state: "running", jobId, type: "bash" } });
    result.resolve(textResult("done"));
    await settle(manager, jobId);
    expect(calls).toBe(1);
    expect(manager.getJob(jobId)?.status).toBe("completed");
    expect(updates.at(-1)?.details).toMatchObject({ async: { state: "completed", jobId } });
    const count = updates.length;
    emit(textResult("late"));
    expect(updates).toHaveLength(count);
  });

  test("promotion retains the same genuine capture sources across foreground and background output", async () => {
    const registration = spyOn(manager, "register");
    const result = Promise.withResolvers<AgentToolResult>();
    let capture!: (payload: JobCapturePayload) => void;
    const waiting = runRemoteForegroundBashJob({
      ...options, thresholdMs: 1,
      execute: (_params, _signal, update, onCapture) => {
        capture = onCapture;
        update(textResult("preview must not become source data"));
        capture({ kind: "output", start: 0, end: 3, text: "raw", open: true });
        return result.promise;
      },
    });
    const jobId = registration.mock.results[0]!.value as string;
    const before = manager.getJob(jobId)!;
    const source = before.widgetInputs!.sources()[0]!;
    const process = before.process;
    const notice = await waiting;
    expect((notice.details as { async: { jobId: string } }).async.jobId).toBe(jobId);
    expect(manager.getJob(jobId)?.process).toBe(process);
    expect(manager.getJob(jobId)?.widgetInputs?.sources()[0]).toBe(source);
    capture({ kind: "output", start: 3, end: 7, text: "data", open: true });
    expect(source.read(0)).toMatchObject({ text: "rawdata", start: 0, end: 7, open: true });
    result.resolve(textResult("formatted final"));
    await before.promise;
    expect(source.read(0)).toMatchObject({ text: "rawdata", open: false });
  });

  test("soft steering promotes early without aborting the job", async () => {
    const result = Promise.withResolvers<AgentToolResult>();
    const steering = new AbortController();
    let signal!: AbortSignal;
    const waiting = runRemoteForegroundBashJob({
      ...options, thresholdMs: 60_000, steeringSignal: steering.signal,
      execute: (_params, runSignal) => { signal = runSignal; return result.promise; },
    });
    steering.abort();
    const notice = await waiting;
    const jobId = (notice.details as { async: { jobId: string } }).async.jobId;
    expect(JSON.stringify(notice)).toContain("incoming message");
    expect(signal.aborted).toBe(false);
    expect(manager.getJob(jobId)?.foreground).toBeUndefined();
    result.resolve(textResult("done"));
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.status).toBe("completed");
  });

  test("hard cancellation aborts the remote request and releases its hidden row", async () => {
    const registration = spyOn(manager, "register");
    const caller = new AbortController();
    const updates: AgentToolResult[] = [];
    let signal!: AbortSignal;
    let emit!: (update: unknown) => void;
    const waiting = runRemoteForegroundBashJob({
      ...options, thresholdMs: 60_000, signal: caller.signal, onUpdate: update => updates.push(update),
      execute: (_params, runSignal, onUpdate) => {
        signal = runSignal;
        emit = onUpdate;
        emit(textResult("working"));
        return new Promise((_resolve, reject) => runSignal.addEventListener("abort", () => reject(new Error("remote cancelled")), { once: true }));
      },
    });
    const jobId = registration.mock.results[0]!.value as string;
    const job = manager.getJob(jobId)!;
    caller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "ToolAbortError", message: "working" });
    await job.promise;
    expect(signal.aborted).toBe(true);
    expect(job.status).toBe("cancelled");
    expect(manager.getJob(jobId)).toBeUndefined();
    expect(manager.getDeliveryState().pendingJobIds).toEqual([]);
    const count = updates.length;
    emit(textResult("late"));
    expect(updates).toHaveLength(count);
    expect(updates.every(update => !(update.details as Record<string, unknown>)?.async)).toBe(true);
  });

  test("foreground transport failure rejects and never publishes a background row", async () => {
    const registration = spyOn(manager, "register");
    const failure = new Error("SSH transport lost");
    const waiting = runRemoteForegroundBashJob({ ...options, thresholdMs: 60_000, execute: async () => { throw failure; } });
    const jobId = registration.mock.results[0]!.value as string;
    const job = manager.getJob(jobId)!;
    await expect(waiting).rejects.toBe(failure);
    await job.promise;
    expect(manager.getJob(jobId)).toBeUndefined();
    expect(manager.getDeliveryState().pendingJobIds).toEqual([]);
  });

  test.each(["failure", "cancel"])("promoted %s emits terminal async metadata and ignores late frames", async kind => {
    const result = Promise.withResolvers<AgentToolResult>();
    const updates: AgentToolResult[] = [];
    let emit!: (update: unknown) => void;
    const notice = await runRemoteForegroundBashJob({
      ...options, thresholdMs: 1, onUpdate: update => updates.push(update),
      execute: (_params, _signal, update) => { emit = update; return result.promise; },
    });
    const jobId = (notice.details as { async: { jobId: string } }).async.jobId;
    if (kind === "cancel") {
      expect(manager.cancel(jobId)).toBe(true);
      emit(textResult("ignored after cancellation"));
      result.resolve(textResult("cancelled result"));
    } else {
      result.reject(new Error("SSH connection lost"));
    }
    await settle(manager, jobId);
    const state = kind === "cancel" ? "cancelled" : "failed";
    expect(manager.getJob(jobId)?.status).toBe(state);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.details).toMatchObject({ async: { state, jobId } });
    emit(textResult("late update"));
    expect(updates).toHaveLength(1);
  });

  test.each([0, 1])("native zero wait uses an isolated visible job (timeout=%s)", async timeout => {
    const registration = spyOn(manager, "register");
    const result = Promise.withResolvers<AgentToolResult>();
    const updates: AgentToolResult[] = [];
    let scope: string | undefined;
    const notice = await runRemoteForegroundBashJob({
      ...options, params: { ...options.params, timeout }, thresholdMs: timeout === 0 ? 0 : 60_000,
      onUpdate: update => updates.push(update),
      execute: (params, _signal, update, _capture, requestedScope) => {
        expect(params.timeout).toBe(timeout);
        scope = requestedScope;
        update(textResult("already async"));
        return result.promise;
      },
    });
    const jobId = (notice.details as { async: { jobId: string } }).async.jobId;
    expect(scope).toBe("job");
    expect(registration.mock.calls[0]?.[3]?.foreground).toBe(false);
    expect(updates[0]?.details).toMatchObject({ async: { state: "running", jobId } });
    expect(manager.getRunningJobs()).toHaveLength(1);
    if (timeout === 0) expect(notice.details).toMatchObject({ timeoutDisabled: true });
    result.resolve(textResult("done"));
    await settle(manager, jobId);
  });

  test("timeout zero stays unlimited and raw timeout values remain the remote tool's responsibility", async () => {
    for (const timeout of [undefined, 0, 10_000]) {
      const params = timeout === undefined ? { command: "true" } : { command: "true", timeout };
      const native = textResult("done");
      const returned = await runRemoteForegroundBashJob({
        ...options, params, thresholdMs: 60_000,
        execute: async remoteParams => {
          expect(remoteParams).toEqual(params);
          return native;
        },
      });
      expect(returned).toBe(native);
    }
  });
});

describe("job owner resolution", () => {
  test("a second root and its child register jobs with their own manager", async () => {
    const first = new AsyncJobManager({ maxRunningJobs: 4 });
    const second = new AsyncJobManager({ maxRunningJobs: 4 });
    const previous = AsyncJobManager.instance();
    AsyncJobManager.setInstance(first);
    const registry = new AgentRegistry();
    type Session = Parameters<AgentRegistry["register"]>[0]["session"];
    registry.register({ id: "First", displayName: "first", kind: "main", sessionFile: "/s/first.jsonl", session: { sessionManager: { getSessionFile: () => "/s/first.jsonl" }, asyncJobManager: first } as Session });
    registry.register({ id: "Second", displayName: "second", kind: "main", sessionFile: "/s/second.jsonl", session: { sessionManager: { getSessionFile: () => "/s/second.jsonl" }, asyncJobManager: second } as Session });
    registry.register({ id: "Child", displayName: "child", kind: "sub", parentId: "Second", sessionFile: "/s/second/Child.jsonl", session: { sessionManager: { getSessionFile: () => "/s/second/Child.jsonl" }, asyncJobManager: second } as Session });
    try {
      for (const sessionFile of ["/s/second.jsonl", "/s/second/Child.jsonl"]) {
        const manager = resolveLocalAsyncJobManager(sessionFile, registry);
        if (!manager) throw new Error("Missing session job manager");
        const result = startRemoteAsyncBashJob({ manager, ownerId: resolveJobOwnerId(sessionFile, registry), command: "echo scoped", params: { command: "echo scoped", async: true }, remoteCwd: "/srv", execute: async () => textResult("scoped") });
        await settle(second, (result.details as { async: { jobId: string } }).async.jobId);
      }
      expect(first.getAllJobs()).toEqual([]);
      expect(second.getAllJobs().map(job => [job.ownerId, job.resultText])).toEqual([["Second", "scoped"], ["Child", "scoped"]]);
      expect(resolveLocalAsyncJobManager("/s/missing.jsonl", registry)).toBeUndefined();
    } finally {
      AsyncJobManager.setInstance(previous);
      await Promise.all([first.dispose({ timeoutMs: 1000 }), second.dispose({ timeoutMs: 1000 })]);
    }
  });
  test("matches the agent registered with the session file", () => {
    const registry = new AgentRegistry();
    registry.register({
      id: "Main",
      displayName: "main",
      kind: "main",
      session: { sessionManager: { getSessionFile: () => "/s/main.jsonl" } } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
      sessionFile: "/s/main.jsonl",
    });
    registry.register({
      id: "Worker",
      displayName: "sub",
      kind: "sub",
      session: { sessionManager: { getSessionFile: () => "/s/main/Worker.jsonl" } } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
      sessionFile: "/s/main/Worker.jsonl",
    });
    expect(resolveJobOwnerId("/s/main/Worker.jsonl", registry)).toBe("Worker");
    expect(resolveJobOwnerId("/s/main.jsonl", registry)).toBe("Main");
  });

  test("falls back to Main only when unambiguous", () => {
    expect(resolveJobOwnerId("/nowhere.jsonl", new AgentRegistry())).toBe(
      MAIN_AGENT_ID,
    );
    const registry = new AgentRegistry();
    registry.register({ id: "A", displayName: "a", kind: "sub", session: null });
    registry.register({ id: "B", displayName: "b", kind: "sub", session: null });
    expect(resolveJobOwnerId("/nowhere.jsonl", registry)).toBeUndefined();
  });
});
