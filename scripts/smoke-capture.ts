// Native OMP acceptance with deterministic widget authoring, not a paid model.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
// build-smoke.ts bundles registry: the compiled host does not expose that subpath.
import { JobWidgets } from "@oh-my-pi/pi-coding-agent/job-widgets/registry";
import { renderJobWidgetLines } from "@oh-my-pi/pi-tui/tools/job-widget";
// @ts-expect-error Generated release bundle has no declaration file.
import extension from "../packages/omp/dist/extension.js";

export default async function captureSmoke(pi: ExtensionAPI) {
  const args = process.env.REMOTE_CONNECT_ARGS;
  if (!args) throw new Error("REMOTE_CONNECT_ARGS must specify a host and scratch cwd");
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const api = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name: string, command: any) => { commands.set(name, command); target.registerCommand(name, command); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await extension(api);
  pi.registerCommand("remote-capture-smoke", { description: "Check real SSH capture, widgets and automatic backgrounding", async handler(_, ctx) {
    const session = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session;
    assert(session, "Native session is required");
    const manager = session.asyncJobManager;
    assert(manager, "Native session job manager is required");
    // Completion delivery must not trigger an unrelated paid model turn in this probe.
    session.agent.continue = async () => {};
    const jobs = new Set<string>();
    let connected = false;
    const previousWidgets = manager.widgets;
    let testWidgets: JobWidgets | undefined;
    let unsubscribe = () => {};
    const invoke = async (name: string, input: object, onUpdate?: (result: any) => void) => {
      const tool = session.getToolByName(name);
      assert(tool, `Missing ${name}`);
      return tool.execute(crypto.randomUUID(), input, AbortSignal.timeout(45000), onUpdate, { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
    };
    const text = (r: any) => r.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
    const jobFor = (r: any) => {
      const id = r.details?.async?.jobId;
      assert.equal(typeof id, "string", "Expected background promotion, not a restarted/foreground command");
      jobs.add(id);
      const job = manager.getJob(id);
      assert(job, `Local job ${id} missing`);
      return job;
    };
    const resultText = async (r: any) => {
      if (!r.details?.async?.jobId) return text(r);
      const job = jobFor(r); await job.promise;
      assert.equal(job.status, "completed", job.errorText ?? "Remote job failed");
      return job.resultText ?? "";
    };
    const pipeline = '{ for n in 1 2 3; do printf "step=%s\\n" "$n"; sleep 0.2; done; sleep 1.5; } | tail -1';
    let pipelineJob: ReturnType<typeof manager.getJob>;
    const live = Promise.withResolvers<any>();
    const sourceVariable = `OMP_CAPTURE_STATE_${process.pid}`;
    try {
      const localHost = (await resultText(await invoke("bash", { command: "hostname" }))).split("\n")[0];
      await commands.get("remote-connect")!.handler(args, ctx); connected = true;
      const remoteHost = (await resultText(await invoke("bash", { command: "hostname" }))).split("\n")[0];
      assert.notEqual(remoteHost, localHost); console.log("CAPTURE_REMOTE_HOST", remoteHost);
      let authorCalls = 0;
      testWidgets = new JobWidgets({ minIngestMs: 0, authorAfterMs: 0, author: async request => {
        authorCalls++;
        assert(request.sources.some(source => source.id.startsWith("pipe:") && source.head.includes("step=1")));
        return { title: "remote steps", rules: [{ from: "pipe:*", match: "^step=(?<step>\\d+)$", count: "seen" }], blocks: [
          { kind: "meter", field: "step", agg: "last", total: 3, label: "steps" },
          { kind: "stat", items: [{ field: "seen", agg: "count", label: "matches" }] },
        ], headline: { field: "step", agg: "last", label: "step" } };
      } });
      manager.widgets = testWidgets;
      unsubscribe = testWidgets.subscribe(() => {
        if (pipelineJob) { const view = testWidgets!.view(pipelineJob); if (view?.state === "live") live.resolve(view); }
      });
      pipelineJob = jobFor(await invoke("bash", { command: pipeline, async: true, timeout: 0, i: "Capture three pipeline steps" }));
      testWidgets.view(pipelineJob);
      const view = await Promise.race([live.promise, pipelineJob.promise.then(() => { throw new Error("No native live widget before pipeline settled"); })]);
      assert.equal(pipelineJob.status, "running");
      assert.equal(view.blocks.find((b: any) => b.kind === "meter")?.value, 1);
      assert.equal(view.blocks.find((b: any) => b.kind === "stat")?.items[0].text, "3");
      const rendered = stripVTControlCharacters(renderJobWidgetLines(view, 80, ctx.ui.theme).join("\n"));
      assert(rendered.includes(view.blocks.find((b: any) => b.kind === "meter").text));
      console.log("NATIVE_REMOTE_WIDGET_PASS", JSON.stringify({ authorCalls, fraction: 1, matches: 3, rendered }));
      const pipeRead = await invoke("read", { path: `proc://${pipelineJob.id}/streams/1` });
      assert(text(pipeRead).includes("step=1") && text(pipeRead).includes("step=3"));
      await pipelineJob.promise;
      assert.equal(pipelineJob.status, "completed", pipelineJob.errorText ?? "Pipeline job failed");
      assert(pipelineJob.resultText?.includes("step=3") && !pipelineJob.resultText.includes("step=1"));
      assert.deepEqual(pipelineJob.process?.streams?.read(1)?.data, Buffer.from("step=1\nstep=2\nstep=3\n"));
      assert.deepEqual(pipelineJob.process?.pids(), []);
      console.log("PIPE_CAPTURE_EXACT_PASS", pipelineJob.id);
      unsubscribe(); testWidgets.dispose(); testWidgets = undefined; manager.widgets = previousWidgets;

      // Threshold comes from the probe's CLI config; no user settings are written.
      const auto = jobFor(await invoke("bash", { command: `${sourceVariable}=kept; printf 'AUTO_START\\n'; sleep 1.5; printf 'AUTO_DONE\\n'`, timeout: 0 }));
      await auto.promise; assert.equal(auto.status, "completed", auto.errorText ?? "Automatic background job failed");
      assert.equal(auto.resultText?.match(/AUTO_START/g)?.length, 1, "Command output was replayed or restarted");
      assert(auto.resultText?.includes("AUTO_DONE"));
      assert((await resultText(await invoke("bash", { command: `printf 'state=%s\\n' "$${sourceVariable}"`, timeout: 0 }))).includes("state=kept"));
      const isolated = jobFor(await invoke("bash", { command: `printf 'state=%s\\n' "\${${sourceVariable}:-unset}"`, async: true, timeout: 0 }));
      await isolated.promise; assert.equal(isolated.status, "completed", isolated.errorText ?? "Isolated job failed");
      assert(isolated.resultText?.includes("state=unset"));
      console.log("AUTO_BACKGROUND_PERSISTENCE_PASS");
      const cancel = jobFor(await invoke("bash", { command: "printf 'CANCEL_READY\\n'; sleep 30; printf 'NEVER_AFTER_CANCEL'", timeout: 0 }));
      await invoke("write", { path: `proc://${cancel.id}/kill`, content: "" }); await cancel.promise;
      assert.equal(cancel.status, "cancelled");
      assert(!cancel.widgetInputs!.sources().find(source => source.id === "out")!.read(0).text.includes("NEVER_AFTER_CANCEL"));
      assert(cancel.widgetInputs!.sources().every(source => !source.read(0).open));
      console.log("AUTO_BACKGROUND_CANCEL_PASS");
      await commands.get("remote-exit")!.handler("", ctx); connected = false;
      assert.equal((await resultText(await invoke("bash", { command: "hostname" }))).split("\n")[0], localHost);
      assert.deepEqual(pipelineJob.process?.streams?.read(1)?.data, Buffer.from("step=1\nstep=2\nstep=3\n"));
      console.log("CAPTURE_SMOKE_PASS: exact pre-tail bytes, native widget numbers/rendering, automatic promotion, shell isolation, cancellation and retained local streams verified. Widget authoring used a deterministic model boundary, not a provider call.");
      process.exitCode = 0;
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      unsubscribe(); testWidgets?.dispose(); manager.widgets = previousWidgets;
      for (const id of jobs) manager.cancel(id);
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(console.error);
      await Promise.all([...jobs].map(id => manager.getJob(id)?.promise));
      process.exit(process.exitCode ?? 0);
    }
  } });
}
