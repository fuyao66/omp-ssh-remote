import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolResultReplies } from "@oh-my-pi/pi-tui/chat/reply-write";
import { captureOutReplyCapability } from "../src/extension.ts";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { assertNestedRemoteTool } from "../src/nested-dispatch.ts";

function nativeWriter(cwd: string, overrides: Record<string, unknown>, tuiTranscript: boolean, taskDepth = 0): WriteTool {
  return new WriteTool({
    cwd, settings: Settings.isolated(overrides), tuiTranscript, taskDepth,
    getSessionFile: () => null, getSessionSpawns: () => "",
  } as ToolSession);
}

test("reply capability follows the native bound write gate, not hasUI or extension mode", () => {
  for (const [overrides, tuiTranscript, taskDepth, allowed] of [
    [{}, true, 0, true], [{}, false, 0, false],
    [{ "out.enabled": true }, false, 0, true], [{ "out.enabled": false }, true, 0, false],
    [{ "out.enabled": true }, true, 1, false],
  ] as const) {
    const writer = nativeWriter("/tmp", overrides, tuiTranscript, taskDepth);
    expect(captureOutReplyCapability(writer.approval, taskDepth)).toBe(allowed);
  }
  expect(captureOutReplyCapability(undefined)).toBe(false);
});

test("only canonical reply writes cross the nested host-resource boundary", () => {
  expect(() => assertNestedRemoteTool("write", { path: "out://", content: "reply" }, "binding", "hashline")).not.toThrow();
  for (const path of ["local://host.txt", "skill://host-skill"]) {
    expect(() => assertNestedRemoteTool("write", { path, content: "x" }, "binding", "hashline"))
      .toThrow("host resource unavailable from the remote runtime");
  }
  expect(() => assertNestedRemoteTool("read", { path: "out://" }, "binding", "hashline"))
    .toThrow("host resource unavailable from the remote runtime");
});

test("worker initialize preserves native out replies and refusal without changing wire schemas", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omp-out-replies-"));
  let baseline: unknown[] | undefined;
  try {
    for (const options of [{ outReplies: true, taskDepth: 0 }, { outReplies: false, taskDepth: 0 }, { outReplies: true, taskDepth: 1 }]) {
      const client = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
      try {
        const ready = await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE, undefined, options);
        const schemas = ready.tools.map(({ name, parameters, customFormat, customWireName }) => ({ name, parameters, customFormat, customWireName }));
        if (baseline === undefined) baseline = schemas;
        else expect(schemas as unknown[]).toEqual(baseline);
        const allowed = options.outReplies && options.taskDepth === 0;
        const writer = nativeWriter(cwd, { "out.enabled": options.outReplies }, false, options.taskDepth);
        const decision = writer.approval({ path: "out://", content: "reply" });
        const refusal = typeof decision === "object" ? decision.reason : undefined;
        for (const bashScope of [undefined, "session"] as const) {
          const frames: AgentToolResult[] = [];
          const result = await client.execute("bash", `reply-${bashScope ?? "native"}`, {
            command: "printf 'REMOTE_REPLY_SENTINEL' > out://", timeout: 10,
          }, undefined, update => frames.push(update as AgentToolResult), { bashScope }) as AgentToolResult;
          if (allowed) {
            expect(result.isError).not.toBe(true);
            expect(toolResultReplies(result.details)).toEqual(["REMOTE_REPLY_SENTINEL"]);
            expect(frames.some(frame => toolResultReplies(frame.details).includes("REMOTE_REPLY_SENTINEL"))).toBe(true);
          } else {
            expect(refusal).toBeDefined();
            // The native embedded shell surfaces the gate's EROFS as a redirect failure;
            // the refusal reason itself is asserted through the bridged write below.
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("failed to redirect to out://");
            expect(toolResultReplies(result.details)).toEqual([]);
          }
        }
        for (const language of ["js", "py"] as const) {
          const result = await client.execute("eval", `reply-eval-${language}`, {
            language, title: "Native bridged replies", code: language === "js"
              ? 'await tool.write({path:"out://",content:"EVAL_WRITE_REPLY"}); await tool.bash({command:"printf EVAL_BASH_REPLY > out://"});'
              : 'await tool.write({"path":"out://","content":"EVAL_WRITE_REPLY"})\nawait tool.bash({"command":"printf EVAL_BASH_REPLY > out://"})',
          }, undefined, undefined, {
            onInvoke: async (invocation, signal, onUpdate) => invocation.tool === "write"
              ? writer.execute(invocation.toolCallId, invocation.args as Parameters<WriteTool["execute"]>[1], signal)
              : client.execute(invocation.tool, invocation.toolCallId, invocation.args, signal, onUpdate),
          }) as AgentToolResult;
          if (allowed) {
            expect(result.isError).not.toBe(true);
            expect(toolResultReplies(result.details)).toEqual(["EVAL_WRITE_REPLY", "EVAL_BASH_REPLY"]);
          } else {
            expect(JSON.stringify(result)).toContain(refusal!);
            expect(toolResultReplies(result.details)).toEqual([]);
          }
        }
        expect(await readdir(cwd)).not.toContain("out:");
      } finally {
        await client.close();
        expect(await client.waitForExit()).toBe(0);
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
