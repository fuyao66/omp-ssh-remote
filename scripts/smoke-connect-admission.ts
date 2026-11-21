// Native connect admission probes for the worker setting and same-thread descendants.
import assert from "node:assert/strict";
import { isMainThread, threadId } from "node:worker_threads";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent/task/executor";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { bootstrapSmokeHost } from "./smoke-host.ts";

export default async function connectAdmissionSmoke(pi: ExtensionAPI) {
  const endpoint = process.env.CONNECT_ADMISSION_ENDPOINT, run = process.env.OMP_ACCEPTANCE_RUN_ID;
  assert(endpoint && new URL(endpoint).hostname === "127.0.0.1" && run, "Use the isolated runner");
  const post = async (route: string, body: object = {}) => {
    const response = await fetch(`${endpoint}/${route}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    assert(response.ok, `${route}: ${await response.clone().text()}`); return response.json() as Promise<any>;
  };
  const commands = await bootstrapSmokeHost(pi);
  pi.registerProvider("connect-admission", { baseUrl: `${endpoint}/v1`, apiKey: "loopback-only", api: "openai-completions",
    models: [{ id: "probe", name: "Connect admission probe", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 256 }] });
  const sessions = new Map<string, { instanceKey: string; release?: () => void }>();
  pi.on("session_start", async (_, ctx) => {
    if (ctx.agent.kind !== "sub") return;
    const session = AgentRegistry.global().get(ctx.agent.id)?.session;
    assert(session && isLocalAgentSession(session), "Observer must run on the child's actual home thread");
    const status = await session.getToolByName("remote_workspace_status")!.execute(crypto.randomUUID(), {}, AbortSignal.timeout(40_000));
    const entry: { instanceKey: string; release?: () => void } = { instanceKey: session.instanceKey }; sessions.set(ctx.agent.id, entry);
    // The extra native hold outlives the initial executor run. Deferred peer
    // work must survive rejection and execute only when the TEST releases it.
    if (status.details.mode === "local") {
      entry.release = session.holdIrcWakes();
      await session.deliverIrcMessage({ id: `queued_${run}`, from: `peer_${run}`, to: ctx.agent.id, body: `ADMISSION_WAKE=${ctx.agent.id}`, ts: Date.now() });
      assert(session.ircWakesPending && session.hasQueuedIrcFrom(`peer_${run}`));
    }
    // Local start deliberately does not read remote procfs or assert inheritance.
    await post("observe", { id: ctx.agent.id, instanceKey: session.instanceKey, isMainThread, threadId, pid: process.pid,
      mode: status.details.mode, sessionId: ctx.sessionManager.getSessionId(), remoteCwd: status.details.remoteCwd });
  });
  pi.on("session_shutdown", async (_, ctx) => {
    const entry = sessions.get(ctx.agent.id); if (entry) { entry.release?.(); await post("shutdown", { id: ctx.agent.id, instanceKey: entry.instanceKey }); }
  });
  pi.registerCommand("connect-worker-setting-refusal-smoke", { description: "Verify connect refuses enabled task worker threads before SSH", async handler(_, ctx) {
    try {
      assert(isMainThread && threadId === 0, "Probe the setting on the root session, not in a worker");
      assert(ctx.sessionManager.getSessionFile(), "Probe requires a named session");
      // Missing mandatory target makes SSH impossible even if the setting guard regresses.
      await assert.rejects(async () => commands.get("remote-connect")!.handler("", ctx), /task\.workerThreads: 0/);
      const owner = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session;
      assert(owner && isLocalAgentSession(owner));
      const status = await owner.getToolByName("remote_workspace_status")!.execute(crypto.randomUUID(), {}, AbortSignal.timeout(10_000));
      assert.equal(status.details.mode, "local");
      console.log("CONNECT_WORKER_SETTING_REFUSAL_SMOKE_PASS");
    } catch (error) { console.error("CONNECT_WORKER_SETTING_REFUSAL_SMOKE_ERROR", error); process.exitCode = 1; }
    finally { process.exit(process.exitCode ?? 0); }
  }});
  pi.registerCommand("connect-admission-smoke", { description: "Verify same-thread live descendant admission and native park/revival", async handler(_, ctx) {
    assert(isMainThread);
    const registry = AgentRegistry.global(), lifecycle = AgentLifecycleManager.global();
    const owner = registry.list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session as any; assert(owner?.getToolByName);
    const invoke = async (name: string, input: object) => {
      const result = await owner.getToolByName(name).execute(crypto.randomUUID(), input, AbortSignal.timeout(180_000), undefined,
        { hasUI: false, settings: owner.settings, sessionManager: owner.sessionManager, toolNames: pi.getActiveTools() } as never);
      assert(!result.isError, JSON.stringify(result)); return result;
    };
    const connect = () => commands.get("remote-connect")!.handler(process.env.REMOTE_CONNECT_ARGS!, ctx);
    const rejected = async (reason: RegExp) => {
      // A missing target tests admission without opening SSH if a guard is bypassed.
      await assert.rejects(async () => commands.get("remote-connect")!.handler("", ctx), reason);
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "local");
    };
    const until = (session: Parameters<typeof isLocalAgentSession>[0], check: () => boolean) => {
      assert(session && isLocalAgentSession(session));
      const gate = Promise.withResolvers<void>();
      const unsubscribe: (() => void)[] = [];
      const cleanup = () => { clearTimeout(timer); for (const stop of unsubscribe) stop(); };
      const timer = setTimeout(() => { cleanup(); gate.reject(new Error("Native wake settlement timed out")); }, 30_000);
      const inspect = () => { if (check()) { cleanup(); gate.resolve(); } };
      unsubscribe.push(registry.onChange(inspect), session.subscribeRunState(inspect), session.subscribeWakeState(inspect));
      inspect(); return gate.promise;
    };
    const id = `admit_${run}`;
    let batch: Promise<any> | undefined, connected = false;
    try {
      assert(process.env.REMOTE_CONNECT_ARGS);
      const model = ctx.modelRegistry.find("connect-admission", "probe"); assert(model); assert(await pi.setModel(model));
      batch = invoke("task", { context: "Loopback-only native acceptance.", tasks: [{ agent: "task", name: id,
        model: "connect-admission/probe", task: `ADMISSION_TURN=${id}:initial`, solutionSpace: "One fixed local hostname probe" }] });
      void batch.catch(() => {});
      const initial = await post("await-initial");
      const child = initial.observations.find((row: any) => row.id === id && row.mode === "local");
      assert(child?.isMainThread && child.threadId === 0);
      assert.equal(registry.get(id)!.status, "running");
      await rejected(/running work/i); assert.equal(registry.get(id)!.session!.instanceKey, child.instanceKey);
      await post("release-initial"); const result = await batch; batch = undefined;
      assert.equal(result.details.results?.length, 1);
      assert.equal(result.details.results[0].exitCode, 0, JSON.stringify(result.details.results[0]));
      const session = registry.get(id)!.session;
      assert(session && isLocalAgentSession(session));
      assert.equal(registry.get(id)!.status, "idle");
      assert(session.ircWakesPending);
      await rejected(/IRC wake settlement exceeded 1000 ms.*IRC wake held\/queued\/awaiting compaction/i);
      assert.equal(registry.get(id)!.session, session);
      assert(session.hasQueuedIrcFrom(`peer_${run}`), "Connect discarded queued work");
      await post("assert-no-shutdown", { id, instanceKey: child.instanceKey });
      const entry = sessions.get(id); assert(entry?.release);
      entry.release(); entry.release = undefined;
      await post("await-wake");
      await until(session, () => registry.get(id)?.status === "idle" && !session.isStreaming && !session.ircWakesPending &&
        JSON.stringify(session.messages).includes(`WAKE_ACK_${run}`));
      await post("assert-no-shutdown", { id, instanceKey: child.instanceKey });
      await connect(); connected = true; assert.equal((await invoke("remote_workspace_status", {})).details.mode, "remote");
      assert.equal(registry.get(id)!.status, "parked", "Connect must park the settled live descendant");
      assert.equal(registry.get(id)!.session, null);
      await post("assert-shutdown", { id, instanceKey: child.instanceKey });
      const host = await invoke("bash", { command: "hostname" });
      await post("remote-host", { hostname: host.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim() });
      const agent = { name: "task", description: "Admission probe", systemPrompt: "Follow the deterministic assignment.", source: "project" as const };
      const follow = (phase: string) => runSubagentFollowUpTurn({ id, agent, message: `ADMISSION_TURN=${id}:${phase}`,
        completionProbe: false, softRequestBudget: 0, maxRuntimeMs: 90_000 });
      const revived = await follow("revived"); assert.equal(revived.exitCode, 0, JSON.stringify(revived)); assert(revived.output.includes(`REMOTE_ACK_${run}`));
      assert.notEqual(registry.get(id)!.session!.instanceKey, child.instanceKey);
      await post("before-exit");
      await commands.get("remote-exit")!.handler("--force", ctx); connected = false;
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "local");
      const revoked = await follow("revoked"); assert.equal(revoked.exitCode, 0, JSON.stringify(revoked)); assert(revoked.output.includes(`REVOKED_ACK_${run}`));
      await post("assert-marker-absent");
      console.log("CONNECT_ADMISSION_SMOKE_PASS", JSON.stringify({ runningRefused: true, heldWakeRefused: true, queuedWakeAcknowledged: true,
        connectParkedChild: true, sameThreadRemoteRevival: true, ownerExitFailClosed: true }));
    } catch (error) { console.error("CONNECT_ADMISSION_SMOKE_ERROR", error); process.exitCode = 1; }
    finally {
      await post("release-initial").catch(() => {}); sessions.get(id)?.release?.(); await batch?.catch(() => {});
      await lifecycle.release(id).catch(error => { console.error(error); process.exitCode = 1; });
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(error => { console.error(error); process.exitCode = 1; });
      owner.clearQueue(); process.exit(process.exitCode ?? 0);
    }
  }});
}
