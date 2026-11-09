// Native TaskTool acceptance; build with build-smoke.ts, launch with run-task-acceptance.ts.
import assert from "node:assert/strict";
import { isMainThread, threadId } from "node:worker_threads";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent/task/executor";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { bootstrapSmokeHost } from "./smoke-host.ts";

export default async function taskSmoke(pi: ExtensionAPI) {
  const endpoint = process.env.TASK_ACCEPTANCE_ENDPOINT;
  const run = process.env.OMP_ACCEPTANCE_RUN_ID;
  assert(endpoint && new URL(endpoint).hostname === "127.0.0.1" && run, "Use the isolated acceptance runner");
  const post = async (route: string, body: object) => {
    const response = await fetch(`${endpoint}/${route}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`${route}: ${await response.text()}`);
    return response.json() as Promise<any>;
  };
  const commands = await bootstrapSmokeHost(pi);
  pi.registerProvider("remote-task-smoke", {
    baseUrl: `${endpoint}/v1`, apiKey: "loopback-only", api: "openai-completions",
    models: [{ id: "probe", name: "Deterministic task probe", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 256 }],
  });
  // Installed in every native child, after remote's session_start handler. The
  // observation comes from the executing JS realm, not from placement settings.
  pi.on("session_start", async (_, ctx) => {
    if (ctx.agent.kind !== "sub") return;
    const session = AgentRegistry.global().get(ctx.agent.id)?.session;
    assert(session && isLocalAgentSession(session), "Child observer must run on the child's home thread");
    const native = session as any;
    const status = await native.getToolByName("remote_workspace_status").execute(crypto.randomUUID(), {}, AbortSignal.timeout(40_000));
    // ReadTool opens procfs in the companion itself; Bash runs under the native
    // daemon broker and therefore cannot identify its companion with `$PPID`.
    const identity = await native.getToolByName("read").execute(crypto.randomUUID(), { path: "/proc/self/stat:raw" }, AbortSignal.timeout(40_000));
    assert(!identity.isError, JSON.stringify(identity));
    const stat = identity.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
      .match(/(?:^|\n)(\d+) \((.*)\) (\S) ([^\n]+)/);
    assert(stat, "Native remote ReadTool did not return its procfs identity");
    const fields = [stat[3], ...stat[4].trim().split(/\s+/)];
    const companion = { pid: Number(stat[1]), ppid: Number(fields[1]), start: fields[19] };
    assert(Number.isInteger(companion.pid) && companion.pid > 1 && /^\d+$/.test(companion.start));
    await post("observe", { id: ctx.agent.id, instanceKey: session.instanceKey, nativeThread: session.instanceKey.split(":")[0],
      isMainThread, threadId, pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), status: status.details, companion });
    if (!isMainThread) {
      const target = { id: ctx.agent.id, instanceKey: session.instanceKey, threadId };
      // One held control request, scoped to this actual session generation.
      void fetch(`${endpoint}/await-worker-stop`, { method: "POST", body: JSON.stringify(target) })
        .then(async response => {
          if (!response.ok) throw new Error(await response.text());
          const instruction = await response.json() as typeof target & { stop: boolean };
          assert(instruction.stop && instruction.id === target.id && instruction.instanceKey === target.instanceKey && instruction.threadId === threadId);
          assert(!isMainThread && threadId > 0);
          process.exit(0);
        }).catch(error => { void post("worker-control-failed", { ...target, error: String(error) }).catch(() => {}); });
    }
  });
  pi.registerCommand("remote-task-restart-smoke", { description: "Verify persisted remote intent fails closed after process restart", async handler(_, ctx) {
    const owner = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session as any;
    assert(owner?.getToolByName);
    try {
      const model = ctx.modelRegistry.find("remote-task-smoke", "probe"); assert(model);
      assert(await pi.setModel(model), "Owner must also be loopback-only");
      const invoke = (name: string, input: object) => owner.getToolByName(name).execute(crypto.randomUUID(), input, AbortSignal.timeout(30_000));
      const before = await post("checkpoint", { phase: "restart-start" });
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "unavailable", "Persisted intent was silently restored locally or automatically reconnected");
      const marker = process.env.TASK_ACCEPTANCE_LOCAL_MARKER; assert(typeof marker === "string" && marker.startsWith("/"));
      const result = await invoke("bash", { command: `printf unsafe > '${marker.replaceAll("'", "'\\''")}'` })
        .catch((error: unknown) => ({ isError: true, content: String(error) }));
      assert(result.isError && /unavailable|disconnect|closed|persisted|previously selected|fallback/i.test(JSON.stringify(result)), "Restarted session did not reject its actual workspace command");
      const after = await post("checkpoint", { phase: "restart-complete" });
      assert(after.localMarkerAbsent && after.noNewRemoteWorkers && after.requests === before.requests);
      console.log("RESTART_INTENT_SMOKE_PASS");
    } catch (error) { console.error("RESTART_INTENT_SMOKE_ERROR", error); process.exitCode = 1; }
    finally { owner.clearQueue(); process.exit(process.exitCode ?? 0); }
  }});
  pi.registerCommand("remote-task-smoke", { description: "Verify native task thread placement and remote lifecycle", async handler(_, ctx) {
    assert(isMainThread, "Acceptance command must be owned by the main thread");
    const owner = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session as any;
    assert(owner?.getToolByName, "Native owner session missing");
    const invoke = async (name: string, input: object) => {
      const tool = owner.getToolByName(name); assert(tool, `Missing native ${name}`);
      const result = await tool.execute(crypto.randomUUID(), input, AbortSignal.timeout(180_000), undefined,
        { hasUI: false, settings: owner.settings, sessionManager: owner.sessionManager, toolNames: pi.getActiveTools() } as never);
      assert(!result.isError, JSON.stringify(result)); return result;
    };
    const lifecycle = AgentLifecycleManager.global();
    const ids: string[] = [];
    let connected = false;
    try {
      const model = ctx.modelRegistry.find("remote-task-smoke", "probe"); assert(model);
      assert(await pi.setModel(model), "Owner must also be loopback-only");
      assert(process.env.REMOTE_CONNECT_ARGS, "REMOTE_CONNECT_ARGS must specify an authorized scratch workspace");
      await commands.get("remote-connect")!.handler(process.env.REMOTE_CONNECT_ARGS!, ctx);
      connected = true;
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "remote");
      await post("checkpoint", { phase: "connected" });
      await owner.sessionManager.ensureOnDisk(); await owner.sessionManager.flush();
      await post("save-restart", { sessionFile: owner.sessionManager.getSessionFile() });
      // Native placement opens its first worker at nine concurrent actual runs.
      // The loopback provider holds all first responses until every run arrives.
      const tasks = Array.from({ length: 9 }, (_, index) => {
        const id = `accept_${run}_${index}`; ids.push(id);
        return { agent: "task", name: id, model: "remote-task-smoke/probe", task: `ACCEPTANCE_TURN=${id}:initial`,
          solutionSpace: "One fixed loopback tool probe" };
      });
      const result = await invoke("task", { context: "Acceptance-only deterministic loopback tasks; no external model requests.", tasks });
      assert.equal(result.details.results?.length, 9, "Expected nine completed native task results, not background handles");
      for (const child of result.details.results) assert.equal(child.exitCode, 0, JSON.stringify(child));
      const evidence = await post("checkpoint", { phase: "fanout-complete" });
      const worker = evidence.observations.find((row: any) => ids.includes(row.id) && !row.isMainThread);
      assert(worker, "No actual worker-thread execution occurred");
      let id = worker.id;
      const initial = AgentRegistry.global().get(id)!;
      assert.equal(initial.status, "idle");
      assert.equal(initial.session!.instanceKey, worker.instanceKey, "Observer and authoritative registry disagree on session home");
      await lifecycle.park(id);
      assert.equal(AgentRegistry.global().get(id)!.status, "parked");
      assert.equal(AgentRegistry.global().get(id)!.session, null);
      await post("checkpoint", { phase: "parked", id });
      const agent = { name: "task", description: "Native task acceptance", systemPrompt: "Follow the deterministic acceptance assignment.", source: "project" as const };
      const follow = (phase: string, signal?: AbortSignal) => runSubagentFollowUpTurn({ id, agent,
        message: `ACCEPTANCE_TURN=${id}:${phase}`, structured: false, signal, completionProbe: false, softRequestBudget: 0, maxRuntimeMs: 90_000 });
      const revived = await follow("revived");
      assert.equal(revived.exitCode, 0, JSON.stringify(revived));
      assert.notEqual(AgentRegistry.global().get(id)!.session!.instanceKey, worker.instanceKey);
      await post("checkpoint", { phase: "revived", id });
      const controller = new AbortController();
      const interrupted = follow("interrupt", controller.signal);
      await post("await-interrupt", { id });
      controller.abort(new Error("Acceptance-only interrupt"));
      try {
        const outcome = await interrupted;
        assert(outcome.aborted, JSON.stringify(outcome));
      } finally { await post("release-interrupt", { id }); }
      assert.equal(AgentRegistry.global().get(id)!.status, "idle", "Interrupt must remain resumable");
      const continued = await follow("after-interrupt");
      assert.equal(continued.exitCode, 0, JSON.stringify(continued));
      await post("checkpoint", { phase: "interrupted-and-resumed", id });
      // Abruptly close the actual worker realm; do not dispose its session or
      // transport first, and do not use an unshared source-module pool singleton.
      assert.notEqual(AgentRegistry.global().get(id)!.session!.instanceKey.split(":")[0], "main");
      const crashing = follow("crash-service");
      const target = await post("await-crash-service", { id });
      await post("force-worker-stop", { id, instanceKey: target.instanceKey });
      const lost = await crashing.catch((error: unknown) => ({ exitCode: 1, error: String(error) }));
      assert.notEqual(lost.exitCode, 0, "Terminated worker unexpectedly completed its turn");
      const cleanup = await post("checkpoint", { phase: "worker-terminated", id });
      assert(cleanup.remoteCleanup && cleanup.sshStdinClosed, "Abrupt worker exit left an open transport, companion or service");
      assert(cleanup.localReaped || cleanup.unreapedSsh.every((row: any) => row.state === "Z" && !row.stdinOpen), "Unclassified local process survived");
      assert.equal((await invoke("remote_workspace_status", {})).details.mode, "remote", "Parent lost its binding with the child worker");
      // Keep the independent owner-exit contract on an untouched main-homed child.
      id = ids.find(candidate => candidate !== id && AgentRegistry.global().get(candidate)?.session?.instanceKey.startsWith("main:"))!;
      assert(id, "No live main-homed child remains for owner-exit acceptance");
      await commands.get("remote-exit")!.handler("--force", ctx); connected = false;
      await post("checkpoint", { phase: "owner-exited", id });
      const revoked = await follow("revoked");
      assert.equal(revoked.exitCode, 0, JSON.stringify(revoked));
      assert(revoked.output.includes("REVOKED_WORKSPACE_REJECTED"), "Child did not observe unavailable status and a rejected workspace write");
      const after = await post("checkpoint", { phase: "revoked-turn", id });
      assert(after.revokedToolDenied && after.localMarkerAbsent && after.noNewRemoteWorkers, "Owner exit did not preserve workspace revocation");
      console.log(cleanup.localReaped ? "TASK_SMOKE_PASS" : "TASK_SMOKE_PARTIAL", JSON.stringify({ tasks: 9, workerThread: worker.nativeThread, parkRevive: true, interruptResume: true, abruptWorkerExit: true, remoteCleanup: cleanup.remoteCleanup, sshStdinClosed: cleanup.sshStdinClosed, localReaped: cleanup.localReaped, ownerExitFailClosed: true }));
    } catch (error) {
      console.error("TASK_SMOKE_ERROR", error); process.exitCode = 1;
    } finally {
      for (const id of ids) await lifecycle.release(id).catch(error => { console.error("TASK_RELEASE_ERROR", error); process.exitCode = 1; });
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(error => { console.error(error); process.exitCode = 1; });
      owner.clearQueue();
      process.exit(process.exitCode ?? 0);
    }
  }});
}
