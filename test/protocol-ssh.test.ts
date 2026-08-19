import { describe, expect, test } from "bun:test";
import {
  AFT_REMOTE_TOOLS,
  MAX_FRAME_BYTES,
  PI_NATIVE_TOOLS,
  PI_TOOL_RUNTIME_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  decodeFrames,
  parseMessage,
  parseRequest,
  type ReadyMessage,
} from "../src/protocol.ts";
import { validatePiReadyMessage } from "../src/client.ts";
import {
  buildScpBaseCommand,
  buildSshWorkerCommand,
  quoteRemoteArgument,
} from "../src/ssh.ts";

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

describe("protocol boundaries", () => {
  test("decodes frames across arbitrary chunks", async () => {
    const frames: string[] = [];
    for await (const frame of decodeFrames(
      chunks('{"type":"shutdown"', "}\n", '{"type":"cancel","id":"1"}\n'),
    )) {
      frames.push(frame);
    }
    expect(frames.map(parseRequest)).toEqual([
      { type: "shutdown" },
      { type: "cancel", id: "1" },
    ]);
  });

  test("rejects oversized unterminated frames", async () => {
    const consume = async () => {
      for await (const _frame of decodeFrames(
        chunks("x".repeat(MAX_FRAME_BYTES + 1)),
      )) {
        // No complete frame is expected.
      }
    };
    await expect(consume()).rejects.toThrow("exceeds");
  });

  test("rejects malformed request and response shapes", () => {
    expect(() => parseRequest('{"type":"execute","id":1}')).toThrow();
    expect(() => parseMessage('{"type":"result","id":"1"}')).toThrow(
      "missing result",
    );
  });
});

describe("Pi runtime manifest boundary", () => {
  const validReady = (): ReadyMessage => ({
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    host: "pi",
    hostVersion: PI_VERSION,
    toolRuntimeVersion: PI_TOOL_RUNTIME_VERSION,
    tools: [...new Set([...PI_NATIVE_TOOLS, ...AFT_REMOTE_TOOLS])].map(
      (name) => ({
        name,
        description: `${name} parameters`,
        parameters: { type: "object", properties: {} },
      }),
    ),
    capabilities: { aftHostRuntime: "@cortexkit/aft-pi@0.51.2" },
  });

  test("accepts only the complete version-locked Pi and AFT surface", () => {
    expect(() => validatePiReadyMessage(validReady())).not.toThrow();
  });

  test("rejects missing, unknown, duplicate, and invalid-schema tools", () => {
    const missing = validReady();
    missing.tools = missing.tools.filter((tool) => tool.name !== "aft_outline");
    expect(() => validatePiReadyMessage(missing)).toThrow("missing tools");

    const unknown = validReady();
    unknown.tools.push({
      name: "remote_shell_root",
      description: "unexpected",
      parameters: { type: "object" },
    });
    expect(() => validatePiReadyMessage(unknown)).toThrow("unsupported tool");

    const duplicate = validReady();
    duplicate.tools.push(duplicate.tools[0]!);
    expect(() => validatePiReadyMessage(duplicate)).toThrow("duplicate tool");

    const invalidSchema = validReady();
    invalidSchema.tools[0] = { ...invalidSchema.tools[0]!, parameters: {} };
    expect(() => validatePiReadyMessage(invalidSchema)).toThrow(
      "invalid parameter schema",
    );
  });
});

describe("SSH command safety", () => {
  test("quotes remote worker paths as one shell argument", () => {
    expect(quoteRemoteArgument("/tmp/worker path'quoted")).toBe(
      "'/tmp/worker path'\"'\"'quoted'",
    );
    expect(
      buildSshWorkerCommand({
        target: "user@example.com",
        workerPath: "/tmp/worker path'quoted",
      }).at(-1),
    ).toBe("exec '/tmp/worker path'\"'\"'quoted'");
  });

  test("forces strict non-forwarding SSH options", () => {
    const ssh = buildSshWorkerCommand({
      target: "user@example.com",
      workerPath: "/srv/worker",
    });
    const scp = buildScpBaseCommand({ target: "user@example.com" });
    for (const command of [ssh, scp]) {
      expect(command).toContain("StrictHostKeyChecking=yes");
      expect(command).toContain("BatchMode=yes");
      expect(command).toContain("IdentitiesOnly=yes");
      expect(command).toContain("ForwardAgent=no");
      expect(command).toContain("ClearAllForwardings=yes");
    }
  });

  test("rejects unsafe targets and multiline remote arguments", () => {
    expect(() =>
      buildSshWorkerCommand({
        target: "host;touch /tmp/pwn",
        workerPath: "/tmp/worker",
      }),
    ).toThrow("Unsafe SSH target");
    expect(() => quoteRemoteArgument("/tmp/worker\ncommand")).toThrow(
      "cannot contain",
    );
  });
});
