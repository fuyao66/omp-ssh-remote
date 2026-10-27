import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { WORKSPACE_NOTICE_TYPE, workspaceNotice, workspaceAnnouncement, type WorkspaceBindingNotice } from "../src/omp/workspace-context.ts";

const local: WorkspaceBindingNotice = { binding: "local-1", mode: "local", target: null, cwd: "/project" };
const remote: WorkspaceBindingNotice = { binding: "remote-1", mode: "remote", target: "server", cwd: "/project" };

function accept(manager: SessionManager, current: WorkspaceBindingNotice): string {
  const notice = workspaceAnnouncement(current, manager.getBranch())!;
  expect(notice).toBeDefined();
  expect(notice.role).toBe("custom");
  expect(notice.customType).toBe("remote-workspace-binding");
  expect(notice.details).toEqual(current);
  return manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
}

function effectiveNotices(manager: SessionManager) {
  return manager.buildSessionContext().messages.filter(message =>
    message.role === "custom" && message.customType === WORKSPACE_NOTICE_TYPE);
}

function appendUser(manager: SessionManager, content = "continue") {
  return manager.appendMessage({ role: "user", content, timestamp: Date.now() });
}

test("a new local session needs no extra model-visible message", () => {
  const manager = SessionManager.inMemory("/project");
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
});

test("binding transitions are native accepted messages prepared before context transforms", () => {
  const manager = SessionManager.inMemory("/project");
  for (const current of [remote, { ...remote, mode: "unavailable" as const }, { ...remote, binding: "remote-2" }, { ...local, binding: "local-2" }]) {
    accept(manager, current);
    expect(manager.getBranch().at(-1)).toMatchObject({
      type: "custom_message", customType: "remote-workspace-binding", details: current,
    });
    expect(workspaceAnnouncement(current, manager.getBranch())).toBeUndefined();
  }
});

test("restored native remote entries and legacy markers get one explicit local correction", () => {
  for (const legacy of [false, true]) {
    const manager = SessionManager.inMemory("/project");
    if (legacy) manager.appendCustomEntry("remote-workspace-context-v1", { mode: "remote", target: "old-host" });
    else accept(manager, remote);
    const notice = workspaceAnnouncement(local, manager.getBranch())!;
    expect(notice.details).toEqual(local);
    expect(notice.content).toContain("Workspace binding: local");
    accept(manager, local);
    expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  }
});

test("a cancelled hook result is retried until the native manager accepts it", () => {
  const manager = SessionManager.inMemory("/project");
  const first = workspaceAnnouncement(remote, manager.getBranch())!;
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(first.details);
  expect(manager.getBranch()).toHaveLength(0);
  accept(manager, remote);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
  expect(manager.getBranch().filter(entry => entry.type === "custom_message")).toHaveLength(1);
});

test("native branch navigation uses only the active branch, including returning to an accepted notice", () => {
  const manager = SessionManager.inMemory("/project");
  const remoteId = accept(manager, remote);
  const localId = accept(manager, local);
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  manager.branch(remoteId);
  expect(workspaceAnnouncement(local, manager.getBranch())?.details).toEqual(local);
  manager.branch(localId);
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
});

test("a missing remote notice is reannounced without altering native history", () => {
  const manager = SessionManager.inMemory("/project");
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  expect(manager.getBranch()).toHaveLength(0);
  const unavailable = workspaceNotice({ ...remote, mode: "unavailable" });
  expect(unavailable.content).toContain("no local fallback");
});

test("reset discards remote notices without erasing native history, and retries until accepted", () => {
  const manager = SessionManager.inMemory("/project");
  accept(manager, remote);
  manager.appendResetBoundary();
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(manager.getBranch().some(entry => entry.type === "custom_message")).toBe(true);
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  expect(effectiveNotices(manager)).toHaveLength(0);
  accept(manager, remote);
  expect(effectiveNotices(manager)).toHaveLength(1);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
});

test("reset leaves local sessions quiet but still announces a subsequent remote transition", () => {
  const manager = SessionManager.inMemory("/project");
  accept(manager, remote);
  accept(manager, local);
  manager.appendResetBoundary();
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  accept(manager, remote);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
});

test("compaction keeps a notice before the compaction entry and suppresses redundant announcements", () => {
  const manager = SessionManager.inMemory("/project");
  appendUser(manager, "discarded prefix");
  const noticeId = accept(manager, remote);
  appendUser(manager);
  manager.appendCompaction("compacted prefix", undefined, noticeId, 100);
  expect(effectiveNotices(manager)).toMatchObject([{ details: remote }]);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
});

test("compaction dropping the latest notice does not let persisted history suppress its replacement", () => {
  const manager = SessionManager.inMemory("/project");
  accept(manager, remote);
  const firstKeptId = appendUser(manager);
  manager.appendCompaction("compacted prefix", undefined, firstKeptId, 100);
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(manager.getBranch().filter(entry => entry.type === "custom_message")).toHaveLength(1);
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  accept(manager, remote);
  expect(effectiveNotices(manager)).toMatchObject([{ details: remote }]);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
});

test("the latest retained notice controls remote, unavailable and local mode transitions", () => {
  const manager = SessionManager.inMemory("/project");
  const unavailable: WorkspaceBindingNotice = { ...remote, mode: "unavailable" };
  accept(manager, remote);
  const retainedId = accept(manager, unavailable);
  manager.appendCompaction("remote connection lost", undefined, retainedId, 100);
  expect(effectiveNotices(manager)).toMatchObject([{ details: unavailable }]);
  expect(workspaceAnnouncement(unavailable, manager.getBranch())).toBeUndefined();
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  accept(manager, local);
  expect(effectiveNotices(manager)).toMatchObject([{ details: unavailable }, { details: local }]);
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  expect(workspaceAnnouncement(unavailable, manager.getBranch())?.details).toEqual(unavailable);
});

test("a discarded local correction needs no replacement until a new remote transition", () => {
  const manager = SessionManager.inMemory("/project");
  accept(manager, remote);
  accept(manager, local);
  const firstKeptId = appendUser(manager);
  manager.appendCompaction("local now", undefined, firstKeptId, 100);
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  accept(manager, { ...remote, binding: "remote-2" });
  expect(workspaceAnnouncement({ ...remote, binding: "remote-2" }, manager.getBranch())).toBeUndefined();
});

test("the latest native boundary decides which retained notices remain effective", () => {
  const manager = SessionManager.inMemory("/project");
  const noticeId = accept(manager, remote);
  manager.appendCompaction("first compaction", undefined, noticeId, 100);
  expect(effectiveNotices(manager)).toHaveLength(1);
  manager.appendResetBoundary();
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  const unavailable: WorkspaceBindingNotice = { ...remote, mode: "unavailable" };
  const unavailableId = accept(manager, unavailable);
  manager.appendCompaction("after clear", undefined, unavailableId, 100);
  expect(effectiveNotices(manager)).toMatchObject([{ details: unavailable }]);
  expect(workspaceAnnouncement(unavailable, manager.getBranch())).toBeUndefined();
  const firstKeptId = appendUser(manager);
  manager.appendCompaction("second compaction", undefined, firstKeptId, 100);
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(workspaceAnnouncement(unavailable, manager.getBranch())?.details).toEqual(unavailable);
});

test("provider replacement compaction does not mistake transcript-kept notices for effective context", () => {
  const manager = SessionManager.inMemory("/project");
  const noticeId = accept(manager, remote);
  const snapshotId = appendUser(manager, "provider replay snapshot");
  manager.appendCompaction("provider compacted", undefined, noticeId, 100, {
    preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory: [{ type: "compaction", encrypted_content: "opaque-fixture" }] } },
    providerReplayThroughEntryId: snapshotId,
  });
  expect(manager.buildSessionContext({ transcript: true }).messages.some(message =>
    message.role === "custom" && message.customType === WORKSPACE_NOTICE_TYPE)).toBe(true);
  expect(effectiveNotices(manager)).toHaveLength(0);
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
  accept(manager, remote);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
});

test("provider replacement compaction retains native notices appended after its replay snapshot", () => {
  const manager = SessionManager.inMemory("/project");
  const snapshotId = appendUser(manager, "provider replay snapshot");
  accept(manager, remote);
  manager.appendCompaction("provider compacted", undefined, snapshotId, 100, {
    preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory: [{ type: "compaction", encrypted_content: "opaque-fixture" }] } },
    providerReplayThroughEntryId: snapshotId,
  });
  expect(effectiveNotices(manager)).toMatchObject([{ details: remote }]);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
});

test("legacy markers before a reset or compaction never revive a local migration notice", () => {
  for (const boundary of ["reset", "compaction"] as const) {
    const manager = SessionManager.inMemory("/project");
    manager.appendCustomEntry("remote-workspace-context-v1", { mode: "remote", target: "old-host" });
    if (boundary === "reset") manager.appendResetBoundary();
    else manager.appendCompaction("discarded legacy state", undefined, appendUser(manager), 100);
    expect(effectiveNotices(manager)).toHaveLength(0);
    expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
    expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  }
});

test("branching to an off-branch notice projects the selected leaf, not its recorded former active leaf", () => {
  const manager = SessionManager.inMemory("/project");
  const remoteId = accept(manager, remote);
  const localId = manager.appendMessageToBranch(workspaceNotice(local), remoteId);
  expect(workspaceAnnouncement(remote, manager.getBranch())).toBeUndefined();
  manager.branch(localId);
  expect(effectiveNotices(manager)).toMatchObject([{ details: remote }, { details: local }]);
  expect(workspaceAnnouncement(local, manager.getBranch())).toBeUndefined();
  expect(workspaceAnnouncement(remote, manager.getBranch())?.details).toEqual(remote);
});
