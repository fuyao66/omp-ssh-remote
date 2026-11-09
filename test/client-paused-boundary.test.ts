import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "bun:test";

interface BoundaryReport {
  inherited: boolean;
  delivered: number;
  prefillCount: number;
  kernelTailIsolated: boolean;
  actualExitBeforeAck: boolean;
  highWaterMarkAtPause: number;
  highWaterMarkAfterDrain: number;
  readableBeforeExit: number;
  readableAfterExit: number;
  tailPayload: number;
  bulk: { bulkBytes: number; kind: "pipe" | "socket"; capacity: number; queued: number };
  tailCapacity: { capacity: number; queued: number };
  written: { tailBytes: number; queued: number };
}

// Capacity observation uses Linux fcntl/ioctl; no pipe settings are changed.
const boundaryTest = process.platform === "linux" ? test : test.skip;
for (const inherited of [false, true]) {
  boundaryTest(`paused queue boundary preserves all output ${inherited ? "with" : "without"} inherited stdout`, async () => {
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/client-paused-boundary-harness.ts"),
      "host", inherited ? "inherited" : "plain"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
    const closed = once(child, "close");
    // Failure deadline only: fake time cannot drive real pipe acquisition or process exit.
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => expired.reject(new Error(`paused boundary harness timed out: ${stderr}`)), 35_000);
    try {
      const [code] = await Promise.race([closed, expired.promise]);
      assert.equal(code, 0, stderr);
      const report = JSON.parse(stdout.trim()) as BoundaryReport;
      assert.equal(report.inherited, inherited);
      assert.equal(report.delivered, 17 + report.prefillCount);
      assert.equal(report.actualExitBeforeAck, true);
      assert.equal(report.kernelTailIsolated, true);
      assert.ok(report.written.queued > 0, "the producer confirmed kernel-resident bytes before exit");
      assert.ok(report.readableBeforeExit >= report.highWaterMarkAtPause);
      assert.ok(report.bulk.bulkBytes > 16 * 1024 * 1024);
      assert.ok(report.written.tailBytes < (report.tailCapacity.capacity - report.tailCapacity.queued) * 3 / 4);
      // Preserve the measured capacity/readable boundary in focused probe output.
      console.log(JSON.stringify(report));
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await closed;
    }
  }, 40_000);
}
