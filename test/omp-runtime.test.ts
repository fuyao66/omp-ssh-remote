import { describe, expect, test } from "bun:test";
import {
  captureOmpToolSnapshot,
  createOmpRuntimeHandshake,
  describeSchemaDrift,
  validateOmpReadyMessage,
  versionDriftHint,
} from "../src/omp/runtime-contract.ts";
import { ompHostCompatibility } from "../src/omp/host-identity.ts";
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
      validateOmpReadyMessage(ready({ host: "other" as "omp" }), toolsWith()),
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

  test("negotiates the effective edit mode independently of matching schemas", () => {
    for (const editMode of ["replace", "hashline"] as const) {
      const handshake = createOmpRuntimeHandshake({ hostVersion: "18.12.6", localTools: toolsWith(), editMode });
      expect(handshake.editMode).toBe(editMode);
      expect(() => handshake.validateReady(ready({ editMode }))).not.toThrow();
      expect(() => handshake.validateReady(ready({ editMode: editMode === "replace" ? "hashline" : "replace" }))).toThrow(/edit mode is incompatible/);
      expect(() => handshake.validateReady(ready())).toThrow(/companion=unreported/);
    }
  });

  test("rejects a changed edit grammar or wire name even when the JSON schema is identical", () => {
    const local = toolsWith();
    const edit = local.find(tool => tool.name === "edit")!;
    edit.customFormat = { syntax: "lark", definition: "start: HASHLINE" };
    edit.customWireName = "edit";
    const handshake = createOmpRuntimeHandshake({ hostVersion: "18.12.6", localTools: local, editMode: "hashline" });
    expect(() => handshake.validateReady(ready({ tools: local, editMode: "hashline" }))).not.toThrow();
    for (const customFormat of [
      undefined,
      { syntax: "lark" as const, definition: "start: APPLY_PATCH" },
      { syntax: "regex" as const, definition: "start: HASHLINE" },
    ]) {
      const tools = local.map(tool => tool.name === "edit" ? { ...tool, customFormat } : tool);
      expect(() => handshake.validateReady(ready({ tools, editMode: "hashline" }))).toThrow(/edit language is incompatible/);
    }
    const renamed = local.map(tool => tool.name === "edit" ? { ...tool, customWireName: "apply_patch" } : tool);
    expect(() => handshake.validateReady(ready({ tools: renamed, editMode: "hashline" }))).toThrow(/edit language is incompatible/);
    expect(() => handshake.validateReady(ready({ tools: renamed, editMode: "hashline" }))).toThrow('host grammar=present, companion grammar=present, host wire="edit", companion wire="apply_patch"');
    expect(() => handshake.validateReady(ready({ tools: renamed, editMode: "hashline" }))).toThrow("inspect live host tool metadata and edit settings");
  });

  test("captures live schema and language getters without keeping mutable grammar metadata", () => {
    const format = { syntax: "lark" as const, definition: "start: original" };
    const snapshot = captureOmpToolSnapshot({
      name: "edit", parameters: { toJsonSchema: () => ({ type: "object", properties: { input: { type: "string" } } }) },
      customFormat: format, customWireName: "edit",
    });
    format.definition = "start: changed";
    expect(snapshot.parameters).toEqual({ type: "object", properties: { input: { type: "string" } } });
    expect(snapshot.customFormat).toEqual({ syntax: "lark", definition: "start: original" });
    expect(snapshot.customWireName).toBe("edit");
  });
});

describe("OMP version-drift diagnostics", () => {
  test("names the drifted parameter and both host versions on schema rejection", () => {
    const local = toolsWith({ type: "object", properties: { path: { type: "string" }, lang: { type: "string" } } });
    const remote = toolsWith({ type: "object", properties: { path: { type: "string" } } });
    expect(() =>
      validateOmpReadyMessage(ready({ tools: remote, hostVersion: "18.1.19", ompVersion: "18.1.19" }), local, "18.2.3"),
    ).toThrow(/read schema is incompatible.*host has parameter\(s\) the companion lacks: lang.*local OMP 18\.2\.3, companion built for 18\.1\.19.*bun run build:worker:all/);
  });

  test("distinguishes a changed definition from added/removed parameters", () => {
    expect(
      describeSchemaDrift(
        { type: "object", properties: { path: { type: "string", description: "new" } } },
        { type: "object", properties: { path: { type: "string", description: "old" } } },
      ),
    ).toBe("parameter definition changed: path");
    expect(
      describeSchemaDrift(
        { type: "object", properties: { path: {} } },
        { type: "object", properties: { path: {}, timeoutMs: {} } },
      ),
    ).toBe("companion has parameter(s) the host lacks: timeoutMs");
    expect(describeSchemaDrift({ type: "object" }, { type: "object" })).toBeUndefined();
  });

  test("runtime contract mismatch carries the rebuild hint", () => {
    expect(() =>
      validateOmpReadyMessage(ready({ runtimeVersion: "0.0.1" }), toolsWith(), "18.2.3"),
    ).toThrow(/runtime=0\.0\.1 \(expected .*\); local OMP 18\.2\.3, companion built for 18\.0\.4/);
  });

  test("hint recommends a dependency bump only when versions differ", () => {
    expect(versionDriftHint("18.2.3", "18.2.3")).not.toContain("pinned OMP dependencies");
    expect(versionDriftHint("18.2.3", "18.1.19")).toContain("update the plugin's pinned OMP dependencies to 18.2.3");
    expect(versionDriftHint(undefined, undefined)).toContain("local OMP unknown, companion built for unknown");
  });

  test("host compatibility check flags a stale plugin build at load time", () => {
    expect(ompHostCompatibility("18.2.3", "18.2.3")).toMatchObject({ compatible: true, advice: undefined });
    const stale = ompHostCompatibility("18.2.3", "18.1.19");
    expect(stale.compatible).toBe(false);
    expect(stale.advice).toMatch(/built for OMP 18\.1\.19 but the running host is 18\.2\.3.*build:worker:all/);
    expect(ompHostCompatibility(undefined, "18.2.3").advice).toMatch(/Could not determine the running OMP version/);
    expect(ompHostCompatibility("18.2.3", undefined).advice).toMatch(/not built with a pinned OMP version/);
  });
});
