import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
  resolveJobOwnerId,
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
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 1; echo done",
      params: { command: "sleep 1; echo done", async: true, timeout: 60 },
      remoteCwd: "/srv/project",
      execute: async (params, _signal, onUpdate) => {
        seenParams = params;
        onUpdate(textResult("partial"));
        return textResult("done\n");
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    expect(started.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(started)).toContain(`Backgrounded as job ${jobId}`);
    expect(JSON.stringify(started)).toContain("/srv/project");
    expect(seenParams?.async).toBeUndefined();
    expect(seenParams?.command).toBe("sleep 1; echo done");

    await settle(manager, jobId);
    const job = manager.getJob(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.resultText).toBe("done\n");
    expect(job?.ownerId).toBe("Main");
    expect(job?.latestDetails).toMatchObject({
      async: { state: "completed", jobId, type: "bash" },
    });
  });

  test("marks the job failed when the remote result is an error", async () => {
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "false",
      params: { command: "false", async: true },
      remoteCwd: "/srv",
      execute: async () => textResult("exit 1", true),
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.status).toBe("failed");
    expect(manager.getJob(jobId)?.errorText).toBe("exit 1");
  });

  test("local cancel aborts the remote execution signal", async () => {
    let aborted = false;
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 30",
      params: { command: "sleep 30", async: true },
      remoteCwd: "/srv",
      execute: (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("Remote tool call cancelled"));
          });
        }),
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    expect(manager.cancel(jobId)).toBe(true);
    await settle(manager, jobId);
    expect(aborted).toBe(true);
    expect(manager.getJob(jobId)?.status).toBe("cancelled");
  });

  test("transport loss fails the job closed", async () => {
    const started = startRemoteAsyncBashJob({
      manager,
      ownerId: "Main",
      command: "sleep 30",
      params: { command: "sleep 30", async: true },
      remoteCwd: "/srv",
      execute: async () => {
        throw new Error("Remote runtime exited with code 255");
      },
    });
    const jobId = (started.details as { async: { jobId: string } }).async.jobId;
    await settle(manager, jobId);
    expect(manager.getJob(jobId)?.status).toBe("failed");
    expect(manager.getJob(jobId)?.errorText).toContain("exited with code 255");
  });
});

describe("job owner resolution", () => {
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
