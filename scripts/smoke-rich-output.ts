// Native-local versus SSH output comparison, without model calls or extra packages.
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
// @ts-expect-error Generated release bundle has no declaration file.
import extension from "../packages/omp/dist/extension.js";

export default async function(pi: ExtensionAPI) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<unknown> }>();
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name: string, command: any) => { commands.set(name, command); return target.registerCommand(name, command); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await extension(proxy);
  pi.registerCommand("remote-rich-output-smoke", { description: "Compare native print views and literal data across SSH", async handler(_, ctx) {
    const connectArgs = Bun.env.REMOTE_CONNECT_ARGS;
    assert(typeof connectArgs === "string" && connectArgs.trim().length > 0, "Set REMOTE_CONNECT_ARGS to an SSH target and remote scratch directory");
    const session = AgentRegistry.global().list().find(ref => ref.sessionFile === ctx.sessionManager.getSessionFile())?.session;
    assert(session, "Native session missing");
    session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
    const invoke = async (name: string, args: object): Promise<any> => {
      const tool = session.getToolByName(name); assert(tool, `Missing ${name}`);
      const result = await tool.execute(crypto.randomUUID(), args, AbortSignal.timeout(45000), undefined, { hasUI: false, settings: session.settings, sessionManager: session.sessionManager, toolNames: pi.getActiveTools() } as never);
      assert(!result.isError, JSON.stringify(result));
      return result;
    };
    const text = (result: any) => result.content?.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n") ?? "";
    const json = (value: unknown) => JSON.parse(JSON.stringify(value));
    const views = (result: any) => (result.details?.cells ?? []).flatMap((cell: any) => (cell.views ?? []).map((entry: any) => {
      assert(cell.output.includes(entry.text), "Native view anchor no longer matches the printed output");
      return entry.view;
    }));
    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
    const literal = "remote-artifact://00000000-0000-4000-8000-000000000000/999";
    const data = { artifactId: "customer-field", metric: 7, nested: { artifactId: "nested-field", literal: "artifact://12345" }, meta: { truncation: { artifactId: "application-field" } }, ref: literal, items: [1, 2], padding: "x".repeat(100) };
    const markdown = `# Literal data\n\n[record](artifact://12345)\n\n${literal}`;
    const cases = [
      { name: "js-small", language: "js", code: "print({metric:7,items:[1,2]})", kind: undefined },
      { name: "js-json", language: "js", code: `print(${JSON.stringify(data)})`, kind: "json" },
      { name: "py-json", language: "py", code: `import json\nprint(json.loads(${JSON.stringify(JSON.stringify(data))}))`, kind: "json" },
      { name: "js-table", language: "js", code: `console.table([{artifactId:'customer-field', 'artifact://12345':'artifact://67890', literal:${JSON.stringify(literal)}, metric:7}])`, kind: "table" },
      { name: "py-markdown", language: "py", code: `class RichPrintProbe:\n    def __str__(self):\n        return 'markdown fixture'\n    def _repr_markdown_(self):\n        return ${JSON.stringify(markdown)}\nprint(RichPrintProbe())`, kind: "markdown" },
      { name: "plain-literal", language: "js", code: `print(${JSON.stringify("literal artifact://12345; " + literal)})`, kind: undefined },
      { name: "js-image", language: "js", code: `print({type:'image',mimeType:'image/png',data:${JSON.stringify(image)}})`, image: true },
      { name: "py-image", language: "py", code: `print({"type":"image","mimeType":"image/png","data":${JSON.stringify(image)}})`, image: true },
    ];
    const local = new Map<string, any>();
    const file = `/tmp/omp-rich-output-${process.pid}-${crypto.randomUUID()}.json`;
    let connected = false; let fileCreated = false;
    try {
      for (const sample of cases) {
        console.log("RICH_LOCAL_CASE", sample.name);
        const result = await invoke("eval", { language: sample.language, code: sample.code, title: sample.name });
        const actual = views(result);
        if (sample.kind) assert.equal(actual[0]?.kind, sample.kind, `${sample.name}: native control did not produce its view`);
        else assert.equal(actual.length, 0, `${sample.name}: unexpected native view`);
        if (sample.kind === "json") assert.deepEqual(actual[0].value, data);
        if (sample.image) assert(result.content.some((block: any) => block.type === "image"), `${sample.name}: native control image missing`);
        local.set(sample.name, result);
      }
      await commands.get("remote-connect")!.handler(connectArgs, ctx); connected = true;
      for (const sample of cases) {
        const result = await invoke("eval", { language: sample.language, code: sample.code, title: sample.name });
        const control = local.get(sample.name);
        assert.deepEqual(json(views(result)), json(views(control)), `${sample.name}: native rich data changed across SSH`);
        assert.deepEqual(result.details.cells.map((cell: any) => cell.code), control.details.cells.map((cell: any) => cell.code), `${sample.name}: echoed source changed`);
        const images = (r: any) => r.content.filter((block: any) => block.type === "image").map((block: any) => ({ mimeType: block.mimeType, data: block.data }));
        assert.deepEqual(images(result), images(control), `${sample.name}: image bytes changed`);
        if (!sample.image) assert.equal(text(result), text(control), `${sample.name}: application text changed`);
        console.log("RICH_OUTPUT_EXACT_PASS", sample.name);
      }
      await invoke("write", { path: file, content: JSON.stringify(data) }); fileCreated = true;
      assert(text(await invoke("read", { path: `${file}:raw` })).includes(literal), "Write body/read output rewrote literal data");
      assert(text(await invoke("grep", { path: file, pattern: literal })).includes(literal), "Search pattern rewrote literal data");
      assert(/\btrue\b/.test(text(await invoke("read", { path: `${file}?q=.ref==${JSON.stringify(literal)}` }))), "JSON query rewrote literal data");
      console.log("OPAQUE_INPUT_ROUNDTRIP_PASS");
      await invoke("bash", { command: `rm -f -- '${file}'` }); fileCreated = false;
      await commands.get("remote-exit")!.handler("", ctx); connected = false;
      console.log("RICH_OUTPUT_SMOKE_PASS: native JSON/table/Markdown/image data, code, output and anchors are preserved across SSH.");
    } finally {
      if (fileCreated && connected) await invoke("bash", { command: `rm -f -- '${file}'` }).catch(console.error);
      if (connected) await commands.get("remote-exit")!.handler("--force", ctx).catch(console.error);
    }
    process.exit(0);
  } });
}
