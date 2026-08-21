import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiWorkerRuntime } from "../src/pi/worker-runtime.ts";
import {
  PI_CORE_COMPONENT_ID,
  PI_CORE_CONTRACT_VERSION,
  PI_REMOTE_RUNTIME_VERSION,
} from "../src/pi/assembly.ts";
import {
  AFT_PLUGIN_CONTRACT_VERSION,
  AFT_PLUGIN_ID,
} from "../src/pi/plugins/aft.ts";
import {
  PROTOCOL_VERSION,
  decodeFrames,
  parseMessage,
  type RuntimeAssemblyRequest,
} from "../src/protocol.ts";

const coreComponent = {
  id: PI_CORE_COMPONENT_ID,
  kind: "host" as const,
  contractVersion: PI_CORE_CONTRACT_VERSION,
  version: "local-test-version",
};

function request(
  id: string,
  plugins: RuntimeAssemblyRequest["components"],
  tools: RuntimeAssemblyRequest["tools"],
): RuntimeAssemblyRequest {
  return { id, components: [coreComponent, ...plugins], tools };
}

describe("composable Pi worker runtime", () => {
  test("runs the base Pi runtime without loading a plugin", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-core-runtime-"));
    const runtime = await createPiWorkerRuntime(
      tempDir,
      request(
        "core-test",
        [],
        [
          { name: "read", owner: PI_CORE_COMPONENT_ID },
          { name: "write", owner: PI_CORE_COMPONENT_ID },
          { name: "bash", owner: PI_CORE_COMPONENT_ID },
        ],
      ),
    );
    try {
      expect(runtime.manifest.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(runtime.manifest.host).toBe("pi");
      expect(runtime.manifest.hostVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(runtime.manifest.toolRuntimeVersion).toBe(
        PI_REMOTE_RUNTIME_VERSION,
      );
      expect(runtime.manifest.tools.map((tool) => tool.name)).toEqual([
        "read",
        "write",
        "bash",
      ]);
      const remoteAssembly = runtime.manifest.capabilities?.assembly as any;
      expect(remoteAssembly.components).toHaveLength(1);
      expect(remoteAssembly.id).not.toBe("core-test");

      await runtime.execute({
        type: "execute",
        id: "write",
        toolCallId: "write-call",
        tool: "write",
        args: { path: "base.txt", content: "base Pi\n" },
      });
      expect(await readFile(join(tempDir, "base.txt"), "utf8")).toBe(
        "base Pi\n",
      );
      const bashResult = (await runtime.execute({
        type: "execute",
        id: "bash",
        toolCallId: "bash-call",
        tool: "bash",
        args: { command: "pwd" },
      })) as { content: Array<{ text?: string }> };
      expect(bashResult.content[0]?.text).toContain(tempDir);
    } finally {
      await runtime.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("loads AFT only when its plugin component is selected", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-aft-runtime-"));
    await writeFile(
      join(tempDir, "sample.ts"),
      "export interface Account { id: string; active: boolean }\n",
    );
    const runtime = await createPiWorkerRuntime(
      tempDir,
      request(
        "aft-test",
        [
          {
            id: AFT_PLUGIN_ID,
            kind: "plugin",
            contractVersion: AFT_PLUGIN_CONTRACT_VERSION,
            version: "different-local-version-is-allowed",
          },
        ],
        [
          { name: "find", owner: PI_CORE_COMPONENT_ID },
          { name: "bash", owner: AFT_PLUGIN_ID },
          { name: "aft_outline", owner: AFT_PLUGIN_ID },
        ],
      ),
    );
    try {
      const manifests = new Map(
        runtime.manifest.tools.map((tool) => [tool.name, tool]),
      );
      for (const name of ["find", "bash", "aft_outline"]) {
        expect(manifests.get(name)?.parameters).toBeDefined();
      }
      const remoteAssembly = runtime.manifest.capabilities?.assembly as any;
      expect(remoteAssembly.components.map((item: any) => item.id)).toEqual([
        PI_CORE_COMPONENT_ID,
        AFT_PLUGIN_ID,
      ]);
      expect(remoteAssembly.components[1].version).toMatch(/^\d+\.\d+\.\d+/);

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

  test("rejects unsupported plugin contracts before initialization", async () => {
    await expect(
      createPiWorkerRuntime(
        process.cwd(),
        request(
          "unknown-plugin",
          [
            {
              id: "example/unknown",
              kind: "plugin",
              contractVersion: "1",
              version: "1.0.0",
            },
          ],
          [],
        ),
      ),
    ).rejects.toThrow("Unsupported Pi plugin contract");
  });
});

describe("Pi worker process lifecycle", () => {
  test("rejects repeated initialization without replacing the active runtime", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-worker-process-"));
    const worker = Bun.spawn(
      ["bun", join(import.meta.dir, "../src/pi-worker.ts")],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const frames = decodeFrames(worker.stdout)[Symbol.asyncIterator]();
    const assembly = request(
      "process-test",
      [],
      [{ name: "read", owner: PI_CORE_COMPONENT_ID }],
    );
    const initialize = {
      type: "initialize",
      protocolVersion: PROTOCOL_VERSION,
      host: "pi",
      hostVersion: "local-test-version",
      runtimeVersion: PI_REMOTE_RUNTIME_VERSION,
      cwd: tempDir,
      tools: ["read"],
      assembly,
    };
    try {
      worker.stdin.write(`${JSON.stringify(initialize)}\n`);
      const first = await frames.next();
      expect(first.done).toBe(false);
      expect(parseMessage(first.value!).type).toBe("ready");

      worker.stdin.write(`${JSON.stringify(initialize)}\n`);
      const second = await frames.next();
      expect(second.done).toBe(false);
      const error = parseMessage(second.value!);
      expect(error.type).toBe("error");
      if (error.type === "error") {
        expect(error.error.message).toContain("already initialized");
      }
    } finally {
      worker.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      worker.stdin.end();
      await worker.exited;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
