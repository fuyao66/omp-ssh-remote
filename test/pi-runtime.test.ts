import { describe, expect, test } from "bun:test";
import { createPiNativeWorkerRuntime } from "../src/pi-runtime.ts";
import { PROTOCOL_VERSION, PI_VERSION, PI_TOOL_RUNTIME_VERSION } from "../src/protocol.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Pi Native Worker Runtime", () => {
  test("creates manifest with Pi 7 tools and correct versions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-runtime-test-"));
    try {
      const runtime = createPiNativeWorkerRuntime(tempDir);
      expect(runtime.manifest.type).toBe("ready");
      expect(runtime.manifest.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(runtime.manifest.host).toBe("pi");
      expect(runtime.manifest.hostVersion).toBe(PI_VERSION);
      expect(runtime.manifest.toolRuntimeVersion).toBe(PI_TOOL_RUNTIME_VERSION);

      const toolNames = runtime.manifest.tools.map((t) => t.name);
      expect(toolNames).toContain("read");
      expect(toolNames).toContain("write");
      expect(toolNames).toContain("edit");
      expect(toolNames).toContain("bash");
      expect(toolNames).toContain("grep");
      expect(toolNames).toContain("find");
      expect(toolNames).toContain("ls");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("executes write and read tools correctly in worker runtime", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-runtime-exec-"));
    try {
      const runtime = createPiNativeWorkerRuntime(tempDir);

      // Write a file
      const writeResult = (await runtime.execute({
        type: "execute",
        id: "call-1",
        toolCallId: "tc-1",
        tool: "write",
        args: {
          path: "hello.txt",
          content: "Hello Pi Remote Worker!",
        },
      })) as { content: Array<{ type: string; text?: string }> };

      expect(writeResult).toBeDefined();

      // Read the file
      const readResult = (await runtime.execute({
        type: "execute",
        id: "call-2",
        toolCallId: "tc-2",
        tool: "read",
        args: {
          path: "hello.txt",
        },
      })) as { content: Array<{ type: string; text?: string }> };

      expect(readResult).toBeDefined();
      const text = readResult.content?.[0]?.text;
      expect(text).toContain("Hello Pi Remote Worker!");

      // Execute bash tool
      const bashResult = (await runtime.execute({
        type: "execute",
        id: "call-3",
        toolCallId: "tc-3",
        tool: "bash",
        args: {
          command: "pwd && cat hello.txt",
        },
      })) as { content: Array<{ type: string; text?: string }> };

      expect(bashResult).toBeDefined();
      const bashText = bashResult.content?.[0]?.text;
      expect(bashText).toContain(tempDir);
      expect(bashText).toContain("Hello Pi Remote Worker!");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
