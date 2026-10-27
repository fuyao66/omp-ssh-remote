import { describe, expect, spyOn, test } from "bun:test";
import { approvalFolderCandidate, recordApprovalGrant, requestApproval, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { ApprovalCache, ApprovalGrants, SessionApprovals, approvalGrantKey } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { remoteWrapperApproval, type ApprovalTargetState } from "../src/omp/approval-targets.ts";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("workspace approval targets", () => {
  test("keeps native local targets but never derives remote targets against local files", () => {
    const state: ApprovalTargetState = { selected: false, binding: "local", proposalSources: [] };
    const targets = ["/local/file"];
    let calls = 0;
    const metadata = remoteWrapperApproval("read", "read", () => { calls++; return targets; }, () => state);
    expect(metadata.approvalCacheTargets({ path: "file" })).toBe(targets);
    state.selected = true;
    state.binding = "remote";
    state.remoteCwd = "/remote";
    expect(metadata.approvalCacheTargets({ path: "artifact://local" })).toBe(targets);
    expect(metadata.approvalCacheTargets({ path: "ssh://other/private" })).toBe(targets);
    expect(metadata.approvalCacheTargets({ path: "file" })).toHaveLength(1);
    expect(metadata.approvalCacheTargets({ path: "file" })).not.toEqual(targets);
    expect(calls).toBe(3);
    // No client is present: selected-but-unavailable must still be remote-scoped.
    expect(metadata.approvalCacheTargets({ path: "/local/file" })).not.toEqual(targets);
  });

  test("isolates binding, host/user, port, identity, cwd and tool while keeping stable exact requests", () => {
    const state: ApprovalTargetState = {
      selected: true, binding: "binding-a", remoteCwd: "/remote", proposalSources: [],
      family: { connection: { target: "alice@host-a", displayTarget: "alias", port: 22, identityFile: "/keys/a" } },
    };
    const metadata = remoteWrapperApproval("read", "read", undefined, () => state);
    const first = metadata.approvalCacheTargets({ path: "notes:1", i: "first", options: { b: 2, a: 1 } });
    expect(metadata.approvalCacheTargets({ options: { a: 1, b: 2 }, i: "new intent", path: "notes:1" })).toEqual(first);
    expect(metadata.approvalCacheTargets({ path: "notes", options: { a: 1, b: 2 } })).not.toEqual(first);
    expect(metadata.approvalCacheTargets({ path: "notes:1", options: { a: 1, b: 2, i: "nested data" } })).not.toEqual(first);
    const variants: ApprovalTargetState[] = [
      { ...state, binding: "binding-b" },
      { ...state, remoteCwd: "/elsewhere" },
      ...[
        { target: "alice@host-b" }, { target: "bob@host-a" }, { port: 2222 }, { identityFile: "/keys/b" },
      ].map(change => ({ ...state, family: { connection: { ...state.family!.connection, ...change } } })),
    ];
    for (const variant of variants) {
      expect(remoteWrapperApproval("read", "read", undefined, () => variant)
        .approvalCacheTargets({ path: "notes:1", options: { a: 1, b: 2 } })).not.toEqual(first);
    }
    expect(remoteWrapperApproval("write", "write", undefined, () => state)
      .approvalCacheTargets({ path: "notes:1", options: { a: 1, b: 2 } })).not.toEqual(first);
    expect(approvalFolderCandidate({ name: "read", ...metadata }, { path: "notes:1" })).toBeUndefined();
  });

  test("remote grant keys do not retain file contents or grow with payload size", () => {
    const state: ApprovalTargetState = { selected: true, binding: "remote", proposalSources: [] };
    const metadata = remoteWrapperApproval("write", "write", undefined, () => state);
    const secret = "private-file-content-".repeat(10_000);
    const key = metadata.approvalCacheTargets({ path: "file", content: secret })?.[0];
    expect(key).toBeDefined();
    expect(key!.length).toBeLessThan(100);
    expect(key).not.toContain("private-file-content");
  });

  test("selector-bearing local processes never mint a grant for a later remote name", () => {
    const state: ApprovalTargetState = { selected: true, binding: "unchanged", proposalSources: [] };
    let live = true;
    const registry = spyOn(AgentRegistry, "global").mockReturnValue({ list: () => live ? [{ id: "bg_1" }] : [] } as never);
    try {
      const native = ["local-process:agent/bg_1"];
      const metadata = remoteWrapperApproval("read", "read", () => native, () => state);
      const args = { path: "proc://bg_1:1-5" };
      expect(metadata.approvalCacheTargets(args)).toBe(native);
      live = false;
      expect(() => metadata.approvalCacheTargets(args)).toThrow("binding changed");
      expect(metadata.approvalCacheTargets({ ...args })).not.toEqual(native);
    } finally { registry.mockRestore(); }
  });

  test("scopes forwarded xdev requests and remote proposal resolutions without mixing domains", () => {
    const state: ApprovalTargetState = { selected: true, binding: "remote", proposalSources: ["remote"] };
    const native = ["xd://native"];
    const metadata = remoteWrapperApproval("write", "write", () => native, () => state);
    expect(metadata.approvalCacheTargets({ path: "xd://ast_edit", content: JSON.stringify({ paths: ["/remote/file"] }) })).not.toBe(native);
    expect(metadata.approvalCacheTargets({ path: "xd://ast_edit", content: JSON.stringify({ paths: ["artifact://local"] }) })).toBe(native);
    expect(metadata.approvalCacheTargets({ path: "xd://resolve", content: "yes" })).not.toBe(native);
    state.proposalSources = ["local"];
    expect(metadata.approvalCacheTargets({ path: "xd://resolve", content: "yes" })).toBe(native);
    const search = remoteWrapperApproval("grep", "read", undefined, () => state);
    expect(() => search.approvalCacheTargets({ path: "/remote;artifact://local" })).toThrow("cannot mix");
  });

  test("native cached mode accepts exact remote grants but not local or other-binding grants", async () => {
    const state: ApprovalTargetState = { selected: true, binding: "host-a", remoteCwd: "/remote", proposalSources: [] };
    const metadata = remoteWrapperApproval("read", "read", () => ["/remote/file"], () => state);
    const tool = { name: "read", ...metadata };
    const args = { path: "/remote/file" };
    const session = new SessionApprovals();
    const grants = new ApprovalGrants(session, new ApprovalCache(`/tmp/unused-approval-cache-${crypto.randomUUID()}`));
    session.record(approvalGrantKey("read", "/remote/file"));
    expect(resolveApproval(tool, args, "always-ask-cached", {}, grants).policy).toBe("prompt");
    const answer = await requestApproval({
      async select() { throw new Error("native approval dialog should be used"); },
      async approve(prompt) {
        expect(prompt.grants?.map(grant => grant.scope)).toEqual(["target"]);
        return { grant: "target", always: false };
      },
    }, tool, args, { grants: true });
    expect(answer).toEqual({ grant: "target", always: false });
    if (typeof answer !== "object") throw new Error("Expected a target grant");
    recordApprovalGrant(tool, args, grants, "read", answer);
    expect(resolveApproval(tool, { ...args }, "always-ask-cached", {}, grants).policy).toBe("allow");
    expect(resolveApproval(tool, { path: "/remote/file:1" }, "always-ask-cached", {}, grants).policy).toBe("prompt");
    state.binding = "host-b";
    expect(resolveApproval(tool, { ...args }, "always-ask-cached", {}, grants).policy).toBe("prompt");
    expect(() => recordApprovalGrant(tool, args, grants, "read", answer)).toThrow("binding changed");
    expect(resolveApproval(tool, { ...args }, "always-ask-cached", {}, grants).policy).toBe("prompt");
  });

  test("a workspace switch during native approve cannot record or execute the old request", async () => {
    const state: ApprovalTargetState = { selected: true, binding: "host-a", proposalSources: [] };
    const metadata = remoteWrapperApproval("read", "read", undefined, () => state);
    const tool = { name: "read", ...metadata };
    const args = { path: "file" };
    const grants = new ApprovalGrants(new SessionApprovals(), new ApprovalCache(`/tmp/unused-approval-cache-${crypto.randomUUID()}`));
    resolveApproval(tool, args, "always-ask-cached", {}, grants);
    const entered = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<{ grant: "target"; always: boolean }>();
    const pending = requestApproval({
      async select() { throw new Error("unexpected select"); },
      async approve() { entered.resolve(); return decision.promise; },
    }, tool, args, { grants: true });
    await entered.promise;
    state.binding = "host-b";
    decision.resolve({ grant: "target", always: true });
    const answer = await pending;
    if (typeof answer !== "object") throw new Error("Expected a grant answer");
    expect(() => recordApprovalGrant(tool, args, grants, "read", answer)).toThrow("binding changed");
    expect(() => metadata.assertBinding(args)).toThrow("binding changed");
    expect(resolveApproval(tool, { ...args }, "always-ask-cached", {}, grants).policy).toBe("prompt");
  });

  test("pins all approval modes before awaiting UI and rejects stale record or execution", () => {
    for (const selected of [false, true]) {
      const state: ApprovalTargetState = { selected, binding: "before", proposalSources: [] };
      const metadata = remoteWrapperApproval("read", "read", () => ["/native"], () => state);
      const tool = { name: "read", ...metadata };
      for (const mode of ["always-ask", "always-ask-cached", "write", "yolo"] as const) {
        state.binding = "before";
        state.selected = selected;
        const args = { path: "file" };
        resolveApproval(tool, args, mode);
        state.selected = true;
        state.binding = "after";
        expect(() => metadata.approvalCacheTargets(args)).toThrow("binding changed");
        expect(() => metadata.assertBinding(args)).toThrow("binding changed");
        expect(() => resolveApproval(tool, args, mode)).toThrow("binding changed");
        expect(() => metadata.assertBinding({ ...args })).not.toThrow();
      }
    }
  });
  test("classifies bound conflicts identically for approval and execution", () => {
    const state: ApprovalTargetState = { selected: true, binding: "remote-one", proposalSources: [] };
    const metadata = remoteWrapperApproval("write", "write", () => ["native-local"], () => state);
    expect(metadata.approvalCacheTargets({ path: "conflict://1", content: "@ours" })).toEqual(["native-local"]);
    expect(metadata.approvalCacheTargets({ path: "remote-conflict://remote-one/1", content: "@ours" })?.[0]).toStartWith("remote-request\0");
    expect(() => metadata.approvalCacheTargets({ path: "remote-conflict://remote-old/1", content: "@ours" })).toThrow("stale workspace binding");
    state.selected = false;
    expect(() => metadata.approvalCacheTargets({ path: "remote-conflict://remote-one/1", content: "@ours" })).toThrow("stale workspace binding");
  });

  test("approval and cache selection reject mixed bound conflicts and local processes in either order", () => {
    const state: ApprovalTargetState = { selected: true, binding: "current", sessionFile: "/tmp/approval-resource-session.jsonl", proposalSources: [] };
    const registry = spyOn(AgentRegistry, "global").mockReturnValue({ list: () => [
      { id: "Main", sessionFile: state.sessionFile, session: { asyncJobManager: { getAllJobs: () => [{ id: "bg_1" }] } } },
      { id: "Scout" },
    ] } as never);
    let nativeCalls = 0;
    let approvalCalls = 0;
    const metadata = remoteWrapperApproval("read", () => { approvalCalls++; return "read"; }, () => { nativeCalls++; return ["native-local"]; }, () => state);
    try {
      for (const proc of ["proc://bg_1", "PROC://%62g_1:1-5", "[proc://bg_1#ABCD]", "proc://Scout"]) {
        for (const path of [`remote-conflict://current/1;${proc}`, `${proc};remote-conflict://current/1`]) {
          const args = { path };
          expect(() => metadata.approvalCacheTargets(args)).toThrow("Mixed local and remote");
          expect(() => metadata.assertBinding(args)).toThrow("Mixed local and remote");
          expect(() => (metadata.approval as (input: unknown) => unknown)(args)).toThrow("Mixed local and remote");
        }
      }
      expect(nativeCalls).toBe(0);
      expect(approvalCalls).toBe(0);
      for (const path of ["remote-conflict://current/1;PROC://%77eb", "PROC://%77eb;remote-conflict://current/1"]) {
        expect(metadata.approvalCacheTargets({ path })?.[0]).toStartWith("remote-request\0");
      }
      state.selected = false;
      expect(metadata.approvalCacheTargets({ path: "proc://bg_1;proc://web" })).toEqual(["native-local"]);
      for (const path of ["remote-conflict://current/1;proc://bg_1", "proc://bg_1;remote-conflict://current/1"]) {
        expect(() => metadata.approvalCacheTargets({ path })).toThrow("stale workspace binding");
      }
    } finally { registry.mockRestore(); }
  });

  test("native conflict aliases cannot acquire remote approval targets after reconnect", () => {
    const state: ApprovalTargetState = { selected: true, binding: "remote-current", proposalSources: [] };
    for (const name of ["read", "write"] as const) {
      const metadata = remoteWrapperApproval(name, "write", () => ["native-local"], () => state);
      for (const path of ["file:conflict://1", "[conflict://1#ABCD]", "[file:conflict://1#ABCD]", "remote-conflict://old-binding/1:conflict://1"]) {
        expect(metadata.approvalCacheTargets({ path, content: "@ours" })).toEqual(["native-local"]);
      }
      expect(() => metadata.approvalCacheTargets({ path: "[remote-conflict://old-binding/1#ABCD]", content: "@ours" })).toThrow("stale workspace binding");
      expect(metadata.approvalCacheTargets({ path: "[remote-conflict://remote-current/1#ABCD]", content: "@ours" })?.[0]).toStartWith("remote-request\0");
    }
  });

  test("uses native effective edit mode and rejects cross-domain move grants", () => {
    const state: ApprovalTargetState = { selected: true, binding: "remote", proposalSources: [], editMode: "replace" };
    const metadata = remoteWrapperApproval("edit", "write", () => ["native-local"], () => state);
    expect(metadata.approvalCacheTargets({ path: "local://a", old_string: "a", new_string: "b" })).toEqual(["native-local"]);
    expect(metadata.approvalCacheTargets({ path: "file", old_string: "a", new_string: "b" })?.[0]).toStartWith("remote-request\0");
    state.editMode = "hashline";
    for (const [from, to] of [["file", "local://a"], ["local://a", "file"]]) {
      const args = { input: `*** Begin Patch\n[${from}#AB12]\nMV ${to}\n*** End Patch` };
      expect(() => resolveApproval({ name: "edit", ...metadata }, args, "yolo")).toThrow("cannot mix");
      expect(() => metadata.approvalCacheTargets(args)).toThrow("cannot mix");
      expect(() => metadata.assertBinding(args)).toThrow("cannot mix");
    }
  });
});
