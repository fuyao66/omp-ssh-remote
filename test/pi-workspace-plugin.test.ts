import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool } from "../src/pi/workspace-plugin.ts";

type Event = Record<string, unknown>;

function runner(options: {
  block?: string;
  mutate?: (event: Event) => void;
  result?: (event: Event) => { content?: unknown[]; isError?: boolean } | undefined;
} = {}) {
  const events: Event[] = [];
  return {
    events,
    emit: async (event: Event) => {
      options.mutate?.(event);
      events.push(event);
    },
    emitToolCall: async (event: Event) => {
      options.mutate?.(event);
      events.push(event);
      return options.block ? { block: true, reason: options.block } : undefined;
    },
    emitToolResult: async (event: Event) => {
      options.mutate?.(event);
      events.push(event);
      return options.result?.(event);
    },
    createContext: () => ({}),
  };
}

describe("model-free Pi workspace execution", () => {
  test("blocks a command before its filesystem side effect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-workspace-hook-"));
    const marker = join(dir, "blocked");
    const hooks = runner({ block: "policy rejected command" });
    try {
      const result = await executeWorkspaceTool({
        runner: hooks as never,
        toolName: "command",
        toolCallId: "blocked",
        args: { marker },
        tool: {
          async execute() {
            await Bun.write(marker, "created");
            return { content: [] };
          },
        },
      });
      await expect(stat(marker)).rejects.toThrow();
      expect(result.isError).toBe(true);
      expect(hooks.events.map((event) => event.type)).toEqual([
        "tool_execution_start",
        "tool_call",
        "tool_execution_end",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses mutated arguments once and forwards transformed streaming and result data", async () => {
    let executed = 0;
    const updates: unknown[] = [];
    const hooks = runner({
      mutate(event) {
        if (event.type === "tool_call") (event.input as { value: string }).value = "mutated";
        if (event.type === "tool_execution_update") event.partialResult = "transformed update";
      },
      result: () => ({ content: [{ type: "text", text: "transformed result" }] }),
    });
    const result = await executeWorkspaceTool({
      runner: hooks as never,
      toolName: "command",
      toolCallId: "mutated",
      args: { value: "original" },
      onUpdate: (update) => updates.push(update),
      tool: {
        async execute(_id, args, _signal, update) {
          executed++;
          expect(args).toEqual({ value: "mutated" });
          update?.("original update");
          return { content: [{ type: "text", text: "original result" }] };
        },
      },
    });
    expect(executed).toBe(1);
    expect(updates).toEqual(["transformed update"]);
    expect(result.content).toEqual([{ type: "text", text: "transformed result" }]);
    expect(hooks.events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_call",
      "tool_execution_update",
      "tool_result",
      "tool_execution_end",
    ]);
  });

  test("reports thrown and returned failures, and cancellation, without execution", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    let executed = false;
    const cancelledResult = await executeWorkspaceTool({
      runner: runner() as never,
      toolName: "command",
      toolCallId: "cancelled",
      args: {},
      signal: cancelled.signal,
      tool: { async execute() { executed = true; return { content: [] }; } },
    });
    expect(executed).toBe(false);
    expect(cancelledResult.isError).toBe(true);

    const returnedFailure = await executeWorkspaceTool({
      runner: runner() as never,
      toolName: "command",
      toolCallId: "returned-failure",
      args: {},
      tool: { async execute() { return { content: [], isError: true }; } },
    });
    expect(returnedFailure.isError).toBe(true);
  });
});
