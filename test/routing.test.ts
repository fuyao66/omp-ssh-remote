import { describe, expect, test } from "bun:test";
import {
  pathShouldStayLocal,
  remoteControlPlaneBlockReason,
  sessionBelongsToFamily,
  stagedProposal,
  taskRequestsIsolation,
} from "../src/extension.ts";

describe("workspace path routing", () => {
  test("keeps internal URI reads local", () => {
    expect(
      pathShouldStayLocal("read", { path: "skill://planning-with-files" }),
    ).toBe(true);
    expect(pathShouldStayLocal("read", { path: "/etc/nginx/nginx.conf" })).toBe(
      false,
    );
  });

  test("keeps every URI scheme local", () => {
    for (const scheme of [
      "omp",
      "vault",
      "rule",
      "security",
      "mcp",
      "ssh",
      "unknown",
    ]) {
      expect(
        pathShouldStayLocal("read", { path: `${scheme}://resource` }),
      ).toBe(true);
    }
  });

  test("routes LSP files and AST paths by path domain", () => {
    expect(
      pathShouldStayLocal("lsp", {
        action: "hover",
        file: "/root/project/a.ts",
      }),
    ).toBe(false);
    expect(
      pathShouldStayLocal("lsp", {
        action: "hover",
        file: "mcp://server/a.ts",
      }),
    ).toBe(true);
    expect(
      pathShouldStayLocal("ast_edit", { paths: ["/root/project/a.ts"] }),
    ).toBe(false);
    expect(() =>
      pathShouldStayLocal("ast_edit", {
        paths: ["vault://secret", "/root/project/a.ts"],
      }),
    ).toThrow("cannot mix local internal URIs with remote filesystem paths");
  });

  test("routes eval and debug into the remote execution domain", () => {
    expect(
      pathShouldStayLocal("eval", { language: "py", code: "print(1)" }),
    ).toBe(false);
    expect(
      pathShouldStayLocal("debug", {
        action: "launch",
        program: "/root/project/app",
      }),
    ).toBe(false);
    expect(
      pathShouldStayLocal("debug", {
        action: "launch",
        program: "local://app",
      }),
    ).toBe(true);
    expect(() =>
      pathShouldStayLocal("debug", {
        action: "set_breakpoint",
        program: "/root/project/app",
        file: "local://source.ts",
      }),
    ).toThrow("cannot mix local internal URIs with remote filesystem paths");
  });

  test("routes hashline filesystem edits remotely", () => {
    expect(
      pathShouldStayLocal("edit", {
        input: "[/root/project/a.ts#AB12]\nPUT 1.=1:\n+x",
      }),
    ).toBe(false);
  });

  test("keeps internal URI edits local and rejects mixed domains", () => {
    expect(
      pathShouldStayLocal("edit", {
        input: "[local://plan.md#AB12]\nPUT 1.=1:\n+x",
      }),
    ).toBe(true);
    expect(() =>
      pathShouldStayLocal("edit", {
        input:
          "[local://plan.md#AB12]\nPUT 1.=1:\n+x\n[/root/project/a.ts#CD34]\nPUT 1.=1:\n+y",
      }),
    ).toThrow("cannot mix local internal URIs with remote filesystem paths");
  });
});

describe("remote session boundaries", () => {
  test("inherits only true descendants of the owner session artifact tree", () => {
    expect(
      sessionBelongsToFamily(
        "/sessions/main.jsonl",
        "/sessions/main/Child.jsonl",
      ),
    ).toBe(true);
    expect(
      sessionBelongsToFamily(
        "/sessions/main.jsonl",
        "/sessions/main/nested/Child.jsonl",
      ),
    ).toBe(true);
    expect(
      sessionBelongsToFamily(
        "/sessions/main.jsonl",
        "/sessions/main-other/Child.jsonl",
      ),
    ).toBe(false);
    expect(
      sessionBelongsToFamily("/sessions/main.jsonl", "/sessions/main.jsonl"),
    ).toBe(false);
  });

  test("detects flat and batch isolated task requests", () => {
    expect(taskRequestsIsolation({ task: "read", isolated: true })).toBe(true);
    expect(
      taskRequestsIsolation({
        tasks: [{ task: "read" }, { task: "edit", isolated: true }],
      }),
    ).toBe(true);
    expect(taskRequestsIsolation({ task: "read", isolated: false })).toBe(
      false,
    );
  });

  test("blocks unsupported remote control-plane operations", () => {
    expect(
      remoteControlPlaneBlockReason("task", { task: "edit", isolated: true }),
    ).toContain("isolated worktrees");
    expect(
      remoteControlPlaneBlockReason("bash", {
        command: "sleep 1",
        async: true,
      }),
    ).toContain("local hub");
    expect(
      remoteControlPlaneBlockReason("task", { task: "read", isolated: false }),
    ).toBeUndefined();
  });
});


describe("AST proposal tracking", () => {
  test("recognizes top-level and xdev-wrapped native AST previews", () => {
    expect(
      stagedProposal({
        content: [],
        details: { applied: false, totalReplacements: 1 },
      }),
    ).toBe(true);
    expect(
      stagedProposal({
        content: [],
        details: {
          xdev: {
            tool: "ast_edit",
            inner: { applied: false, totalReplacements: 2 },
          },
        },
      }),
    ).toBe(true);
    expect(
      stagedProposal({
        content: [],
        details: { applied: true, totalReplacements: 1 },
      }),
    ).toBe(false);
  });
});
