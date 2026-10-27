// Run with native OMP, not Bun's SDK shim. See the package README.
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
// @ts-expect-error Generated release bundle intentionally has no declaration file.
import extension from "../packages/omp/dist/extension.js";

export default async function cacheSmoke(pi: ExtensionAPI) {
  const args = process.env.REMOTE_CONNECT_ARGS;
  if (!args) throw new Error("REMOTE_CONNECT_ARGS must specify a test host and scratch cwd");
  const providerApi = process.env.CACHE_SMOKE_API ?? "openai-completions";
  assert(providerApi === "openai-completions" || providerApi === "openai-responses", "CACHE_SMOKE_API must be openai-completions or openai-responses");
  const responsesApi = providerApi === "openai-responses";
  const mcCompat = process.env.CACHE_SMOKE_MC_COMPAT;
  const isolation = process.env.CACHE_SMOKE_ISOLATION_DIR;
  const mcLog = process.env.MAGIC_CONTEXT_LOG_PATH;
  if (mcCompat) {
    assert(isolation && isAbsolute(isolation), "MC mode must be launched by scripts/run-smoke.ts cache-mc");
    for (const path of [mcLog, process.env.MAGIC_CONTEXT_STORAGE_DIR, process.env.PI_CODING_AGENT_DIR]) {
      assert(path && isAbsolute(path) && relative(isolation, path) !== "" && !relative(isolation, path).startsWith(".."), "MC/session storage must be inside the isolated acceptance directory");
    }
    assert.equal(process.env.MAGIC_CONTEXT_TEST_DATA_DIR, undefined, "Use real installed MC, not its unit-test provider factory");
    assert.equal(process.env.MAGIC_CONTEXT_LOG_SYNC, "1", "Synchronous MC logs are required for per-turn fence evidence");
    // run-smoke passes compat before this helper using native CLI -e options.
    // The official loader supplies MC's legacy package aliases; raw import()
    // bypasses them. Per-turn wire/log assertions below prove MC actually ran.
  }
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const api = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name: string, command: any) => { commands.set(name, command); target.registerCommand(name, command); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  await extension(api);
  const requests: any[] = [];
  const emittedItems: { tag: string; body: string; encryptedContent: string }[] = [];
  // Real HTTP serialization, synthetic answers. No provider credentials or paid
  // model calls, and no fabricated usage/cached-token statistics.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(request.method, "POST", "Native provider must dispatch an HTTP POST");
    assert.equal(new URL(request.url).pathname, responsesApi ? "/v1/responses" : "/v1/chat/completions", "Unexpected native provider endpoint");
    requests.push(await request.json());
    if (responsesApi) {
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const responseId = `resp_smoke_${suffix}`;
      const itemId = `msg_smoke_${suffix}`;
      const reasoningId = `rs_smoke_${suffix}`;
      // Exercise mixed native reasoning/text history without overriding its
      // replay sanitization policy for output-only IDs and lifecycle metadata.
      // Opaque transport fixture only: neither MC nor the native replay lane
      // should decrypt, rewrite, or discard this provider reasoning payload.
      const encryptedContent = Buffer.from(`local-only-smoke-reasoning:${suffix}`).toString("base64");
      const pendingReasoning = { id: reasoningId, type: "reasoning", status: "in_progress", summary: [], encrypted_content: encryptedContent };
      const reasoning = { ...pendingReasoning, status: "completed" };
      // Force MC's real assistant_message stripper to remove a signature.
      // Later turns must traverse compat's identity recovery/history sync.
      const tag = `§${700000 + requests.length}§`;
      const body = `ACK probe-${requests.length}`;
      const reply = `${tag} ${body}`;
      const emptyPart = { type: "output_text", text: "", annotations: [] };
      const part = { ...emptyPart, text: reply };
      const pendingItem = { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "in_progress", content: [] };
      const item = { ...pendingItem, status: "completed", content: [part] };
      const response = { id: responseId, object: "response", created_at: 1, model: "cache-probe", status: "in_progress", output: [], error: null, incomplete_details: null, usage: null };
      let sequence = 0;
      const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`;
      const stream = event("response.created", { response })
        + event("response.output_item.added", { output_index: 0, item: pendingReasoning })
        + event("response.output_item.done", { output_index: 0, item: reasoning })
        + event("response.output_item.added", { output_index: 1, item: pendingItem })
        + event("response.content_part.added", { item_id: itemId, output_index: 1, content_index: 0, part: emptyPart })
        + event("response.output_text.delta", { item_id: itemId, output_index: 1, content_index: 0, delta: reply, logprobs: [] })
        + event("response.output_text.done", { item_id: itemId, output_index: 1, content_index: 0, text: reply, logprobs: [] })
        + event("response.content_part.done", { item_id: itemId, output_index: 1, content_index: 0, part })
        + event("response.output_item.done", { output_index: 1, item })
        + event("response.completed", { response: { ...response, status: "completed", output: [reasoning, item] } });
      emittedItems.push({ tag, body, encryptedContent });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "cache-probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "ACK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }});
  pi.registerProvider("remote-cache-smoke", { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "smoke-local-only", api: providerApi, models: [{ id: "cache-probe", name: "Cache probe", reasoning: responsesApi, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32 }] });
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
    let mcContextPasses = 0;
    let mcFenceLines = 0;
    const turn = async (label: string) => {
      const before = requests.length;
      await session.prompt(`Reply ACK only. ${label}`);
      assert.equal(requests.length, before + 1, `${label}: expected exactly one real local provider HTTP request (MC must not reject or retry)`);
      const current = requests.at(-1);
      assert.equal(current.model, "cache-probe", `${label}: unexpected provider model`);
      const wireMessages = responsesApi ? current.input : current.messages;
      const systemEntries = responsesApi ? current.instructions : current.messages?.filter((message: { role?: string }) => ["system", "developer"].includes(message.role ?? ""));
      assert(Array.isArray(wireMessages) && wireMessages.length > 0, `${label}: native provider did not serialize conversation ${responsesApi ? "input" : "messages"}`);
      if (mcCompat) {
        await writeFile(join(isolation!, "wire-requests.json"), JSON.stringify(requests, null, 2));
        if (responsesApi) {
          // Native utils.ts sanitizes replay independently of `store`: in this
          // non-computer fixture IDs/status are output-only; phase, text,
          // summary and encrypted_content remain part of the wire contract.
          assert.equal(current.store, false, `${label}: expected stateless Responses replay`);
          type ReplayItem = {
            type?: string; role?: string; phase?: string;
            content?: { type?: string; text?: string }[];
            encrypted_content?: string; summary?: unknown;
          };
          const serializedInput = JSON.stringify(wireMessages);
          const assistantItems: ReplayItem[] = wireMessages.filter((item: ReplayItem) => item.type === "message" && item.role === "assistant");
          const reasoningItems: ReplayItem[] = wireMessages.filter((item: ReplayItem) => item.type === "reasoning");
          assert.equal(assistantItems.length, before, `${label}: unexpected replayed assistant item count`);
          assert.equal(reasoningItems.length, before, `${label}: unexpected replayed reasoning item count`);
          let previousAssistantIndex = -1;
          for (const emitted of emittedItems.slice(0, before)) {
            const assistantMatches: ReplayItem[] = assistantItems.filter(item => item.content?.some(part => part.type === "output_text" && typeof part.text === "string" && part.text.replace(/^§\d+§ /u, "") === emitted.body));
            assert.equal(assistantMatches.length, 1, `${label}: unique assistant probe ${emitted.body} was lost or duplicated`);
            const assistant = assistantMatches[0]!;
            assert.equal(assistant.content?.length, 1, `${label}: replayed assistant content changed`);
            assert.equal(assistant.phase, "final_answer", `${label}: native Responses replay lost assistant phase`);
            assert(!Object.hasOwn(assistant, "id") && !Object.hasOwn(assistant, "status"), `${label}: assistant replay retained output-only id/status`);
            assert(!serializedInput.includes(emitted.tag), `${label}: original mock tag ${emitted.tag} escaped MC stripping/compat synchronization`);
            const reasoningMatches: ReplayItem[] = reasoningItems.filter(item => item.encrypted_content === emitted.encryptedContent);
            assert.equal(reasoningMatches.length, 1, `${label}: opaque reasoning payload was lost, rewritten, or duplicated`);
            const reasoning = reasoningMatches[0]!;
            assert.deepEqual(reasoning.summary, [], `${label}: native Responses replay altered the reasoning summary`);
            assert(!Object.hasOwn(reasoning, "id") && !Object.hasOwn(reasoning, "status"), `${label}: reasoning replay retained output-only id/status`);
            const reasoningIndex = wireMessages.indexOf(reasoning);
            const assistantIndex = wireMessages.indexOf(assistant);
            assert.equal(assistantIndex, reasoningIndex + 1, `${label}: reasoning must immediately precede its original assistant probe`);
            assert(reasoningIndex > previousAssistantIndex, `${label}: native Responses replay reordered prior turns`);
            previousAssistantIndex = assistantIndex;
          }
        }
        const log = await readFile(mcLog!, "utf8");
        assert(!/CONTEXT REFUSED|turn refused|DISCARDED CONTEXT RESULT|dispatch fence disabled|structural comparison skipped/i.test(log), `${label}: MC refused, degraded, or disabled the actual dispatch fence; inspect ${mcLog}`);
        const fences = [...log.matchAll(/OMP context counts session=(\S+) side_contexts=(\d+) context_passes=(\d+) dispatch_fence=(on|latched off)/g)];
        assert.equal(fences.length, mcFenceLines + 1, `${label}: expected one completed real MC context/fence lifecycle`);
        const fence = fences.at(-1)!;
        assert.equal(fence[2], "0", `${label}: ephemeral context disabled MC's dispatch fence`);
        assert.equal(fence[4], "on", `${label}: MC dispatch fence was not active`);
        assert.equal(Number(fence[3]), mcContextPasses + 1, `${label}: expected one real MC context pass`);
        mcContextPasses = Number(fence[3]);
        mcFenceLines = fences.length;
        // MC legitimately retags history between turns. The combined contract
        // is managed dispatch acceptance, not byte-stable MC message numbers.
        assert(/§\d+§/.test(JSON.stringify(wireMessages)), `${label}: serialized messages contain no real MC message tags`);
        console.log(`MC_DISPATCH_PASS ${label} api=${providerApi} http=1 context_passes=${mcContextPasses} dispatch_fence=on messages=${wireMessages.length} tools=${current.tools?.length}${responsesApi ? ` assistant_replays=${before} reasoning_replays=${before}` : ""}`);
      } else {
        if (requests.length > 1) {
          const previous = requests.at(-2);
          const previousMessages = responsesApi ? previous.input : previous.messages;
          const previousSystemEntries = responsesApi ? previous.instructions : previous.messages?.filter((message: { role?: string }) => ["system", "developer"].includes(message.role ?? ""));
          assert.equal(JSON.stringify(current.tools), JSON.stringify(previous.tools), `${label}: wire tool definitions/order changed`);
          assert.equal(JSON.stringify(wireMessages.slice(0, previousMessages.length)), JSON.stringify(previousMessages), `${label}: previously sent message prefix changed`);
          assert.equal(JSON.stringify(systemEntries), JSON.stringify(previousSystemEntries), `${label}: system/developer prefix or Responses instructions changed`);
        }
        console.log(`WIRE_PREFIX_PASS ${label} api=${providerApi} messages=${wireMessages.length} tools=${current.tools?.length}`);
      }
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
      if (mcCompat) {
        assert(await Bun.file(join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db")).exists(), "MC did not create its isolated real SQLite database");
        assert.equal(requests.length, 7, "Combined acceptance must dispatch seven prompts without background model calls");
        console.log("MC_CACHE_SMOKE_PASS: real installed MC context/fence + native OMP serializer accepted all seven local/remote/reconnect/disconnect HTTP turns. MC retag prefix stability and provider cache-hit rates were not asserted.");
      } else {
        console.log("CACHE_SMOKE_PASS: serialized tools/system/history prefixes unchanged; local/remote/reconnect/restoration verified. Provider cache-hit rates were not measured.");
      }
      console.log("DYNAMIC_DISABLE_BOUNDARY unsupported: native host exposes no supported extension-unload API; no monkeypatch attempted.");
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
