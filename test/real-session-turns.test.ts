import { expect } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { RemoteLspDiagnostics } from "../src/omp/lsp-diagnostics.ts";
import { WORKSPACE_NOTICE_TYPE } from "../src/omp/workspace-context.ts";
import { createRealSession, fixtureFile, hold, realSessionTest } from "./fixtures/real-session.ts";

realSessionTest(import.meta.path, "workspace-notice-acceptance: aborted hook output is not committed; accepted notice reaches context once", async root => {
  const seen: AgentMessage[][] = [];
  let cancel = true;
  let cancelledHookRuns = 0;
  const f = await createRealSession(root, { afterRemote: [pi => {
    pi.on("before_agent_start", (_event, ctx) => {
      if (cancel) { cancelledHookRuns++; ctx.abort(); }
    });
    pi.on("context", event => { seen.push(event.messages); });
  }] });
  try {
    await f.connect();
    const persisted = () => f.session.sessionManager.getBranch().flatMap(entry =>
      entry.type === "custom_message" && entry.customType === WORKSPACE_NOTICE_TYPE ? [entry] : []);
    await f.session.prompt("This cancelled prompt must not commit a workspace binding.");
    expect(cancelledHookRuns).toBe(1);
    expect(f.dispatchModels).toEqual([]);
    expect(f.provider.dispatches).toEqual([]);
    expect(seen).toEqual([]);
    expect(persisted()).toEqual([]);
    expect(JSON.stringify(f.session.messages)).not.toContain("This cancelled prompt");

    cancel = false;
    const first = await f.turn("Accept the remote workspace notice.");
    const notices = (messages: AgentMessage[]) => messages.filter(message =>
      message.role === "custom" && message.customType === WORKSPACE_NOTICE_TYPE);
    expect(persisted()).toHaveLength(1);
    const committed = persisted()[0]!;
    expect(notices(seen[0]!)).toEqual([expect.objectContaining({ content: committed.content, details: committed.details })]);
    expect(JSON.stringify(first[0]!.messages)).toContain("Workspace binding: remote");

    await f.turn("Reuse the committed workspace notice.");
    expect(persisted()).toHaveLength(1);
    expect(notices(seen.at(-1)!)).toHaveLength(1);
    expect(f.calls).toEqual([]);
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "cursor-turn-admission: native prompt cancellation prevents provider dispatch and history commit", async root => {
  const f = await createRealSession(root);
  try {
    await f.connect();
    // Use the live agent model the native hook sees, without any real Cursor
    // credential or transport. The fixture rejects any non-scripted dispatch.
    f.provider.registry.authStorage.keys.setRuntime("cursor", "fixture");
    f.session.agent.setModel({ ...f.provider.model, provider: "cursor", api: "cursor-agent" });
    expect(f.session.model).toMatchObject({ provider: "cursor", api: "cursor-agent" });
    const before = [...f.session.sessionManager.getBranch()];
    await f.session.prompt("A Cursor turn must not run in the bound workspace.");
    expect(f.dispatchModels).toEqual([]);
    expect(f.provider.dispatches).toEqual([]);
    expect(f.session.sessionManager.getBranch()).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(f.runtimeErrors).toEqual([]);

    f.session.agent.setModel(f.provider.model);
    await f.turn("This supported model can still start a turn.");
    expect(f.dispatchModels).toHaveLength(1);
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "diagnostic-production-delivery: live SDK builds model context and discards a revoked binding", async root => {
  const ready = hold();
  const contexts: AgentMessage[][] = [];
  const f = await createRealSession(root, {
    afterExecute: async tool => { if (tool === "read") await ready.pause(); },
    afterRemote: [pi => { pi.on("context", event => { contexts.push(event.messages); }); }],
  });
  try {
    await f.connect();
    const owner = f.session.sessionManager.getSessionId();
    let revoked = false;
    const current = new RemoteLspDiagnostics(f.session, owner, "current", () => true);
    const previous = new RemoteLspDiagnostics(f.session, owner, "previous", () => !revoked);
    const turn = f.turn("Yield pending diagnostics at the next model request.", { name: "read", arguments: { path: fixtureFile } });
    try {
      await Promise.race([ready.entered, turn.then(() => { throw new Error("Tool never entered the held response boundary"); })]);
      for (const [binding, gate, marker] of [["previous", previous, "REVOKED_DIAGNOSTIC"], ["current", current, "LIVE_DIAGNOSTIC"]] as const) {
        const entry = { sessionId: owner, resourceBinding: binding, path: fixtureFile, version: 1 };
        gate.mutation(entry);
        gate.diagnostics({ ...entry, summary: "1 error", messages: [marker], errored: true });
      }
      // Both entries passed ingress; revocation happens before native lazy delivery.
      revoked = true;
    } finally { ready.release(); await turn; }
    const delivered = contexts.flat().filter(message => message.role === "custom" && message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE);
    expect(delivered).toHaveLength(1);
    expect(JSON.stringify(delivered[0])).toContain("LIVE_DIAGNOSTIC");
    expect(JSON.stringify(delivered[0])).not.toContain("REVOKED_DIAGNOSTIC");
    expect(JSON.stringify(f.provider.dispatches[1]!.messages)).toContain("LIVE_DIAGNOSTIC");
    expect(JSON.stringify(f.provider.dispatches)).not.toContain("REVOKED_DIAGNOSTIC");
    expect(JSON.stringify(f.session.sessionManager.getBranch())).not.toContain("REVOKED_DIAGNOSTIC");
  } finally { await f.dispose(); }
});
