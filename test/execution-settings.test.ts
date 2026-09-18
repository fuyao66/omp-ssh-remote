import { describe, expect, test } from "bun:test";
import {
  FORWARDED_SETTING_KEYS,
  captureExecutionSettings,
  isValidForwardedSetting,
  parseExecutionSettings,
} from "../src/omp/execution-settings.ts";
import { parseRequest } from "../src/protocol.ts";

describe("execution settings whitelist", () => {
  test("captures only configured, valid, whitelisted keys", () => {
    const configured = new Map<string, unknown>([
      ["tools.maxTimeout", 120],
      ["edit.fuzzyMatch", false],
      ["grep.contextAfter", -1], // invalid: below min
      ["bash.direnv", "sometimes"], // invalid enum
      ["edit.mode", "replace"], // never forwarded (schema-affecting)
      ["worktree.clone", true], // never forwarded (pinned off remotely)
    ]);
    const captured = captureExecutionSettings({
      get: (path) => configured.get(path),
      isConfigured: (path) => configured.has(path),
    });
    expect(captured).toEqual({ "tools.maxTimeout": 120, "edit.fuzzyMatch": false });
  });

  test("schema-affecting and approval keys are not in the whitelist", () => {
    for (const key of [
      "async.enabled",
      "memory.backend",
      "skillful",
      "eval.py",
      "eval.js",
      "edit.mode",
      "bash.patterns",
      "bash.allowCompoundCommands",
      "worktree.clone",
      "tools.xdev",
    ]) {
      expect(FORWARDED_SETTING_KEYS).not.toContain(key);
    }
  });

  test("interceptor rules are validated structurally", () => {
    expect(
      isValidForwardedSetting("bashInterceptor.patterns", [
        { pattern: "^cat ", tool: "read", message: "use read" },
        { pattern: "^grep ", flags: "i", tool: "grep", message: "use grep", allowSubcommands: ["-c"] },
      ]),
    ).toBe(true);
    expect(isValidForwardedSetting("bashInterceptor.patterns", [{ pattern: 1, tool: "read", message: "x" }])).toBe(false);
    expect(isValidForwardedSetting("bashInterceptor.patterns", "not-an-array")).toBe(false);
  });

  test("parse drops unknown keys and rejects malformed values", () => {
    expect(parseExecutionSettings(undefined)).toEqual({});
    expect(parseExecutionSettings({ "read.defaultLimit": 500, "edit.mode": "replace", bogus: 1 })).toEqual({
      "read.defaultLimit": 500,
    });
    expect(() => parseExecutionSettings({ "read.defaultLimit": "500" })).toThrow(/read\.defaultLimit/);
    expect(() => parseExecutionSettings([])).toThrow(/must be an object/);
  });
});

describe("protocol carries settings and tool names", () => {
  test("initialize accepts forwarded settings", () => {
    const message = parseRequest(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        host: "omp",
        hostVersion: "0.0.0",
        runtimeVersion: "0.6.0",
        cwd: "/tmp",
        tools: ["bash"],
        settings: { "tools.maxTimeout": 30, "edit.mode": "replace" },
      }),
    );
    expect(message).toMatchObject({ type: "initialize", settings: { "tools.maxTimeout": 30 } });
    expect((message as { settings?: Record<string, unknown> }).settings).not.toHaveProperty("edit.mode");
  });

  test("execute accepts toolNames and rejects non-string entries", () => {
    const ok = parseRequest(
      JSON.stringify({ type: "execute", id: "1", toolCallId: "c1", tool: "bash", args: {}, toolNames: ["read", "bash"] }),
    );
    expect(ok).toMatchObject({ type: "execute", toolNames: ["read", "bash"] });
    expect(() =>
      parseRequest(JSON.stringify({ type: "execute", id: "1", toolCallId: "c1", tool: "bash", args: {}, toolNames: [1] })),
    ).toThrow(/toolNames/);
  });
});
