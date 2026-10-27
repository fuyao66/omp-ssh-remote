import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { workspaceNotice, workspaceAnnouncement, type WorkspaceBindingNotice } from "../src/omp/workspace-context.ts";

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
