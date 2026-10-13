// Run with native OMP, not Bun's SDK shim. See the package README.
import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
// @ts-expect-error Generated release bundle intentionally has no declaration file.
import extension from "../packages/omp/dist/extension.js";

export default async function cacheSmoke(pi: ExtensionAPI) {
  const args = process.env.REMOTE_CONNECT_ARGS;
  if (!args) throw new Error("REMOTE_CONNECT_ARGS must specify a test host and scratch cwd");
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const api = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name: string, command: any) => { commands.set(name, command); target.registerCommand(name, command); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  await extension(api);
  const requests: any[] = [];
  // Real HTTP serialization, synthetic answers. No provider credentials or paid
  // model calls, and no fabricated usage/cached-token statistics.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json());
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "cache-probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "ACK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }});
  pi.registerProvider("remote-cache-smoke", { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "smoke-local-only", api: "openai-completions", models: [{ id: "cache-probe", name: "Cache probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32 }] });
  pi.on("session_shutdown", () => { server.stop(true); });
  pi.registerCommand("remote-cache-smoke", { description: "Verify actual OMP wire prefixes without a paid model", async handler(_, ctx) {
    const session = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session;
    if (!session) throw new Error("Native session not registered");
    let connected = false;
    const fixture = `/tmp/omp-cache-smoke-${process.pid}.txt`;
    const invoke = async (name: string, input: object, onUpdate?: (result: any) => void) => {
      const tool = session.getToolByName(name);
      if (!tool) throw new Error(`Missing ${name}`);
      return tool.execute(crypto.randomUUID(), input, AbortSignal.timeout(30000), onUpdate, { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
    };
    const text = (r: any) => r.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const turn = async (label: string) => {
      const before = requests.length;
      await session.prompt(`Reply ACK only. ${label}`);
      assert.equal(requests.length, before + 1, "one provider request per prompt");
      const current = requests.at(-1);
      if (requests.length > 1) {
        const previous = requests.at(-2);
        assert.equal(JSON.stringify(current.tools), JSON.stringify(previous.tools), `${label}: wire tool definitions/order changed`);
        assert.equal(JSON.stringify(current.messages.slice(0, previous.messages.length)), JSON.stringify(previous.messages), `${label}: previously sent message prefix changed`);
        assert.equal(JSON.stringify(current.messages.filter((m: any) => ["system", "developer"].includes(m.role))), JSON.stringify(previous.messages.filter((m: any) => ["system", "developer"].includes(m.role))), `${label}: system/developer prefix changed`);
      }
      console.log(`WIRE_PREFIX_PASS ${label} messages=${current.messages.length} tools=${current.tools?.length}`);
    };
    try {
      const model = ctx.modelRegistry.find("remote-cache-smoke", "cache-probe");
      assert(model); assert(await pi.setModel(model));
      const local = text(await invoke("bash", { command: "hostname" })).split("\n")[0];
      await invoke("write", { path: fixture, content: "LOCAL_FIXTURE\n" });
      assert(text(await invoke("read", { path: fixture })).includes("LOCAL_FIXTURE"));
      const verifyApproval = async () => {
        if (!process.env.CACHE_SMOKE_DENY_COMMAND) return;
        let denied = false;
        try { const result = await invoke("bash", { command: process.env.CACHE_SMOKE_DENY_COMMAND }); denied = result.isError === true; }
        catch (error) { denied = /Blocked by bash pattern|denied|rejected/i.test(String(error)); }
        assert(denied, "native configured bash denial was bypassed");
      };
      await verifyApproval();
      await turn("local");
      await turn("local-unchanged");
      await commands.get("remote-connect")!.handler(args, ctx); connected = true;
      const remote = text(await invoke("bash", { command: "hostname" })).split("\n")[0];
      assert.notEqual(remote, local);
      await verifyApproval();
      await invoke("write", { path: fixture, content: "REMOTE_FIXTURE\n" });
      assert(text(await invoke("read", { path: fixture })).includes("REMOTE_FIXTURE"));
      await invoke("bash", { command: `rm -- '${fixture}'` });
      await turn("connected");
      await turn("remote-unchanged");
      await commands.get("remote-reconnect")!.handler("--force", ctx);
      await turn("reconnected");
      // A call begun against one runtime must not become a successful result
      // attributed to its replacement. No retry is allowed on the local host.
      const dispatched = Promise.withResolvers<void>();
      const call = invoke("bash", { command: "printf 'CACHE_IN_FLIGHT\\n'; sleep 5; printf STALE_RESULT" }, update => {
        if (text(update)?.includes("CACHE_IN_FLIGHT")) dispatched.resolve();
      }).then(result => ({ result }), error => ({ error }));
      await Promise.race([dispatched.promise, call.then(() => { throw new Error("Remote command ended before dispatch was observed"); })]);
      await commands.get("remote-exit")!.handler("", ctx); connected = false;
      const outcome = await call;
      assert("error" in outcome || ("result" in outcome && outcome.result.isError), "old runtime result escaped switching boundary");
      assert.equal(text(await invoke("bash", { command: "hostname" })).split("\n")[0], local);
      assert(text(await invoke("read", { path: fixture })).includes("LOCAL_FIXTURE"));
      await verifyApproval();
      await turn("disconnected");
      await turn("local-again");
      console.log("CACHE_SMOKE_PASS: serialized tools/system/history prefixes unchanged; local/remote/reconnect/restoration verified. Provider cache-hit rates were not measured.");
      process.exitCode = 0;
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      if (connected) await invoke("bash", { command: `rm -f -- '${fixture}'` }).catch(console.error);
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(console.error);
      server.stop(true);
      await rm(fixture, { force: true });
      process.exit(process.exitCode ?? 0);
    }
  }});
}
