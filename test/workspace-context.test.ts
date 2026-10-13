import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { workspaceNotice, projectWorkspaceContext, type WorkspaceBindingNotice } from "../src/omp/workspace-context.ts";

const local: WorkspaceBindingNotice = { binding: "local-1", mode: "local", target: null, cwd: "/project" };
const remote: WorkspaceBindingNotice = { binding: "remote-1", mode: "remote", target: "server", cwd: "/project" };

test("unchanged state emits no repeated notices; switches append without modifying prior messages", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "Work on this project", timestamp: 1 }];
  for (const binding of [local, remote, { ...remote, mode: "unavailable" as const }, { ...remote, binding: "remote-2" }, { ...local, binding: "local-2" }]) {
    const before = JSON.stringify(messages);
    const notice = workspaceNotice(messages, binding)!;
    expect(notice.details).toEqual(binding);
    expect(JSON.stringify(messages)).toBe(before);
    messages.push(notice);
    expect(workspaceNotice(messages, binding)).toBeUndefined();
  }
});

test("compaction and resumed sessions recover current binding rather than trusting old state", () => {
  const oldNotice = workspaceNotice([], remote)!;
  const compacted: AgentMessage[] = [{ role: "user", content: "Compacted summary", timestamp: 2 }];
  expect(workspaceNotice(compacted, remote)?.details).toEqual(remote);
  // A restored transcript must not re-select its former SSH connection.
  expect(workspaceNotice([oldNotice], local)?.details).toEqual(local);
  // Reconnect to the same hostname/cwd still has fresh runtime state.
  expect(workspaceNotice([oldNotice], { ...remote, binding: "new-runtime" })?.details?.binding).toBe("new-runtime");
});

test("provider context replay retains exactly the observed prefix including multiple same-anchor switches", () => {
  const raw: AgentMessage[] = [{ role: "user", content: "first", timestamp: 10 }];
  const first = projectWorkspaceContext(raw, [], local);
  expect(raw).toHaveLength(1);
  const second = projectWorkspaceContext(raw, first.records, remote);
  expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(second.records).toHaveLength(2);
  raw.push({ role: "user", content: "second", timestamp: 20 });
  const replay = projectWorkspaceContext(raw, JSON.parse(JSON.stringify(second.records)), remote);
  expect(replay.messages.slice(0, second.messages.length)).toEqual(second.messages);
  expect(replay.messages.at(-1)).toEqual(raw[1]);
  expect(replay.changed).toBe(false);
  const compacted = projectWorkspaceContext([{ role: "user", content: "summary", timestamp: 30 }], replay.records, remote);
  expect(compacted.records).toHaveLength(1);
  expect(compacted.records[0].message.details).toEqual(remote);
  expect(compacted.messages).toHaveLength(2);
});
