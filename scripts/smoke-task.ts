// Native TaskTool acceptance; build with build-smoke.ts, launch with run-task-acceptance.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isMainThread, threadId } from "node:worker_threads";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent/task/executor";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { z } from "@oh-my-pi/omptype/zod";
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
  const nativeSessions = new Map<string, any>();
  pi.registerTool({
    name: "task_acceptance_capture",
    label: "Task acceptance capture",
    description: "Measure retained output and pipe windows in this isolated native child session.",
    parameters: z.object({}),
    loadMode: "essential",
    async execute(_id, _params, signal, _onUpdate, ctx) {
      assert(ctx?.agent.kind === "sub" && isMainThread && threadId === 0, "Capture must execute in the same-thread native child");
      const native = nativeSessions.get(ctx.agent.id);
      assert(native && isLocalAgentSession(native));
      const manager = native.asyncJobManager;
      assert(manager, "The native child session must inherit its root async-job manager");
      const originalBridge = native.clientBridge;
      native.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
      let jobId: string | undefined;
      const deadline = Promise.withResolvers<never>();
      const timer = setTimeout(() => deadline.reject(new Error("Native child capture did not settle in 40s")), 40_000);
      try {
        const sentinel = `TASK_CAPTURE_END_${run}`;
        const command = `python3 -c 'import sys; sys.stdout.write("X" * (3 * 1024 * 1024) + "\\n${sentinel}\\n")' | cat`;
        const bash = native.getToolByName("bash");
        assert(bash, "The native child session must expose its remote Bash wrapper");
        const result = await bash.execute(crypto.randomUUID(),
          { command, async: true, timeout: 0 }, signal, undefined,
          { ...ctx, hasUI: false, settings: native.settings, sessionManager: native.sessionManager,
            toolNames: pi.getActiveTools(), hasQueuedMessages: () => ctx.hasPendingMessages() });
        assert(!result.isError, JSON.stringify(result));
        const registeredId = result.details?.async?.jobId;
        assert(typeof registeredId === "string", "The actual remote Bash wrapper must register a native background job");
        jobId = registeredId;
        const pending = manager.getJob(registeredId); assert(pending);
        manager.watchJobs([registeredId]);
        await Promise.race([pending.promise, deadline.promise]);
        const job = manager.getJob(registeredId); assert(job);
        assert.equal(job.status, "completed", job.errorText ?? "Capture job failed");
        const sources = job.widgetInputs?.sources(); assert(sources);
        const output = sources.find((source: any) => source.id === "out")?.read(0);
        const pipe = sources.find((source: any) => source.id === "pipe:1")?.read(0);
        assert(output && pipe, "Native retained output and pipe sources are both required");
        const suffix = `\n${sentinel}\n`;
        const emittedBytes = 3 * 1024 * 1024 + Buffer.byteLength(suffix, "utf8");
        const emittedUnits = 3 * 1024 * 1024 + suffix.length;
        const outputUnits = 256 * 1024, pipeBytes = 1024 * 1024;
        // Expected retained content comes only from the fixture's known ASCII
        // producer, never from a slice of the observed output or pipe source.
        const expectedOutput = "X".repeat(outputUnits - suffix.length) + suffix;
        const expectedPipe = "X".repeat(pipeBytes - Buffer.byteLength(suffix, "utf8")) + suffix;
        const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
        const outputHash = hash(output.text), pipeHash = hash(pipe.text);
        const expectedOutputHash = hash(expectedOutput), expectedPipeHash = hash(expectedPipe);
        assert.equal(output.text.length, outputUnits, "Output window is measured in UTF-16 units");
        assert.equal(output.start, emittedUnits - outputUnits);
        assert.equal(output.end, emittedUnits);
        assert.equal(output.end - output.start, outputUnits);
        assert.equal(outputHash, expectedOutputHash, "Every retained output unit must match the independently constructed ASCII window");
        assert.equal(Buffer.byteLength(pipe.text, "utf8"), pipeBytes, "ASCII pipe window is measured in bytes");
        assert.equal(pipe.start, emittedBytes - pipeBytes);
        assert.equal(pipe.end, emittedBytes);
        assert.equal(pipe.end - pipe.start, pipeBytes);
        assert.equal(pipeHash, expectedPipeHash, "Every retained pipe byte must match the independently constructed ASCII window");
        assert(!output.open && !pipe.open);
        assert(output.text.endsWith(`${sentinel}\n`) && pipe.text.endsWith(`${sentinel}\n`));
        const evidence = { id: ctx.agent.id, instanceKey: native.instanceKey, isMainThread, threadId, jobId,
          output: { start: output.start, end: output.end, retainedUnits: output.text.length, sha256: outputHash,
            expected: { start: emittedUnits - outputUnits, end: emittedUnits, retainedUnits: outputUnits, sha256: expectedOutputHash } },
          pipe: { start: pipe.start, end: pipe.end, retainedBytes: Buffer.byteLength(pipe.text, "utf8"), sha256: pipeHash,
            expected: { start: emittedBytes - pipeBytes, end: emittedBytes, retainedBytes: pipeBytes, sha256: expectedPipeHash } },
          emittedBytes, emittedUnits, sentinelRetained: true };
        return { content: [{ type: "text", text: JSON.stringify(evidence) }], details: evidence };
      } finally {
        clearTimeout(timer);
        if (jobId) {
          if (manager.getJob(jobId)?.status === "running") manager.cancel(jobId);
          manager.consumeJobResults([jobId]);
          manager.unwatchJobs([jobId]);
        }
        native.setClientBridge(originalBridge);
      }
    },
  });
  // Installed in every native child, after remote's session_start handler. The
  // observation comes from the executing JS realm, not from placement settings.
  pi.on("session_start", async (_, ctx) => {
    if (ctx.agent.kind !== "sub") return;
    const session = AgentRegistry.global().get(ctx.agent.id)?.session;
    assert(session && isLocalAgentSession(session), "Child observer must run on the child's home thread");
    const native = session as any;
    nativeSessions.set(ctx.agent.id, native);
    const status = await native.getToolByName("remote_workspace_status").execute(crypto.randomUUID(), {}, AbortSignal.timeout(40_000));
    // ReadTool opens procfs in the companion itself; Bash runs under the native
    // daemon and therefore cannot identify its companion with `$PPID`.
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
  pi.registerCommand("remote-task-smoke", { description: "Verify same-thread native tasks and remote lifecycle", async handler(_, ctx) {
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
    const id = `accept_${run}`;
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
      const tasks = [{ agent: "task", name: id, model: "remote-task-smoke/probe", task: `ACCEPTANCE_TURN=${id}:initial`,
        solutionSpace: "One fixed loopback tool probe" }];
      const result = await invoke("task", { context: "Acceptance-only deterministic loopback tasks; no external model requests.", tasks });
      assert.equal(result.details.results?.length, 1, "Expected one completed native task result, not a background handle");
      assert.equal(result.details.results[0].exitCode, 0, JSON.stringify(result.details.results[0]));
      const evidence = await post("checkpoint", { phase: "initial-complete" });
      const child = evidence.observations.find((row: any) => row.id === id);
      assert(child?.isMainThread && child.threadId === 0, "Missing same-thread child execution");
      const initial = AgentRegistry.global().get(id)!;
      assert.equal(initial.status, "idle");
      assert.equal(initial.session!.instanceKey, child.instanceKey, "Observer and authoritative registry disagree on session instance");
      const agent = { name: "task", description: "Native task acceptance", systemPrompt: "Follow the deterministic acceptance assignment.", source: "project" as const };
      const follow = (phase: string, signal?: AbortSignal) => runSubagentFollowUpTurn({ id, agent,
        message: `ACCEPTANCE_TURN=${id}:${phase}`, signal, completionProbe: false, softRequestBudget: 0, maxRuntimeMs: 90_000 });
      await post("checkpoint", { phase: "before-child-reconnect", id });
      const reconnected = await follow("reconnect");
      assert.equal(reconnected.exitCode, 0, JSON.stringify(reconnected));
      assert(reconnected.output.includes("CHILD_RECONNECT_VERIFIED"));
      const normal = await post("checkpoint", { phase: "child-reconnect", id });
      assert(normal.reconnectVerified && normal.nestedEvalVerified && normal.captureEvidence?.sentinelRetained);
      await lifecycle.park(id);
      assert.equal(AgentRegistry.global().get(id)!.status, "parked");
      assert.equal(AgentRegistry.global().get(id)!.session, null);
      await post("checkpoint", { phase: "parked", id });
      const revived = await follow("revived");
      assert.equal(revived.exitCode, 0, JSON.stringify(revived));
      assert.notEqual(AgentRegistry.global().get(id)!.session!.instanceKey, child.instanceKey);
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
      const parentStatus = (await invoke("remote_workspace_status", {})).details;
      assert.equal(parentStatus.mode, "remote", "Child lifecycle changed the parent's remote binding");
      const parentProbe = await invoke("bash", { command: `printf 'PARENT_STILL_USABLE_${run}\\n'; pwd; printf 'SESSION=%s\\n' "$PI_SESSION_ID"` });
      const parentOutput = parentProbe.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      assert(parentOutput.includes(`PARENT_STILL_USABLE_${run}`) && parentOutput.includes(owner.sessionManager.getSessionId()) &&
        typeof parentStatus.remoteCwd === "string" && parentOutput.includes(parentStatus.remoteCwd),
        "The parent's actual remote Bash connection must remain usable after child reconnect and revival");
      await post("checkpoint", { phase: "parent-connection-usable", id });
      await commands.get("remote-exit")!.handler("--force", ctx); connected = false;
      await post("checkpoint", { phase: "owner-exited", id });
      const revoked = await follow("revoked");
      assert.equal(revoked.exitCode, 0, JSON.stringify(revoked));
      assert(revoked.output.includes("REVOKED_WORKSPACE_REJECTED"), "Child did not observe unavailable status and a rejected workspace write");
      const after = await post("checkpoint", { phase: "revoked-turn", id });
      assert(after.revokedToolDenied && after.localMarkerAbsent && after.noNewRemoteWorkers, "Owner exit did not preserve workspace revocation");
      console.log("TASK_SMOKE_PASS", JSON.stringify({ tasks: 1, mainThread: true, childReconnect: true, nestedEvalCallback: true, boundedCapture: normal.captureEvidence, parkRevive: true, interruptResume: true, parentConnectionUsable: true, ownerExitFailClosed: true }));
    } catch (error) {
      console.error("TASK_SMOKE_ERROR", error); process.exitCode = 1;
    } finally {
      await lifecycle.release(id).catch(error => { console.error("TASK_RELEASE_ERROR", error); process.exitCode = 1; });
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(error => { console.error(error); process.exitCode = 1; });
      owner.clearQueue();
      process.exit(process.exitCode ?? 0);
    }
  }});
}
