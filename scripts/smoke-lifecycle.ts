// Bundle and run inside native OMP; no model requests are made.
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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
    const text = (r: any): string => r.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
    const invoke = async (name: string, params: object, onUpdate?: (result: any) => void) => {
      const tool = session.getToolByName(name); assert(tool, `Missing tool ${name}`);
      return tool.execute(crypto.randomUUID(), params, AbortSignal.timeout(40000), onUpdate, { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
    };
    const tag = `omp-upgrade-${process.pid}`;
    const file = `/tmp/${tag}.txt`;
    const service = `${tag}-service`;
    let connected = false;
    try {
      const local = text(await invoke("bash", { command: "hostname" })).trim();
      const began = performance.now();
      await commands.get("remote-connect")!.handler(args, ctx); connected = true;
      console.log("LIFECYCLE_CONNECT_MS", performance.now() - began);
      const remote = text(await invoke("bash", { command: "hostname" })).trim();
      assert.notEqual(remote, local);
      console.log("REMOTE_HOST", remote);
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

      const frames: any[] = [];
      const jobResult = await invoke("bash", { command: "printf LIVE_OUTPUT; sleep 0.3; printf DONE_OUTPUT", async: true }, update => frames.push(update));
      const jobId = (jobResult.details as any)?.async?.jobId; assert(jobId);
      const waited = text(await invoke("wait", {}));
      assert(waited.includes(jobId));
      const manager = session.asyncJobManager; assert(manager);
      const job = manager.getJob(jobId); assert(job); await job.promise;
      assert.equal(job.status, "completed");
      assert(frames.some(f => f.details?.async?.state === "running" && text(f).includes("LIVE_OUTPUT")));
      assert.equal(frames.at(-1)?.details?.async?.state, "completed");
      assert(text(frames.at(-1)).includes("DONE_OUTPUT"));
      console.log("ASYNC_LIVE_WAIT_PASS");

      console.log("SERVICE_STEER_MODE", session.interruptMode);
      const launching = invoke("bash", { name: service, command: "echo SERVICE_BOOT; sleep 30", pty: false, ready: { log: "NEVER_READY", timeout: 20 } });
      session.agent.steer({ role: "user", content: [{ type: "text", text: "Acceptance-only readiness steer" }], timestamp: Date.now() });
      let started;
      try { started = await launching; } catch (error) { throw new Error("Service readiness invocation failed", { cause: error }); } finally { session.clearQueue(); }
      assert(text(started).includes("Readiness wait interrupted"));
      console.log("SERVICE_READINESS_RETURNED", text(started));
      assert(text(await invoke("read", { path: `proc://${service}` })).includes("starting"));
      console.log("SERVICE_PROC_READ_PASS");
      await invoke("write", { path: `proc://${service}/kill`, content: "" });
      console.log("SERVICE_STOP_PASS");
      const serviceJob = manager.getAllJobs().find(j => j.label === `Remote service: ${service}`); assert(serviceJob);
      await serviceJob.promise;
      assert.equal(serviceJob.status, "completed");
      assert(serviceJob.resultText?.includes('"operation":"stop"'));
      console.log("SERVICE_STOP_TRACKING_PASS");
      const shortService = `${tag}-short`;
      await invoke("bash", { name: shortService, command: "echo SHORT_READY; sleep 1; exit 7", pty: false, ready: { log: "SHORT_READY", timeout: 5 } });
      const completed = text(await invoke("wait", {}));
      assert(completed.includes(shortService));
      assert(completed.includes('"exitCode":7'));
      console.log("SERVICE_NATURAL_EXIT_PASS");
      await invoke("bash", { command: `rm -- '${file}'` });
      await commands.get("remote-exit")!.handler("", ctx); connected = false;
      assert.equal(text(await invoke("bash", { command: "hostname" })).trim(), local);
      console.log("LIFECYCLE_SMOKE_PASS");
      process.exitCode = 0;
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      session.clearQueue();
      if (connected) {
        await invoke("write", { path: `proc://${service}/kill`, content: "" }).catch(() => {});
        await invoke("bash", { command: `rm -f -- '${file}'` }).catch(() => {});
        await commands.get("remote-exit")!.handler("--force", ctx).catch(console.error);
      }
      session.setClientBridge(originalBridge);
      session.agent.setInterruptMode(originalInterruptMode);
      process.exit(process.exitCode ?? 0);
    }
  }});
}
