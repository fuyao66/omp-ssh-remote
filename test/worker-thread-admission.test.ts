import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { persistRemoteIntent, REMOTE_INTENT_ENTRY } from "../src/remote-intent.ts";

type Report = {
  isMainThread: boolean;
  status: { mode: string; connectionError?: string };
  writeError: string | null;
  connectError: string | null;
  reconnectError: string | null;
};

async function runChild(remoteIntent: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "omp-worker-thread-admission-"));
  let worker: Worker | undefined;
  try {
    const ownerFile = join(directory, "owner.jsonl");
    const owner = await SessionManager.open(ownerFile, directory, undefined, { initialCwd: directory, suppressBreadcrumb: true });
    try {
      if (remoteIntent) {
        await persistRemoteIntent(() => owner.appendCustomEntry(REMOTE_INTENT_ENTRY, { version: 1, remote: true }), owner);
      } else {
        await owner.ensureOnDisk();
        await owner.flush();
      }
    } finally {
      await owner.close();
    }
    worker = new Worker(new URL("./fixtures/worker-thread-session.ts", import.meta.url), {
      workerData: { directory, sessionFile: join(directory, "owner", "subagent", "child.jsonl") },
    });
    const result = Promise.withResolvers<Report>();
    worker.once("message", result.resolve);
    worker.once("error", result.reject);
    worker.once("exit", code => result.reject(new Error(`Worker exited without a report (code ${code})`)));
    const report = await result.promise;
    const marker = await readFile(join(directory, "local-marker"), "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    expect(report.isMainThread).toBe(false);
    return { ...report, marker };
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker-thread child inherits remote intent from its ancestor and cannot execute locally", async () => {
  const result = await runChild(true);
  expect(result.status.mode).toBe("unavailable");
  expect(result.status.connectionError).toMatch(/runs on a worker thread.*task\.workerThreads: 0/);
  expect(result.status.connectionError).toBe(result.writeError ?? undefined);
  expect(result.marker).toBeNull();
  expect(result.reconnectError).toMatch(/worker-thread session cannot reconnect to a remote family/i);
});

test("worker-thread child without remote intent stays local and cannot create a remote family", async () => {
  const result = await runChild(false);
  expect(result.status.mode).toBe("local");
  expect(result.writeError).toBeNull();
  expect(result.marker).toBe("local write");
  expect(result.connectError).toMatch(/worker-thread session cannot create a remote family/i);
});
