import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
  resolveJobOwnerId,
  resolveLocalAsyncJobManager,
  startRemoteAsyncBashJob,
} from "../src/omp/async-bash.ts";

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
});

describe("job owner resolution", () => {
  test("a second root and its child register jobs with their own manager", async () => {
    const first = new AsyncJobManager({ maxRunningJobs: 4 });
    const second = new AsyncJobManager({ maxRunningJobs: 4 });
    const previous = AsyncJobManager.instance();
    AsyncJobManager.setInstance(first);
    const registry = new AgentRegistry();
    type Session = Parameters<AgentRegistry["register"]>[0]["session"];
    registry.register({ id: "First", displayName: "first", kind: "main", sessionFile: "/s/first.jsonl", session: { asyncJobManager: first } as Session });
    registry.register({ id: "Second", displayName: "second", kind: "main", sessionFile: "/s/second.jsonl", session: { asyncJobManager: second } as Session });
    registry.register({ id: "Child", displayName: "child", kind: "sub", parentId: "Second", sessionFile: "/s/second/Child.jsonl", session: { asyncJobManager: second } as Session });
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
      session: null,
      sessionFile: "/s/main.jsonl",
    });
    registry.register({
      id: "Worker",
      displayName: "sub",
      kind: "sub",
      session: null,
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
