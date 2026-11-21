import { expect, spyOn } from "bun:test";
import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveLocalHostSession } from "../src/omp/host-session.ts";
import { withReadinessSteering } from "../src/omp/readiness-steering.ts";
import { createRealSession, fixtureFile, hold, realSessionTest, remoteText } from "./fixtures/real-session.ts";

const read = { name: "read", arguments: { path: fixtureFile } };

realSessionTest(import.meta.path, "host-session-transitions: switch, branch, tree and reattach fence old ownership and results", async root => {
  let heldRead: ReturnType<typeof hold> | undefined;
  const f = await createRealSession(root, {
    afterExecute: async (tool, result) => {
      if (tool !== "read" || !heldRead) return;
      expect(JSON.stringify(result)).toContain(remoteText);
      await heldRead.pause();
    },
  });
  try {
    const session = f.session, manager = session.sessionManager, registry = AgentRegistry.global();
    const originalFile = manager.getSessionFile()!;
    const ctx = f.runner.createContext();
    const ref = registry.get(ctx.agent.id)!;
    expect(resolveLocalHostSession(originalFile)).toBe(session);
    expect(resolveLocalHostSession(originalFile, ctx)).toBe(session);
    const target = SessionManager.create(f.cwd, join(root, "sessions"));
    target.appendMessage({ role: "user", content: [{ type: "text", text: "Target transcript" }], timestamp: Date.now() });
    await target.flush();
    const targetFile = target.getSessionFile()!;

    await f.connect();
    expect(await session.switchSession(targetFile)).toBe(true);
    expect(f.clients[0]!.client.isClosed).toBe(true);
    expect(session.sessionManager).toBe(manager);
    expect(manager.getSessionFile()).toBe(targetFile);
    expect(resolveLocalHostSession(originalFile)).toBeUndefined();
    expect(resolveLocalHostSession(targetFile)).toBe(session);

    await f.turn("Create a user entry for a real branch.");
    const branchPoint = [...manager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "user")!;
    await f.connect();
    expect((await session.branch(branchPoint.id)).cancelled).toBe(false);
    expect(f.clients[1]!.client.isClosed).toBe(true);
    const branchedFile = manager.getSessionFile()!;
    expect(branchedFile).not.toBe(targetFile);
    expect(resolveLocalHostSession(targetFile)).toBeUndefined();
    expect(resolveLocalHostSession(branchedFile)).toBe(session);

    await f.turn("Establish an earlier leaf for tree navigation.");
    const leaf = manager.getLeafId()!;
    await f.turn("Advance the current leaf before rewinding it.");
    expect(manager.getLeafId()).not.toBe(leaf);
    await f.connect();
    expect((await session.navigateTree(leaf)).cancelled).toBe(false);
    expect(f.clients[2]!.client.isClosed).toBe(true);
    expect(manager.getLeafId()).toBe(leaf);
    expect(manager.getSessionFile()).toBe(branchedFile);

    expect(registry.detachSession(ref.id, ref)).toBe(true);
    expect(resolveLocalHostSession(branchedFile, ctx)).toBeUndefined();
    expect(resolveLocalHostSession(branchedFile)).toBeUndefined();
    // Keep the registry's snapshot stale deliberately: ownership must use the
    // live attachment and its manager, not the snapshot path or id alone.
    expect(registry.attachSession(ref.id, session, originalFile, ref)).toBe(true);
    expect(resolveLocalHostSession(originalFile)).toBeUndefined();
    expect(resolveLocalHostSession(branchedFile)).toBe(session);
    expect(resolveLocalHostSession(branchedFile, { agent: ctx.agent, sessionManager: target })).toBeUndefined();

    await f.connect();
    heldRead = hold();
    const turn = f.turn("Return a read result after its binding closes.", read);
    try {
      await Promise.race([heldRead.entered, turn.then(() => { throw new Error("Remote read did not reach the response boundary"); })]);
      await f.disconnect();
      expect(f.clients[3]!.client.isClosed).toBe(true);
    } finally { heldRead.release(); }
    const messages = (await turn)[1]!.messages;
    expect(JSON.stringify(messages)).toContain("Workspace binding changed during this call");
    expect(JSON.stringify(messages)).not.toContain(remoteText);
    expect(JSON.stringify(manager.getBranch())).not.toContain(remoteText);
    expect(f.calls.map(([tool]) => tool)).toEqual(["read"]);
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "host-readiness-queue-events: steering and IRC interrupt; follow-up and wait do not", async root => {
  let heldRead = hold();
  const f = await createRealSession(root, { afterExecute: async tool => { if (tool === "read") await heldRead.pause(); } });
  try {
    await f.connect();
    const { session, provider } = f;
    const subscribe = session.subscribe.bind(session);
    let subscribed = 0, unsubscribed = 0;
    const observer = spyOn(session, "subscribe").mockImplementation(listener => {
      subscribed++;
      const remove = subscribe(listener);
      return () => { unsubscribed++; remove(); };
    });
    for (const mode of ["steering", "irc", "follow-up", "wait"] as const) {
      heldRead = hold();
      session.setInterruptMode(mode === "wait" ? "wait" : "immediate", false);
      provider.replies.push(read, null, ...(mode === "follow-up" ? [null] : []));
      const turn = session.prompt(`Hold a real tool turn for ${mode}.`);
      const boundary = hold();
      try {
        await Promise.race([heldRead.entered, turn.then(() => { throw new Error("Remote read did not enter readiness boundary"); })]);
        let steering: AbortSignal | undefined;
        const observing = withReadinessSteering(session, async signal => {
          steering = signal;
          await boundary.pause();
        });
        try {
          await boundary.entered;
          if (mode === "irc") {
            expect(await session.deliverIrcMessage({ id: "readiness-irc", from: "fixture-peer",
              to: f.runner.createContext().agent.id, body: "Readiness IRC message", ts: Date.now() })).toBe("injected");
            expect(session.hasIrcInterrupts()).toBe(true);
            // The listener checks the queue in a microtask after the event,
            // then awaits the native IRC predicate before aborting the signal.
            await Promise.resolve();
          } else {
            expect(await session.joinActiveTurn(`Queued ${mode}`, undefined, { queue: mode === "follow-up" ? "followUp" : "steering" })).toBe(true);
            const queue = mode === "follow-up" ? session.agent.peekFollowUpQueue() : session.agent.peekSteeringQueue();
            expect(queue).toHaveLength(1);
          }
          if (mode === "wait") expect(steering).toBeUndefined();
          else expect(steering?.aborted, mode).toBe(mode === "steering" || mode === "irc");
        } finally { boundary.release(); await observing; }
      } finally { heldRead.release(); await turn; }
      expect(provider.replies).toEqual([]);
      expect(provider.unexpected).toEqual([]);
    }
    expect(subscribed).toBe(3);
    expect(unsubscribed).toBe(3);
    expect(f.runtimeErrors).toEqual([]);
    observer.mockRestore();
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "autoresearch-tool-availability: native mode activates and removes only the experiment tools", async root => {
  const experiments = ["init_experiment", "run_experiment", "log_experiment", "update_notes"].sort();
  const f = await createRealSession(root);
  try {
    const baseline = [...f.session.getEnabledToolNames()].sort();
    const advertised = async (prompt: string) => (await f.turn(prompt))[0]!.tools.map(tool => tool.name).sort();
    const before = await advertised("Inspect the tools before enabling autoresearch.");
    expect(before.filter(name => experiments.includes(name))).toEqual([]);

    // No goal means no autonomous experiment/prompt. The isolated cwd is not a Git repository.
    await f.command("autoresearch");
    expect([...f.session.getEnabledToolNames()].sort()).toEqual([...baseline, ...experiments].sort());
    expect(await advertised("Inspect the tools after enabling autoresearch.")).toEqual([...before, ...experiments].sort());

    await f.command("autoresearch", "off");
    expect([...f.session.getEnabledToolNames()].sort()).toEqual(baseline);
    expect(await advertised("Inspect the tools after disabling autoresearch.")).toEqual(before);
    expect(f.calls).toEqual([]);
  } finally { await f.dispose(); }
});
