import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { resolveHostSessionRef } from "../src/omp/host-session.ts";
import { resolveJobOwnerId, resolveLocalAsyncJobManager } from "../src/omp/async-bash.ts";

test("live manager ownership follows transitions without accepting stale paths or another context", () => {
  const registry = new AgentRegistry();
  let file = "/sessions/initial.jsonl";
  const sessionManager = { getSessionFile: () => file };
  const manager = {};
  const session = { sessionManager, asyncJobManager: manager } as unknown as NonNullable<Parameters<AgentRegistry["register"]>[0]["session"]>;
  const owner = registry.register({ id: "Owner", displayName: "owner", kind: "main", sessionFile: file, session });
  const otherManager = { getSessionFile: () => file };
  registry.register({ id: "Other", displayName: "other", kind: "sub", session: { sessionManager: otherManager } as typeof session, sessionFile: file });
  const ctx = { agent: { id: "Owner" }, sessionManager } as unknown as ExtensionContext;
  file = "/sessions/next.jsonl";
  expect(owner.sessionFile).toBe("/sessions/initial.jsonl");
  expect(resolveHostSessionRef(file, ctx, registry)).toBe(owner);
  expect(resolveHostSessionRef(file, undefined, registry)).toBe(owner);
  expect(resolveHostSessionRef("/sessions/initial.jsonl", undefined, registry)).toBeUndefined();
  expect(resolveLocalAsyncJobManager(file, registry)).toBe(session.asyncJobManager);
  expect(resolveJobOwnerId(file, registry)).toBe("Owner");
  expect(resolveHostSessionRef(file, { ...ctx, agent: { ...ctx.agent, id: "Other" } }, registry)).toBe(owner);
  expect(resolveHostSessionRef(file, { ...ctx, sessionManager: { getSessionFile: () => file } as typeof ctx.sessionManager }, registry)).toBeUndefined();
  registry.detachSession("Owner", session);
  expect(resolveHostSessionRef(file, ctx, registry)).toBeUndefined();
});
