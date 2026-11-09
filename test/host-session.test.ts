import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { resolveHostSessionRef, resolveLocalHostSession } from "../src/omp/host-session.ts";
import { resolveJobOwnerId, resolveLocalAsyncJobManager } from "../src/omp/async-bash.ts";
import { currentThreadId } from "@oh-my-pi/pi-coding-agent/thread/identity";
import { hostSessionHandle } from "./fixtures/host-session-handle.ts";

test("live manager ownership follows transitions without accepting stale paths or another context", () => {
  const registry = new AgentRegistry();
  let file = "/sessions/initial.jsonl";
  const manager = {};
  const session = { ...hostSessionHandle(() => file), asyncJobManager: manager };
  const sessionManager = session.sessionManager;
  const owner = registry.register({ id: "Owner", displayName: "owner", kind: "main", sessionFile: file, session });
  const other = hostSessionHandle(() => file);
  registry.register({ id: "Other", displayName: "other", kind: "sub", session: other, sessionFile: file });
  const ctx = { agent: { id: "Owner" }, sessionManager } as unknown as ExtensionContext;
  file = "/sessions/next.jsonl";
  expect(owner.sessionFile).toBe("/sessions/initial.jsonl");
  expect(resolveHostSessionRef(file, ctx, registry)).toBe(owner);
  expect(resolveHostSessionRef(file, undefined, registry)).toBe(owner);
  expect(resolveHostSessionRef("/sessions/initial.jsonl", undefined, registry)).toBeUndefined();
  assert.strictEqual(resolveLocalAsyncJobManager(file, registry), manager);
  expect(resolveJobOwnerId(file, registry)).toBe("Owner");
  expect(resolveHostSessionRef(file, { ...ctx, agent: { ...ctx.agent, id: "Other" } }, registry)).toBe(owner);
  expect(resolveHostSessionRef(file, { ...ctx, sessionManager: { getSessionFile: () => file } as typeof ctx.sessionManager }, registry)).toBeUndefined();
  registry.detachSession("Owner", session);
  expect(resolveHostSessionRef(file, ctx, registry)).toBeUndefined();
});

test("home-thread session access rejects remote handles even when their path and manager match", () => {
  const registry = new AgentRegistry();
  const file = "/sessions/worker-owner.jsonl";
  const remote = hostSessionHandle(() => file, "not-this-thread:remote-session");
  const sessionManager = remote.sessionManager;
  const owner = registry.register({ id: "Owner", displayName: "owner", kind: "sub", sessionFile: file, session: remote });
  const ctx = { agent: { id: "Owner" }, sessionManager } as unknown as ExtensionContext;
  expect(resolveHostSessionRef(file, ctx, registry)).toBe(owner);
  expect(resolveLocalHostSession(file, ctx, registry)).toBeUndefined();
  expect(resolveLocalHostSession(file, undefined, registry)).toBeUndefined();
  const local = { ...remote, instanceKey: `${currentThreadId()}:home-session` };
  registry.attachSession("Owner", local, file, owner);
  assert.strictEqual(resolveLocalHostSession(file, ctx, registry), local);
  assert.strictEqual(resolveLocalHostSession(file, undefined, registry), local);
});
