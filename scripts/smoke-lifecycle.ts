// Bundle and run inside native OMP; no model requests are made.
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
// @ts-expect-error Generated release bundle has no declaration file.
import extension from "../packages/omp/dist/extension.js";

export default async function lifecycleSmoke(pi: ExtensionAPI) {
  const args = process.env.REMOTE_CONNECT_ARGS;
  if (!args) throw new Error("REMOTE_CONNECT_ARGS must specify a test host and scratch cwd");
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const api = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name: string, command: any) => { commands.set(name, command); target.registerCommand(name, command); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  await extension(api);
  pi.registerCommand("remote-lifecycle-smoke", { description: "Verify upgrade lifecycle in native OMP", async handler(_, ctx) {
    const session = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session;
    if (!session) throw new Error("Native session not registered");
    // Exercise real jobs without allowing their completion callbacks to start
    // an unrelated model turn while this model-free command owns the session.
    const originalBridge = session.clientBridge;
    session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
    const originalInterruptMode = session.interruptMode;
    session.agent.setInterruptMode("immediate");
    const manager = session.asyncJobManager; assert(manager);
    const diagnosticStart = performance.now();
    const diagnostics: object[] = [];
    let phase = "setup";
    const record = (event: string, details: object = {}) => {
      diagnostics.push({
        event, phase, elapsedMs: performance.now() - diagnosticStart, ...details,
        jobs: manager.getAllJobs().map(job => ({
          id: job.id, type: job.type, label: job.label, ownerId: job.ownerId,
          status: job.status, consumed: manager.isJobResultConsumed(job.id),
          deliverySuppressed: manager.isDeliverySuppressed(job.id),
          resultText: job.resultText, errorText: job.errorText,
        })),
        queuedAsyncResult: session.yieldQueue.has("async-result"),
        deliverableAsyncResult: session.yieldQueue.hasDeliverable("async-result"),
      });
    };
    let unexpectedModelTurns = 0;
    // The native yield queue can call raw prompt even when bridge turns are deferred.
    // This one-off acceptance process must never contact a provider.
    session.agent.prompt = async (...promptArgs) => {
      unexpectedModelTurns++;
      const error = new Error("Unexpected model turn in lifecycle acceptance");
      record("unexpected-prompt", { promptArgs, stack: error.stack });
      console.error("LIFECYCLE_PROMPT_DIAGNOSTICS", JSON.stringify(diagnostics));
      throw error;
    };
    const text = (r: any): string => r.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
    const invoke = async (name: string, params: object, onUpdate?: (result: any) => void, signal?: AbortSignal) => {
      phase = `tool:${name}`;
      record("invoke", { name, params });
      try {
        const tool = session.getToolByName(name); assert(tool, `Missing tool ${name}`);
        const timeout = AbortSignal.timeout(40000);
        const result = await tool.execute(crypto.randomUUID(), params, signal ? AbortSignal.any([signal, timeout]) : timeout, onUpdate, { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
        record("returned", { name, details: result.details });
        return result;
      } catch (error) {
        record("invoke-error", { name, error: error instanceof Error ? error.stack : String(error) });
        throw error;
      } finally {
        phase = `after:${name}`;
      }
    };
    const waitForGatedJob = async (jobId: string, gate: string) => {
      const release = Promise.withResolvers<void>();
      const stopWait = new AbortController();
      let releasing = false;
      // Native wait emits its initial progress only after watchJobs. Keep the
      // producer blocked until that actual claim, even during a cold refresh.
      const waiting = invoke("wait", {}, update => {
        if (releasing) return;
        releasing = true;
        void (async () => {
          assert(update.details?.jobs?.some((job: { id: string }) => job.id === jobId), `Wait did not claim ${jobId}`);
          assert(manager.isDeliverySuppressed(jobId), `Wait did not watch ${jobId}`);
          record("native-wait-watched", { jobId, gate });
          const result = await invoke("bash", { command: `printf 'release\\n' > '${gate}'` }, undefined, stopWait.signal);
          assert(!result.isError, text(result));
        })().then(release.resolve, release.reject);
      }, stopWait.signal);
      void waiting.then(() => {
        if (!releasing) release.reject(new Error(`Wait returned without claiming ${jobId}`));
      }, error => {
        if (!releasing) release.reject(error);
      });
      try {
        const [result] = await Promise.all([waiting, release.promise]);
        assert(manager.isJobResultConsumed(jobId), `Wait did not consume ${jobId}`);
        return result;
      } catch (error) {
        manager.cancel(jobId);
        throw error;
      } finally {
        stopWait.abort();
        await Promise.allSettled([waiting, release.promise]);
      }
    };
    const tag = `omp-upgrade-${process.pid}`;
    const file = `/tmp/${tag}.txt`;
    const asyncGate = `/tmp/${tag}-async.fifo`;
    const serviceGate = `/tmp/${tag}-service.fifo`;
    const service = `${tag}-service`;
    let connected = false;
    try {
      const local = text(await invoke("bash", { command: "hostname" })).trim();
      const readTool = session.getToolByName("read"); assert(readTool?.approvalCacheTargets);
      const beforeArgs = { path: file };
      assert(readTool.approvalCacheTargets(beforeArgs)?.some(target => target.startsWith("/")));
      const began = performance.now();
      phase = "command:remote-connect";
      record("connect");
      await commands.get("remote-connect")!.handler(args, ctx); connected = true;
      console.log("LIFECYCLE_CONNECT_MS", performance.now() - began);
      const remote = text(await invoke("bash", { command: "hostname" })).trim();
      assert.notEqual(remote, local);
      console.log("REMOTE_HOST", remote);
      const remoteArgs = { path: file };
      const scoped = readTool.approvalCacheTargets(remoteArgs); assert(scoped?.[0]?.startsWith("remote-request\0"));
      assert.throws(() => readTool.approvalCacheTargets!(beforeArgs), /binding changed/);
      console.log("APPROVAL_SCOPE_PASS");
      const expectedIdentity = `SESSION_ID=${ctx.sessionManager.getSessionId()}\nSESSION_FILE=<>\n`;
      const identityCommand = 'printf "SESSION_ID=%s\\nSESSION_FILE=<%s>\\n" "$PI_SESSION_ID" "$PI_SESSION_FILE"';
      assert(text(await invoke("bash", { command: identityCommand })).includes(expectedIdentity));
      console.log("SESSION_ENV_DIRECT_PASS");
      await invoke("write", { path: file, content: "first\n" });
      const read = text(await invoke("read", { path: file }));
      const header = read.match(/\[[^\]\n]+#[A-F0-9]+\]/)?.[0]; assert(header);
      await invoke("edit", { input: `${header}\nPUT 1.=1:\n+second` });
      assert(text(await invoke("read", { path: file })).includes("second"));
      for (const language of ["js", "py"]) assert(text(await invoke("eval", { language, code: "print(6 * 7)", title: "upgrade compute" })).includes("42"));
      assert(text(await invoke("lsp", { action: "status" })).length > 0);
      const output = text(await invoke("bash", { command: "seq 1 20000" }));
      const uri = output.match(/remote-artifact:\/\/[a-f0-9-]+\/\d+/)?.[0]; assert(uri);
      assert(text(await invoke("read", { path: `${uri}:19999-20000` })).includes("20000"));
      console.log("CORE_EVAL_ARTIFACT_PASS");

      const patterns = lookup("bash.patterns"); assert(patterns);
      const previousPatterns = patterns.get(session.settings);
      const deniedCommand = "printf REMOTE_NESTED_DENY_SENTINEL";
      patterns.override(session.settings, [{ match: deniedCommand, approval: "deny" }]);
      try {
        const direct = await invoke("bash", { command: deniedCommand }).catch(error => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
        assert(direct.isError, "Direct denied command executed");
        assert.match(text(direct), /blocked by tool policy/);
        const nested = await invoke("eval", { language: "js", code: `const result = await tool.bash({command: ${JSON.stringify(deniedCommand)}}); print(result.text);`, title: "nested approval" })
          .catch(error => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
        assert(nested.isError, "Nested command skipped native denial");
        assert.match(text(nested), /blocked by tool policy/);
        console.log("NESTED_NATIVE_APPROVAL_PASS");
      } finally {
        patterns.override(session.settings, previousPatterns);
      }
      const nestedRead = await invoke("eval", { language: "js", code: `print((await tool.read({path: ${JSON.stringify(file)}})).text);`, title: "nested read roundtrip" });
      assert(!nestedRead.isError, text(nestedRead));
      assert(text(nestedRead).includes("second"));
      console.log("NESTED_REMOTE_ROUNDTRIP_PASS");

      const frames: any[] = [];
      const gates = await invoke("bash", { command: `export OMP_SMOKE_SCOPE=foreground; mkfifo -- '${asyncGate}' '${serviceGate}'` });
      assert(!gates.isError, text(gates));
      const liveOutput = Promise.withResolvers<void>();
      const jobResult = await invoke("bash", { name: "  ", command: `${identityCommand}; printf "ASYNC_SCOPE=%s\\n" "\${OMP_SMOKE_SCOPE-unset}"; export OMP_SMOKE_SCOPE=background; printf LIVE_OUTPUT; IFS= read -r _ < '${asyncGate}'; printf DONE_OUTPUT`, async: true }, update => {
        frames.push(update);
        if (update.details?.async?.state === "running" && text(update).includes("LIVE_OUTPUT")) liveOutput.resolve();
      });
      const jobId = (jobResult.details as any)?.async?.jobId; assert(jobId);
      // Observe the running frame before releasing the producer, rather than
      // assuming output callbacks beat a short sleep or the wait callback.
      const liveTimeout = setTimeout(() => liveOutput.reject(new Error(`No live output from ${jobId}`)), 40000);
      try {
        await liveOutput.promise;
      } catch (error) {
        manager.cancel(jobId);
        throw error;
      } finally {
        clearTimeout(liveTimeout);
      }
      const waited = text(await waitForGatedJob(jobId, asyncGate));
      assert(waited.includes(jobId));
      record("async-wait-returned", { jobId });
      const job = manager.getJob(jobId); assert(job); await job.promise;
      assert.equal(job.status, "completed");
      assert(job.resultText?.includes("ASYNC_SCOPE=unset"));
      assert(job.resultText?.includes(expectedIdentity));
      console.log("SESSION_ENV_ASYNC_PASS");
      assert(text(await invoke("bash", { command: 'printf "%s" "$OMP_SMOKE_SCOPE"' })).includes("foreground"));
      assert(frames.some(f => f.details?.async?.state === "running" && text(f).includes("LIVE_OUTPUT")));
      assert.equal(frames.at(-1)?.details?.async?.state, "completed");
      assert(text(frames.at(-1)).includes("DONE_OUTPUT"));
      console.log("ASYNC_LIVE_WAIT_PASS");

      console.log("SERVICE_STEER_MODE", session.interruptMode);
      const launching = invoke("bash", { name: service, command: "echo SERVICE_BOOT; sleep 30", pty: false, ready: { log: "NEVER_READY", timeout: 20 } });
      session.agent.steer({ role: "user", content: [{ type: "text", text: "Acceptance-only readiness steer" }], timestamp: Date.now() });
      let started;
      try { started = await launching; } catch (error) { throw new Error("Service readiness invocation failed", { cause: error }); } finally {
        assert(session.takeQueuedMessage("Acceptance-only readiness steer", "steering"), "Synthetic steering was unexpectedly dequeued");
      }
      assert(text(started).includes("Readiness wait interrupted"));
      console.log("SERVICE_READINESS_RETURNED", text(started));
      assert(text(await invoke("read", { path: `proc://${service}` })).includes("starting"));
      const listing = await invoke("read", { path: "proc://" });
      assert((listing.details as any)?.proc?.daemons?.some((daemon: any) => daemon.name === service));
      await assert.rejects(() => invoke("grep", { path: `proc://${jobId};proc://${service}`, pattern: "SERVICE" }), /Mixed local and remote/);
      console.log("PROCESS_ROUTING_PASS");
      console.log("SERVICE_PROC_READ_PASS");
      const serviceJob = manager.getAllJobs().find(j => j.label === `Remote service: ${service}`); assert(serviceJob);
      // This slash command is outside the native streaming loop. Claim the
      // result before stopping it, as native wait does: watch, recover, consume,
      // then unwatch. Consuming only after kill returns leaves an idle-yield gap.
      manager.watchJobs([serviceJob.id]);
      record("stop-watched", { jobId: serviceJob.id });
      try {
        const stopped = await invoke("eval", { language: "js", code: `print((await tool.write({path: ${JSON.stringify(`proc://${service}/kill`)}, content: ""})).text);`, title: "nested service stop" });
        assert(!stopped.isError, text(stopped));
        console.log("SERVICE_STOP_PASS");
        await serviceJob.promise;
        assert.equal(serviceJob.status, "completed");
        assert(serviceJob.resultText?.includes('"operation":"stop"'));
        record("before-stop-consume", { jobId: serviceJob.id });
        manager.consumeJobResults([serviceJob.id]);
        assert(manager.isJobResultConsumed(serviceJob.id));
        record("after-stop-consume", { jobId: serviceJob.id });
      } finally {
        manager.unwatchJobs([serviceJob.id]);
        record("stop-unwatched", { jobId: serviceJob.id });
      }
      console.log("SERVICE_STOP_TRACKING_PASS");
      const shortService = `${tag}-short`;
      const nestedService = await invoke("eval", { language: "js", code: `print((await tool.bash(${JSON.stringify({ name: shortService, command: `echo SHORT_READY; IFS= read -r _ < '${serviceGate}'; exit 7`, pty: false, ready: { log: "SHORT_READY", timeout: 5 } })})).text);`, title: "nested service launch" });
      assert(!nestedService.isError, text(nestedService));
      const shortJob = manager.getAllJobs().find(j => j.label === `Remote service: ${shortService}`); assert(shortJob);
      const waitedService = await waitForGatedJob(shortJob.id, serviceGate);
      const completed = (waitedService.details as { jobs?: { id: string; status: string; resultText?: string }[] })?.jobs?.find(j => j.id === shortJob.id);
      assert(completed, JSON.stringify(waitedService.details));
      assert.equal(completed.status, "completed", JSON.stringify(waitedService.details));
      assert(completed.resultText?.includes('"exitCode":7'));
      record("natural-wait-returned", { jobId: shortJob.id });
      console.log("SERVICE_NATURAL_EXIT_PASS");
      const removed = await invoke("bash", { command: `rm -- '${file}' '${asyncGate}' '${serviceGate}'` });
      assert(!removed.isError, text(removed));
      phase = "command:remote-exit";
      record("disconnect");
      await commands.get("remote-exit")!.handler("", ctx); connected = false;
      assert.equal(text(await invoke("bash", { command: "hostname" })).trim(), local);
      assert.throws(() => readTool.approvalCacheTargets!(remoteArgs), /binding changed/);
      assert(readTool.approvalCacheTargets({ path: file })?.some(target => target.startsWith("/")));
      for (const language of ["js", "py"]) {
        const marker = `${tag}-local-${language}`;
        const result = await invoke("eval", { language, code: `print(${JSON.stringify(marker)})`, title: `local ${language} restored` });
        assert(!result.isError, text(result));
        assert(text(result).includes(marker), `Local ${language} eval did not return its marker`);
      }
      console.log("LOCAL_EVAL_RESTORED_PASS");
      assert.equal(unexpectedModelTurns, 0, "An unconsumed completion tried to start a model turn");
      console.log("LIFECYCLE_SMOKE_PASS");
      process.exitCode = 0;
    } catch (error) {
      record("smoke-error");
      console.error("LIFECYCLE_JOB_DIAGNOSTICS", JSON.stringify(diagnostics));
      await Bun.write(Bun.stderr, `LIFECYCLE_SMOKE_ERROR ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
    finally {
      session.clearQueue();
      if (connected) {
        await invoke("write", { path: `proc://${service}/kill`, content: "" }).catch(() => {});
        await invoke("bash", { command: `rm -f -- '${file}' '${asyncGate}' '${serviceGate}'` }).catch(() => {});
        await commands.get("remote-exit")!.handler("--force", ctx).catch(console.error);
      }
      session.setClientBridge(originalBridge);
      session.agent.setInterruptMode(originalInterruptMode);
      process.exit(process.exitCode ?? 0);
    }
  }});
}
