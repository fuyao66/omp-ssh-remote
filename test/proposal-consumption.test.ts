import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { consumedResolution, stagedProposal } from "../src/extension.ts";

test("native stale AST error consumes its preview and the matching origin exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "remote-proposal-consumption-"));
  const runtime = await createNativeWorkerRuntime(cwd, "18.12.6");
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
