import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiNativeWorkerRuntime } from "../src/pi-runtime.ts";
import {
  PI_TOOL_RUNTIME_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
} from "../src/protocol.ts";

describe("Pi + AFT worker runtime", () => {
  test("exposes real Pi/AFT schemas and executes both runtimes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-aft-runtime-"));
    await writeFile(
      join(tempDir, "sample.ts"),
      "export interface Account { id: string; active: boolean }\n",
    );
    const runtime = await createPiNativeWorkerRuntime(tempDir);
    try {
      expect(runtime.manifest.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(runtime.manifest.host).toBe("pi");
      expect(runtime.manifest.hostVersion).toBe(PI_VERSION);
      expect(runtime.manifest.toolRuntimeVersion).toBe(PI_TOOL_RUNTIME_VERSION);

      const manifests = new Map(
        runtime.manifest.tools.map((tool) => [tool.name, tool]),
      );
      for (const name of [
        "read",
        "write",
        "edit",
        "bash",
        "find",
        "ls",
        "bash_status",
        "aft_outline",
        "ast_grep_search",
      ]) {
        expect(manifests.has(name)).toBe(true);
        expect(manifests.get(name)?.parameters).toBeDefined();
      }
      expect(runtime.manifest.capabilities?.aftHostRuntime).toBe(
        "@cortexkit/aft-pi@0.51.2",
      );

      const bashResult = (await runtime.execute({
        type: "execute",
        id: "bash",
        toolCallId: "bash-call",
        tool: "bash",
        args: { command: "pwd" },
      })) as { content: Array<{ text?: string }> };
      expect(bashResult.content[0]?.text).toContain(tempDir);

      const outlineResult = (await runtime.execute({
        type: "execute",
        id: "outline",
        toolCallId: "outline-call",
        tool: "aft_outline",
        args: { target: "sample.ts" },
      })) as { content: Array<{ text?: string }> };
      expect(outlineResult.content[0]?.text).toContain("Account");
    } finally {
      await runtime.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
