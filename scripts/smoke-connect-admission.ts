// Native admission probe. Manual parking below is TEST setup, not a remote feature.
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
    if (!isMainThread && status.details.mode === "local") {
      entry.release = session.holdIrcWakes();
      await session.deliverIrcMessage({ id: `queued_${run}`, from: `peer_${run}`, to: ctx.agent.id, body: `ADMISSION_WAKE=${ctx.agent.id}`, ts: Date.now() });
      assert(session.ircWakesPending && session.hasQueuedIrcFrom(`peer_${run}`));
      void post("await-wake-release", { id: ctx.agent.id }).then(() => { entry.release?.(); entry.release = undefined; })
        .catch(error => { console.error("WAKE_RELEASE_ERROR", error); process.exit(1); });
    }
    // Local start deliberately does not read remote procfs or assert inheritance.
    await post("observe", { id: ctx.agent.id, instanceKey: session.instanceKey, isMainThread, threadId, pid: process.pid,
      mode: status.details.mode, sessionId: ctx.sessionManager.getSessionId(), remoteCwd: status.details.remoteCwd });
  });
  pi.on("session_shutdown", async (_, ctx) => {
    const entry = sessions.get(ctx.agent.id); if (entry) { entry.release?.(); await post("shutdown", { id: ctx.agent.id, instanceKey: entry.instanceKey }); }
  });
  pi.registerCommand("connect-admission-smoke", { description: "Verify worker refusal and test-driven native park/revival", async handler(_, ctx) {
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
      await assert.rejects(connect, (error: unknown) => {
        const message = String(error);
        assert.match(message, /worker.thread session requires native parking/i); assert.match(message, reason); return true;
      });
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "local");
    };
    const until = (check: () => boolean) => {
      const gate = Promise.withResolvers<void>(); let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); gate.reject(new Error("Native mirror settlement timed out")); }, 30_000);
      const inspect = () => { if (check()) { clearTimeout(timer); unsubscribe(); gate.resolve(); } };
      unsubscribe = registry.onChange(inspect); inspect(); return gate.promise;
    };
    const ids = Array.from({ length: 9 }, (_, index) => `admit_${run}_${index}`);
    let batch: Promise<any> | undefined, connected = false;
    try {
      assert(process.env.REMOTE_CONNECT_ARGS);
      const model = ctx.modelRegistry.find("connect-admission", "probe"); assert(model); assert(await pi.setModel(model));
      batch = invoke("task", { context: "Loopback-only native acceptance.", tasks: ids.map(id => ({ agent: "task", name: id,
        model: "connect-admission/probe", task: `ADMISSION_TURN=${id}:initial`, solutionSpace: "One fixed local hostname probe" })) });
      void batch.catch(() => {});
      const initial = await post("await-initial"), worker = initial.observations.find((row: any) => row.threadId > 0); assert(worker);
      const id = worker.id; assert.equal(registry.get(id)!.status, "running");
      await rejected(/running work/i); assert.equal(registry.get(id)!.session!.instanceKey, worker.instanceKey);
      await post("release-initial"); const result = await batch; batch = undefined;
      assert.equal(result.details.results?.length, 9); for (const child of result.details.results) assert.equal(child.exitCode, 0, JSON.stringify(child));
      await until(() => registry.get(id)?.status === "idle" && registry.get(id)?.session?.ircWakesPending === true);
      await rejected(/immediate retry will not help.*IRC wake held\/queued\/awaiting compaction/i);
      assert.equal(registry.get(id)!.session!.instanceKey, worker.instanceKey);
      assert(await registry.get(id)!.session!.hasQueuedIrcFrom(`peer_${run}`), "Connect discarded queued work");
      await post("assert-no-shutdown", { id, instanceKey: worker.instanceKey });
      await post("release-wake"); await post("await-wake");
      await until(() => registry.get(id)?.status === "idle" && registry.get(id)?.session?.ircWakesPending === false &&
        JSON.stringify(registry.get(id)?.session?.messages).includes(`WAKE_ACK_${run}`));
      await rejected(/immediate retry will not help/i); assert.equal(registry.get(id)!.session!.instanceKey, worker.instanceKey);
      await post("assert-no-shutdown", { id, instanceKey: worker.instanceKey });
      // Explicit TEST-only native park; production must continue refusing a live worker.
      await lifecycle.park(id); assert.equal(registry.get(id)!.status, "parked"); assert.equal(registry.get(id)!.session, null);
      await post("await-shutdown", { id, instanceKey: worker.instanceKey });
      await connect(); connected = true; assert.equal((await invoke("remote_workspace_status", {})).details.mode, "remote");
      const host = await invoke("bash", { command: "hostname" });
      await post("remote-host", { hostname: host.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim() });
      const agent = { name: "task", description: "Admission probe", systemPrompt: "Follow the deterministic assignment.", source: "project" as const };
      const follow = (phase: string) => runSubagentFollowUpTurn({ id, agent, message: `ADMISSION_TURN=${id}:${phase}`, structured: false,
        completionProbe: false, softRequestBudget: 0, maxRuntimeMs: 90_000 });
      const revived = await follow("revived"); assert.equal(revived.exitCode, 0, JSON.stringify(revived)); assert(revived.output.includes(`REMOTE_ACK_${run}`));
      assert.notEqual(registry.get(id)!.session!.instanceKey, worker.instanceKey);
      await post("before-exit");
      await commands.get("remote-exit")!.handler("--force", ctx); connected = false;
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "local");
      const revoked = await follow("revoked"); assert.equal(revoked.exitCode, 0, JSON.stringify(revoked)); assert(revoked.output.includes(`REVOKED_ACK_${run}`));
      await post("assert-marker-absent");
      console.log("CONNECT_ADMISSION_SMOKE_PASS", JSON.stringify({ runningRefused: true, idleWorkerPreserved: true, queuedWakeAcknowledged: true,
        testOnlyManualPark: true, actualRemoteRevival: true, ownerExitFailClosed: true }));
    } catch (error) { console.error("CONNECT_ADMISSION_SMOKE_ERROR", error); process.exitCode = 1; }
    finally {
      await post("release-initial").catch(() => {}); await post("release-wake").catch(() => {}); await batch?.catch(() => {});
      for (const id of ids) await lifecycle.release(id).catch(error => { console.error(error); process.exitCode = 1; });
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(error => { console.error(error); process.exitCode = 1; });
      owner.clearQueue(); process.exit(process.exitCode ?? 0);
    }
  }});
}
