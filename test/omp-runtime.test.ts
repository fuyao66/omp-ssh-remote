import { describe, expect, test } from "bun:test";
import {
  createOmpRuntimeHandshake,
  validateOmpReadyMessage,
} from "../src/omp/runtime-contract.ts";
import {
  PROTOCOL_VERSION,
  REMOTE_TOOL_NAMES,
  TOOL_RUNTIME_VERSION,
  type ReadyMessage,
} from "../src/protocol.ts";

const objectSchema = { type: "object" } as const;

function toolsWith(
  parameters: unknown = objectSchema,
): ReadyMessage["tools"] {
  return REMOTE_TOOL_NAMES.map((name) => ({
    name,
    description: name,
    parameters,
  }));
}

function ready(overrides: Partial<ReadyMessage> = {}): ReadyMessage {
  return {
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    host: "omp",
    ompVersion: "18.0.4",
    hostVersion: "18.0.4",
    runtimeVersion: TOOL_RUNTIME_VERSION,
    cwd: "/remote/workspace",
    tools: toolsWith(),
    ...overrides,
  };
}

describe("OMP capability admission", () => {
  test("accepts a different host version when tools and schemas match", () => {
    expect(() =>
      validateOmpReadyMessage(ready({ hostVersion: "18.1.0", ompVersion: "18.1.0" }), toolsWith()),
    ).not.toThrow();
  });

  test("rejects a missing remote tool", () => {
    expect(() =>
      validateOmpReadyMessage(
        ready({
          tools: toolsWith().filter((tool) => tool.name !== "debug"),
        }),
        toolsWith(),
      ),
    ).toThrow(/missing tools: debug/);
  });

  test("rejects incompatible local/remote schemas", () => {
    expect(() =>
      validateOmpReadyMessage(
        ready({
          tools: toolsWith({
            type: "object",
            properties: { path: { type: "string" } },
          }),
        }),
        toolsWith(),
      ),
    ).toThrow(/schema is incompatible/);
  });

  test("rejects a non-omp ready host", () => {
    expect(() =>
      validateOmpReadyMessage(ready({ host: "pi" }), toolsWith()),
    ).toThrow(/host mismatch/);
  });

  test("handshake validateReady uses the captured local tool schemas", () => {
    const handshake = createOmpRuntimeHandshake({
      hostVersion: "18.0.4",
      localTools: toolsWith(),
    });
    expect(handshake.host).toBe("omp");
    expect(handshake.hostVersion).toBe("18.0.4");
    expect([...handshake.requestedTools]).toEqual([...REMOTE_TOOL_NAMES]);
    expect(() => handshake.validateReady(ready())).not.toThrow();
    expect(() =>
      handshake.validateReady(
        ready({
          tools: toolsWith({ type: "object", required: ["path"] }),
        }),
      ),
    ).toThrow(/schema is incompatible/);
  });
});
