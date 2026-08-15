import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { describe, expect, test } from "bun:test";
import {
  injectWorkspaceState,
  pathShouldStayLocal,
  remoteControlPlaneBlockReason,
  remoteWorkspaceStateMessage,
  sessionBelongsToFamily,
  stagedProposal,
  taskRequestsIsolation,
  workspaceExecutionTarget,
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

describe("workspace state context", () => {
  test("describes the local, remote, and fail-closed state", () => {
    expect(remoteWorkspaceStateMessage("remote", "/srv/project")).toContain(
      'remote working directory: "/srv/project"',
    );
    expect(remoteWorkspaceStateMessage("local")).toContain('mode: "local"');
    expect(remoteWorkspaceStateMessage("unavailable")).toContain(
      'mode: "unavailable"',
    );
    expect(remoteWorkspaceStateMessage("remote")).toContain(
      "current known SSH transport state",
    );
    expect(remoteWorkspaceStateMessage("remote")).toContain(
      "native xd:// workspace devices",
    );
  });

  test("derives live state from the selection and transport", () => {
    const live = { isClosed: false };
    expect(workspaceExecutionTarget(false, undefined, live)).toBe("local");
    expect(workspaceExecutionTarget(true, undefined, live)).toBe("remote");
    expect(workspaceExecutionTarget(true, "connection failed", live)).toBe(
      "unavailable",
    );
    expect(workspaceExecutionTarget(true, undefined, { isClosed: true })).toBe(
      "unavailable",
    );
    expect(workspaceExecutionTarget(true)).toBe("unavailable");
  });

  test("replaces all persisted legacy state without mutating the transcript", () => {
    const legacy: AgentMessage = {
      role: "custom",
      customType: "omp-ssh-remote/workspace-state",
      content: "stale remote state",
      display: false,
      timestamp: 1,
    };
    const olderLegacy: AgentMessage = {
      ...legacy,
      content: "older local state",
      timestamp: 0,
    };
    const retained: AgentMessage = {
      role: "custom",
      customType: "another-extension/state",
      content: "retain this",
      display: false,
      timestamp: 2,
    };
    const messages = [olderLegacy, legacy, retained];
    const injected = injectWorkspaceState(messages, "unavailable");
    const states = injected.filter(
      (message) =>
        message.role === "custom" &&
        message.customType === "omp-ssh-remote/workspace-state",
    );
    const state = states[0];

    expect(messages).toEqual([olderLegacy, legacy, retained]);
    expect(injected).toHaveLength(2);
    expect(states).toHaveLength(1);
    expect(state?.role).toBe("custom");
    if (!state || state.role !== "custom")
      throw new Error("workspace state was not injected");
    expect(state.content).toContain('mode: "unavailable"');
    expect(injected[0]).toEqual(retained);
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
