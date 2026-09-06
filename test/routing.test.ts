import { describe, expect, test } from "bun:test";
import {
  pathShouldStayLocal,
  remoteControlPlaneBlockReason,
  remoteSessionNavigationBlockReason,
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

  test("routes hub process supervision remotely and control-plane ops locally", () => {
    for (const op of ["start", "ps", "logs", "stop", "restart", "describe"]) {
      expect(pathShouldStayLocal("hub", { op, name: "web" })).toBe(false);
    }
    // send/wait address a process only when `name` is given without a peer.
    expect(pathShouldStayLocal("hub", { op: "send", name: "web", text: "q" })).toBe(false);
    expect(pathShouldStayLocal("hub", { op: "wait", name: "web", for: "ready" })).toBe(false);
    expect(pathShouldStayLocal("hub", { op: "send", to: "Main", message: "hi" })).toBe(true);
    expect(pathShouldStayLocal("hub", { op: "send", name: "web", to: "Main", message: "hi" })).toBe(true);
    expect(pathShouldStayLocal("hub", { op: "wait" })).toBe(true);
    expect(pathShouldStayLocal("hub", { op: "wait", from: "Scout" })).toBe(true);
    for (const op of ["list", "inbox", "jobs", "cancel"]) {
      expect(pathShouldStayLocal("hub", { op })).toBe(true);
    }
    expect(pathShouldStayLocal("hub", {})).toBe(true);
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

  test("matches OMP 18.x task child session artifact layout", () => {
    // OMP task children write under sessionFile.slice(0, -6) + "/" + name + ".jsonl"
    expect(
      sessionBelongsToFamily(
        "/tmp/omp-ssh-remote-smoke/session.jsonl",
        "/tmp/omp-ssh-remote-smoke/session/Child.jsonl",
      ),
    ).toBe(true);
    expect(
      sessionBelongsToFamily(
        "/tmp/omp-ssh-remote-smoke/session.jsonl",
        "/tmp/omp-ssh-remote-smoke/session-other/Child.jsonl",
      ),
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
    // No AsyncJobManager singleton in the test process: fail closed with a
    // clear reason. When OMP installs its manager the block is lifted and the
    // wrapper bridges the job (covered by test/async-bash.test.ts).
    expect(
      remoteControlPlaneBlockReason("bash", {
        command: "sleep 1",
        async: true,
      }),
    ).toContain("background job manager");
    expect(
      remoteControlPlaneBlockReason("task", { task: "read", isolated: false }),
    ).toBeUndefined();
  });
  test("allows navigation only after a clean remote owner state", () => {
    expect(
      remoteSessionNavigationBlockReason({
        selected: false,
        owner: false,
        familyMemberCount: 0,
        remoteProposalCount: 0,
      }),
    ).toBeUndefined();
    expect(
      remoteSessionNavigationBlockReason({
        selected: true,
        owner: true,
        familyMemberCount: 1,
        remoteProposalCount: 0,
      }),
    ).toBeUndefined();
  });

  test("blocks navigation while remote state still needs explicit cleanup", () => {
    expect(
      remoteSessionNavigationBlockReason({
        selected: true,
        owner: true,
        familyMemberCount: 1,
        remoteProposalCount: 1,
      }),
    ).toContain("proposals");
    expect(
      remoteSessionNavigationBlockReason({
        selected: true,
        owner: true,
        familyMemberCount: 2,
        remoteProposalCount: 0,
      }),
    ).toContain("subagent");
  });
});

describe("remote workspace status", () => {
  test("reports local mode without a selected remote runtime", async () => {
    const { workspaceStatus } = await import("../src/extension.ts");
    expect(
      workspaceStatus({
        selected: false,
        clientPresent: false,
        clientClosed: false,
        owner: false,
        wrappedTools: [],
        proposalSources: [],
      }),
    ).toMatchObject({
      mode: "local",
      transport: "not-selected",
      remoteCwd: null,
      sessionRole: null,
      connectionError: null,
      remoteWorkspaceTools: [],
      pendingRemoteAstProposals: 0,
      routing: {
        ordinaryFilesystemPaths: "local native tools",
        asyncBash: "local OMP policy",
      },
    });
  });

  test("reports a connected remote session and its tool boundary", async () => {
    const { workspaceStatus } = await import("../src/extension.ts");
    expect(
      workspaceStatus({
        selected: true,
        clientPresent: true,
        clientClosed: false,
        remoteCwd: "/srv/project",
        owner: true,
        wrappedTools: ["bash", "read", "write"],
        proposalSources: ["remote", "local", "remote"],
      }),
    ).toMatchObject({
      mode: "remote",
      transport: "connected",
      remoteCwd: "/srv/project",
      sessionRole: "owner",
      connectionError: null,
      remoteWorkspaceTools: ["bash", "read", "write"],
      pendingRemoteAstProposals: 2,
      routing: {
        ordinaryFilesystemPaths: "remote native runtime",
        internalUris: "local control plane",
        controlPlane: "local control plane",
        asyncBash:
          "local OMP job owns lifecycle; remote companion runs the command in the foreground; cancel or disconnect aborts it",
        isolatedTasks: "rejected; remote isolated worktrees are not available",
      },
    });
  });

  test("reports a selected disconnected runtime as unavailable and fail-closed", async () => {
    const { workspaceStatus } = await import("../src/extension.ts");
    expect(
      workspaceStatus({
        selected: true,
        clientPresent: true,
        clientClosed: true,
        remoteCwd: "/srv/project",
        owner: false,
        wrappedTools: ["read"],
        proposalSources: [],
      }),
    ).toMatchObject({
      mode: "unavailable",
      transport: "unavailable",
      remoteCwd: "/srv/project",
      sessionRole: "subagent",
      connectionError: "Remote runtime transport is unavailable",
      routing: {
        ordinaryFilesystemPaths: "rejected (fail closed)",
      },
    });
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
