import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { consumedResolution, stagedProposal } from "../src/extension.ts";

test("native stale AST error consumes its preview and the matching origin exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "remote-proposal-consumption-"));
  const runtime = await createNativeWorkerRuntime(cwd);
  try {
    await writeFile(join(cwd, "stale.ts"), "const value = oldApi(1);\n");
    const origins: string[] = [];
    expect(runtime.session.peekPendingInvoker?.()).toBeUndefined();
    const preview = await runtime.tools.write.execute("preview", {
      path: "xd://ast_edit",
      content: JSON.stringify({ ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["stale.ts"] }),
    });
    expect(stagedProposal(preview as AgentToolResult)).toBe(true);
    origins.push("remote");
    expect(runtime.session.peekPendingInvoker?.()).toBeDefined();
    expect(origins).toHaveLength(1);
    await writeFile(join(cwd, "stale.ts"), "const value = unrelated(2);\n");
    const applied = await runtime.tools.write.execute("resolve-stale", { path: "xd://resolve", content: "Apply the staged edit" }) as AgentToolResult;
    expect(applied.isError).toBe(true);
    expect(consumedResolution(applied)).toBe(true);
    if (consumedResolution(applied)) origins.pop();
    expect(runtime.session.peekPendingInvoker?.()).toBeUndefined();
    expect(origins).toHaveLength(0);
    expect(await readFile(join(cwd, "stale.ts"), "utf8")).toBe("const value = unrelated(2);\n");
  } finally {
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native preview queue resolves stacked actions independently through resolution devices", async () => {
  const { queueResolveHandler } = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
  const cwd = await mkdtemp(join(tmpdir(), "remote-preview-queue-"));
  const runtime = await createNativeWorkerRuntime(cwd);
  try {
    const calls: string[] = [];
    const result = { content: [{ type: "text" as const, text: "resolved" }] };
    queueResolveHandler(runtime.session, { label: "first", sourceToolName: "ast_edit", apply: async () => { calls.push("first"); return result; } });
    queueResolveHandler(runtime.session, { label: "second", sourceToolName: "lsp", apply: async () => { calls.push("second"); return result; } });
    await runtime.tools.write.execute("resolve-second", { path: "xd://resolve", content: "Apply the second preview" });
    expect(calls).toEqual(["second"]);
    expect(runtime.session.peekPendingInvoker?.()).toBeDefined();
    await runtime.tools.write.execute("resolve-first", { path: "xd://resolve", content: "Apply the first preview" });
    expect(calls).toEqual(["second", "first"]);
    expect(runtime.session.peekPendingInvoker?.()).toBeUndefined();
    await runtime.tools.write.execute("reject-empty", { path: "xd://reject", content: "No preview remains" });
    await expect(runtime.tools.write.execute("resolve-empty", { path: "xd://resolve", content: "Apply nothing" })).rejects.toThrow();
    expect(calls).toEqual(["second", "first"]);
    expect(runtime.session.xdev?.resolve?.("ast_edit") === runtime.tools.ast_edit).toBe(true);
    expect(runtime.session.xdev?.resolve?.("unknown")).toBeUndefined();
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
