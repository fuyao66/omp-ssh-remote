import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { createCapturedBashTool } from "../src/omp/captured-bash.ts";
import {
  CAPTURE_PIPE_CHUNK_BYTES,
  CAPTURE_STAGE_LABEL_UNITS,
  CAPTURE_TEXT_CHUNK_UNITS,
  OUTPUT_CAPTURE_UNITS,
  PIPE_CAPTURE_BYTES,
  type JobCapturePayload,
} from "../src/omp/job-capture.ts";

let cwd: string;
beforeAll(async () => { cwd = await mkdtemp(join(tmpdir(), "omp-native-capture-")); });
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

function session(overrides: Partial<ToolSession> = {}): ToolSession {
  const id = `capture-test:async:${randomUUID()}`;
  let artifact = 0;
  return {
    cwd,
    hasUI: false,
    getSessionFile: () => null,
    getSessionSpawns: () => "",
    getSessionId: () => id,
    // A public owner must not reach the private manager's completion delivery.
    getAgentId: () => "Main",
    settings: Settings.isolated({
      "async.enabled": true,
      "bash.autoBackground.enabled": false,
      "bash.gitGuard": false,
      "bash.direnv": "off",
      "bashInterceptor.enabled": false,
      "launch.enabled": true,
      "lsp.enabled": true,
      "lsp.lazy": true,
      "lsp.shared": false,
      "memory.backend": "off",
      "eval.py": true,
      "eval.js": true,
      "tools.xdev": false,
      "debug.enabled": true,
      "worktree.clone": false,
    }),
    allocateOutputArtifact: async () => {
      const name = `${id.replaceAll(":", "-")}-${++artifact}`;
      return { id: name, path: join(cwd, name) };
    },
    ...overrides,
  };
}

function text(result: AgentToolResult): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function assertCaptureContracts(captures: JobCapturePayload[], requireClosed = true): void {
  let outputEnd = 0;
  let outputClosed = false;
  const pipes = new Map<number, { end: number; total: number; closed: boolean }>();
  for (const capture of captures) {
    if (capture.kind === "output") {
      expect(capture.start).toBeGreaterThanOrEqual(outputEnd);
      expect(capture.end - capture.start).toBe(capture.text.length);
      expect(capture.text.length).toBeLessThanOrEqual(CAPTURE_TEXT_CHUNK_UNITS);
      expect(outputClosed && capture.open).toBe(false);
      outputEnd = capture.end;
      outputClosed = !capture.open;
    } else if (capture.kind === "pipes") {
      for (const id of pipes.keys()) if (!capture.ids.includes(id)) pipes.delete(id);
    } else {
      const previous = pipes.get(capture.info.id);
      const bytes = Buffer.from(capture.dataBase64, "base64");
      expect(capture.start).toBeGreaterThanOrEqual(previous?.end ?? 0);
      expect(capture.end - capture.start).toBe(bytes.length);
      expect(bytes.length).toBeLessThanOrEqual(CAPTURE_PIPE_CHUNK_BYTES);
      expect(capture.info.total).toBeGreaterThanOrEqual(capture.end);
      expect(capture.info.total).toBeGreaterThanOrEqual(previous?.total ?? 0);
      expect(capture.info.producer.length).toBeLessThanOrEqual(CAPTURE_STAGE_LABEL_UNITS);
      expect(capture.info.consumer.length).toBeLessThanOrEqual(CAPTURE_STAGE_LABEL_UNITS);
      expect(Boolean(previous?.closed && capture.info.open)).toBe(false);
      pipes.set(capture.info.id, { end: capture.end, total: capture.info.total, closed: !capture.info.open });
    }
  }
  if (requireClosed) {
    expect(outputClosed).toBe(true);
    for (const pipe of pipes.values()) expect(pipe.closed).toBe(true);
  }
}

describe.each([false, true])("private native BashTool capture foreground=%s", (foreground) => {
  test("returns native success details and genuine closed output without private job carriers", async () => {
    const captures: JobCapturePayload[] = [];
    const updates: unknown[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    const result = await tool.execute("success", { command: "printf 'NATIVE_SUCCESS\\n'", timeout: 0 }, undefined,
      (update) => { updates.push(update); }) as AgentToolResult;
    expect(text(result)).toContain("NATIVE_SUCCESS");
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ timeoutDisabled: true });
    expect((result.details as Record<string, unknown>).wallTimeMs).toBeGreaterThanOrEqual(0);
    expect((result.details as Record<string, unknown>).async).toBeUndefined();
    expect((result.details as Record<string, unknown>).output).toBeUndefined();
    expect(JSON.stringify(updates)).not.toContain('"jobId"');
    expect(captures.filter((capture) => capture.kind === "output").map((capture) => capture.text).join(""))
      .toBe("NATIVE_SUCCESS\n");
    assertCaptureContracts(captures);
  });

  test("preserves native nonzero exit status and error text", async () => {
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    const result = await tool.execute("nonzero", { command: "printf 'FAILED_NATIVE\\n'; exit 7" }) as AgentToolResult;
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ exitCode: 7, timeoutSeconds: 300 });
    expect(text(result)).toContain("FAILED_NATIVE");
    expect(text(result)).toContain("7");
    assertCaptureContracts(captures);
  });

  test("cancels the private job on outer abort without starting more capture writes", async () => {
    const controller = new AbortController();
    const reason = new Error("outer capture cancelled");
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => {
      captures.push(capture);
      if (capture.kind === "output" && capture.text.includes("CANCEL_READY")) controller.abort(reason);
    }, foreground);
    await expect(tool.execute("cancel", { command: "printf 'CANCEL_READY\\n'; sleep 30", timeout: 0 }, controller.signal)).rejects.toBe(reason);
    expect(controller.signal.aborted).toBe(true);
    assertCaptureContracts(captures, false); // Cancellation may prevent terminal capture frames.
    const count = captures.length;
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(captures).toHaveLength(count);
  }, 10_000);

  test("forwards an already-aborted signal after native job registration", async () => {
    const controller = new AbortController();
    controller.abort();
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    await expect(tool.execute("pre-aborted", { command: "sleep 30", timeout: 0 }, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(captures).toHaveLength(0);
  }, 10_000);

  test("preserves native timeout metadata rather than treating it as cancellation", async () => {
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    const result = await tool.execute("timeout", { command: "printf 'TIMEOUT_READY\\n'; sleep 30", timeout: 1 }) as AgentToolResult;
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ timedOut: true, timeoutSeconds: 1 });
    expect(text(result)).toContain("timed out");
    assertCaptureContracts(captures);
  }, 10_000);

  test("captures bytes before tail, independently from the command's final stdout", async () => {
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    const result = await tool.execute("pipeline", { command: "seq 1 100 | tail -n 3" }) as AgentToolResult;
    const pipeCaptures = captures.filter((capture) => capture.kind === "pipe");
    expect(pipeCaptures.length).toBeGreaterThan(0);
    const firstId = pipeCaptures[0]!.info.id;
    const bytes = Buffer.concat(pipeCaptures.filter((capture) => capture.info.id === firstId)
      .map((capture) => Buffer.from(capture.dataBase64, "base64"))).toString();
    expect(bytes).toBe(Array.from({ length: 100 }, (_, index) => `${index + 1}\n`).join(""));
    const output = captures.filter((capture) => capture.kind === "output").map((capture) => capture.text).join("");
    expect(output).toBe("98\n99\n100\n");
    expect(text(result)).toContain(output.trimEnd());
    expect(text(result)).not.toContain("1\n2\n3\n");
    assertCaptureContracts(captures);
  });

  test("preserves binary pipe bytes that cannot be reconstructed from a text preview", async () => {
    const captures: JobCapturePayload[] = [];
    const bytes = Buffer.from([0, 255, 128, 13, 10, 27, 65]);
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    const script = `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`;
    const result = await tool.execute("binary-pipeline", {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} | wc -c`,
    }) as AgentToolResult;
    const pipes = captures.filter((capture) => capture.kind === "pipe");
    expect(pipes.length).toBeGreaterThan(0);
    const id = pipes[0]!.info.id;
    expect(Buffer.concat(pipes.filter((capture) => capture.info.id === id)
      .map((capture) => Buffer.from(capture.dataBase64, "base64")))).toEqual(bytes);
    expect(text(result)).toContain("7");
    assertCaptureContracts(captures);
  });

  test("publishes retained pipe membership after older finished streams are removed", async () => {
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    await tool.execute("pipe-retention", {
      command: Array.from({ length: 7 }, (_, index) => `printf '${index}\\n' | cat`).join("; "),
    });
    const finalMembership = captures.filter((capture) => capture.kind === "pipes").at(-1)!;
    expect(finalMembership.ids).toHaveLength(4);
    expect(Math.min(...finalMembership.ids)).toBeGreaterThan(1);
    assertCaptureContracts(captures);
  });

  test("isolates private shell keys for concurrent native background starts", async () => {
    const tool = createCapturedBashTool(session(), async () => {}, foreground);
    const results = await Promise.all([
      tool.execute("concurrent-one", { command: "sleep 0.1; printf 'ISOLATED_ONE'", timeout: 1 }),
      tool.execute("concurrent-two", { command: "sleep 0.1; printf 'ISOLATED_TWO'", timeout: 1 }),
    ]) as AgentToolResult[];
    expect(text(results[0]!)).toContain("ISOLATED_ONE");
    expect(text(results[1]!)).toContain("ISOLATED_TWO");
    for (const result of results) expect(text(result)).not.toContain("session shell is busy");
  });

  test("rejects validation failures without waiting for nonexistent native registration", async () => {
    const captures: JobCapturePayload[] = [];
    const tool = createCapturedBashTool(session(), async (capture) => { captures.push(capture); }, foreground);
    await expect(tool.execute("invalid-cwd", {
      command: "printf 'NEVER_RUN'", cwd: join(cwd, `missing-${randomUUID()}`),
    })).rejects.toThrow("Working directory does not exist");
    expect(captures).toHaveLength(0);
  });

  test("awaits send backpressure, drains final windows with native retention gaps, and stops callbacks", async () => {
    const captures: JobCapturePayload[] = [];
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeFinished = Promise.withResolvers<void>();
    const gate = join(cwd, `gate-${randomUUID()}`);
    const script = join(cwd, `emit-${randomUUID()}.js`);
    // Put the sentinel on its own line: native column clipping intentionally
    // omits a marker placed after 3 MiB on one physical line.
    await writeFile(script, `const fs = require('node:fs');\nconst gate = ${JSON.stringify(gate)};\nlet emitted = false;\nconst watcher = fs.watch(require('node:path').dirname(gate), emit);\nfunction emit() {\n if (emitted || !fs.existsSync(gate)) return;\n emitted = true;\n watcher.close();\n process.stdout.write('X'.repeat(3 * 1024 * 1024) + '\\nRETENTION_END\\n');\n}\nemit();\n`);
    let concurrent = 0;
    let maximumConcurrent = 0;
    let updates = 0;
    let settled = false;
    let callbacksAfterSettle = 0;
    const tool = createCapturedBashTool(session(), async (capture) => {
      if (settled) callbacksAfterSettle++;
      concurrent++;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      try {
        if (captures.length === 0) {
          blocked.resolve();
          await release.promise;
        }
        captures.push(capture);
        await Promise.resolve();
      } finally { concurrent--; }
    }, foreground);
    const execution = tool.execute("backpressure", {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} | cat`, timeout: 0,
    }, undefined, (update) => {
      if (settled) callbacksAfterSettle++;
      updates++;
      if (typeof (update as AgentToolResult).details?.wallTimeMs === "number") nativeFinished.resolve();
    }).then((result) => { settled = true; return result as AgentToolResult; });
    try {
      await blocked.promise;
      await writeFile(gate, "go");
      await nativeFinished.promise;
      expect(settled).toBe(false);
      expect(captures).toHaveLength(0);
    } finally { release.resolve(); }
    const result = await execution;
    const output = captures.filter((capture): capture is Extract<JobCapturePayload, { kind: "output" }> =>
      capture.kind === "output" && capture.text.length > 0);
    const pipes = captures.filter((capture): capture is Extract<JobCapturePayload, { kind: "pipe" }> =>
      capture.kind === "pipe" && capture.end > capture.start);
    expect(output[0]!.start).toBeGreaterThan(0);
    expect(output.reduce((length, capture) => length + capture.text.length, 0)).toBe(OUTPUT_CAPTURE_UNITS);
    expect(output.at(-1)!.text).toContain("RETENTION_END");
    expect(pipes[0]!.start).toBeGreaterThan(0);
    const firstId = pipes[0]!.info.id;
    expect(pipes.filter((capture) => capture.info.id === firstId)
      .reduce((length, capture) => length + capture.end - capture.start, 0)).toBe(PIPE_CAPTURE_BYTES);
    expect(maximumConcurrent).toBe(1);
    expect(text(result)).toContain("RETENTION_END");
    const notice = formatOutputNotice((result.details as { meta?: OutputMeta }).meta);
    expect(notice.length).toBeGreaterThan(0);
    expect(text(result).endsWith(notice)).toBe(false);
    const finishedUpdates = updates;
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(updates).toBe(finishedUpdates);
    expect(callbacksAfterSettle).toBe(0);
    assertCaptureContracts(captures);
  }, 15_000);

  test("uses manager errorText when artifact allocation fails before terminal progress", async () => {
    const captures: JobCapturePayload[] = [];
    const updates: unknown[] = [];
    const tool = createCapturedBashTool(session({
      allocateOutputArtifact: async () => { throw new Error("allocation failure sentinel"); },
    }), async (capture) => { captures.push(capture); }, foreground);
    const result = await tool.execute("allocation-failure", { command: "printf 'NEVER_RUN'" }, undefined,
      (update) => { updates.push(update); }) as AgentToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("allocation failure sentinel");
    expect(updates).toHaveLength(0);
    assertCaptureContracts(captures);
  });

  test("cancels and settles native execution before rejecting a capture send failure", async () => {
    let captures = 0;
    let updates = 0;
    const failure = new Error("capture transport failed");
    const tool = createCapturedBashTool(session(), async () => { captures++; throw failure; }, foreground);
    await expect(tool.execute("send-failure", { command: "sleep 30", timeout: 0 }, undefined,
      () => { updates++; })).rejects.toBe(failure);
    const finishedCaptures = captures;
    const finishedUpdates = updates;
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(captures).toBe(finishedCaptures);
    expect(updates).toBe(finishedUpdates);
  }, 10_000);

  test("hard cancellation settles while a capture write remains blocked", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("capture backpressure cancelled");
    let sends = 0;
    const tool = createCapturedBashTool(session(), async () => {
      sends++;
      entered.resolve();
      await release.promise;
    }, foreground);
    const execution = tool.execute("blocked-send", { command: "sleep 30", timeout: 0 }, controller.signal);
    try {
      await entered.promise;
      controller.abort(reason);
      await expect(execution).rejects.toBe(reason);
      expect(sends).toBe(1);
    } finally {
      release.resolve();
      controller.abort(reason);
      await execution.catch(() => {});
    }
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(sends).toBe(1);
  }, 6000);
});

test("managed foreground capture preserves native session shell state without changing caller settings", async () => {
  const id = `capture-persistent-${randomUUID()}`;
  const nativeSession = session({ getSessionId: () => id });
  const captures: JobCapturePayload[] = [];
  const tool = createCapturedBashTool(nativeSession, async (capture) => { captures.push(capture); }, true);
  try {
    await tool.execute("set-state", { command: "CAPTURE_STATE=kept; printf 'STATE_SET\\n'", timeout: 0 });
    const result = await tool.execute("get-state", {
      command: "printf 'state=%s\\n' \"$CAPTURE_STATE\"", timeout: 0,
    }) as AgentToolResult;
    expect(text(result)).toContain("state=kept");
    expect(result.details).toMatchObject({ timeoutDisabled: true });
    expect(lookup("bash.autoBackground.enabled")?.get(nativeSession.settings)).toBe(false);
    expect(captures.some((capture) => capture.kind === "output" && capture.text.includes("state=kept"))).toBe(true);
  } finally {
    releaseShellSessions(id);
  }
});
