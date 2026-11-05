import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { askImageQuestion, ResolvedImageQuestionModel } from "@oh-my-pi/pi-coding-agent/utils/image-question";
import { RemoteRuntimeClient } from "../src/client.ts";
import { createNativeWorkerRuntime, type NativeWorkerRuntime } from "../src/runtime.ts";
import { createOmpRuntimeHandshake, captureOmpToolSnapshot } from "../src/omp/runtime-contract.ts";
import { SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";
import { prepareHostImageQuestion, imageQuestionFailure } from "../src/omp/image-question.ts";
import { imageQuestionModelMetadata, parseRequest, TOOL_RUNTIME_VERSION } from "../src/protocol.ts";

type Model = ResolvedImageQuestionModel["model"];
type Complete = NonNullable<Parameters<typeof askImageQuestion>[5]>;
const model = {
  id: "vision-fixture", name: "Vision fixture", api: "openai-completions", provider: "fixture",
  baseUrl: "https://user:secret@fixture.invalid/api?key=secret", input: ["text", "image"], reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  headers: { Authorization: "secret" }, resolveHeaders: async () => ({ Authorization: "secret" }),
  compat: { stripImageInput: false, extraBody: { secret: "never-send" } },
} as unknown as Model;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

// An actual decodable RGB PNG, with uncompressed IDAT data to cross the frame
// boundary deterministically rather than depending on encoder heuristics.
function largePng(edge: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge); header.writeUInt32BE(edge, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((edge * 3 + 1) * edge);
  for (let row = 0; row < edge; row++) {
    for (let col = 0; col < edge * 3; col++) pixels[row * (edge * 3 + 1) + col + 1] = (row + col) % 256;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}
function hostSession(overrides: Record<string, unknown> = {}): ToolSession {
  return {
    cwd: "/host", hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "",
    settings: Settings.isolated(overrides), getActiveModelString: () => "fixture/vision-fixture",
    modelRegistry: { getAvailable: () => [model], getApiKey: async () => "host-secret", resolver: () => "host-secret" } as unknown as ToolSession["modelRegistry"],
  };
}
const answer: Complete = async (selected) => ({
  role: "assistant", content: [{ type: "text", text: "A white pixel." }], api: selected.api,
  provider: selected.provider, model: selected.id, stopReason: "stop", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

let root: string;
let native: NativeWorkerRuntime;
let client: RemoteRuntimeClient;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-image-question-"));
  await writeFile(join(root, "pixel.png"), Buffer.from(png, "base64"));
  await writeFile(join(root, "data.json"), '{"value":42}');
  native = await createNativeWorkerRuntime(root, SUPPORTED_SDK_VERSION, { settings: { "images.autoResize": false } });
  client = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
  await client.initialize(root, createOmpRuntimeHandshake({ hostVersion: SUPPORTED_SDK_VERSION,
    localTools: Object.values(native.tools).map(captureOmpToolSnapshot), editMode: native.editMode,
  }), 20_000, { resourceBinding: native.resourceBinding, settings: { "images.autoResize": false } });
}, 30_000);
afterAll(async () => {
  client?.kill();
  await client?.waitForExit();
  await native?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

async function read(path: string, session = hostSession(), complete = answer, signal?: AbortSignal, assertCurrent = () => {}) {
  const options = prepareHostImageQuestion(path, session, assertCurrent, complete);
  try { return await client.execute("read", "image-read", { path }, signal, undefined, options) as { content: { type: string; text?: string }[] }; }
  catch (error) { throw imageQuestionFailure(error, options.resolutionError); }
}

describe("remote image question bridge", () => {
  test("native worker PNG question reaches host native completion with image bytes and question", async () => {
    let received = false;
    const result = await read("pixel.png?q=What%20is%20shown%3F", hostSession(), async (selected, context, options) => {
      received = true;
      expect(selected === model).toBe(true);
      expect(options?.apiKey).toBe("host-secret");
      const content = context.messages[0]!.content;
      expect(content).toEqual([{ type: "image", data: png, mimeType: "image/png" }, { type: "text", text: "What is shown?" }]);
      return answer(selected, context, options);
    });
    expect(received).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "A white pixel." }]);
  });

  test("per-request native ReadTool bridge leaves shared worker model registry absent", async () => {
    const readTool = native.createImageQuestionRead(imageQuestionModelMetadata(model), async (request) => {
      expect(request).toEqual({ data: png, mimeType: "image/png", question: "Describe" });
      return "Native runtime answer";
    });
    const result = await readTool.execute("direct", { path: "pixel.png?q=Describe" }) as { content: unknown[] };
    expect(result.content).toEqual([{ type: "text", text: "Native runtime answer" }]);
    expect(native.session.modelRegistry).toBeUndefined();
  });

  test("image-question semicolon read retains bound conflict resources", async () => {
    await writeFile(join(root, "conflict.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
    const result = await read("conflict.txt;pixel.png?q=Describe");
    expect(result).toMatchObject({ details: { remoteResources: { binding: native.resourceBinding, conflictIds: [1] } } });
    expect(JSON.stringify(result)).toContain(`remote-conflict://${native.resourceBinding}/1`);
  });

  test("image-question read provenance governs the shared edit tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-image-provenance-"));
    const runtime = await createNativeWorkerRuntime(cwd, SUPPORTED_SDK_VERSION);
    try {
      const original = `${"x".repeat(20_000)}\n`;
      await writeFile(join(cwd, "long.txt"), original);
      const tool = runtime.createImageQuestionRead(imageQuestionModelMetadata(model), async () => "unused");
      const preview = await tool.execute("preview", { path: "long.txt" });
      const header = JSON.stringify(preview).match(/\[long\.txt#[A-F0-9]+\]/)?.[0];
      expect(header).toBeDefined();
      const rejected = await runtime.tools.edit.execute("unsafe-edit", { input: `${header}\nPUT 1.=1:\n+replacement` })
        .catch((error: Error) => ({ isError: true, error: error.message }));
      expect(rejected).toMatchObject({ isError: true });
      expect(await readFile(join(cwd, "long.txt"), "utf8")).toBe(original);
      await tool.execute("full-read", { path: "long.txt:raw" });
      const accepted = await runtime.tools.edit.execute("safe-edit", { input: `${header}\nPUT 1.=1:\n+replacement` });
      expect(accepted).not.toMatchObject({ isError: true });
      expect(await readFile(join(cwd, "long.txt"), "utf8")).toBe("replacement\n");
    } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("valid image over 12 MiB reaches the host intact with resizing disabled", async () => {
    const image = largePng(2100);
    expect(image.length).toBeGreaterThan(12 * 1024 * 1024);
    expect(image.length).toBeLessThan(20 * 1024 * 1024);
    await writeFile(join(root, "large.png"), image);
    let received = false;
    await read("large.png?q=Describe", hostSession(), async (selected, context, options) => {
      const content = context.messages[0]!.content;
      if (typeof content === "string") throw new Error("Expected image content");
      const actual = content.find(part => part.type === "image");
      expect(actual?.type).toBe("image");
      if (actual?.type !== "image") throw new Error("Missing image");
      expect(createHash("sha256").update(Buffer.from(actual.data, "base64")).digest("hex"))
        .toBe(createHash("sha256").update(image).digest("hex"));
      received = true;
      return answer(selected, context, options);
    });
    expect(received).toBe(true);
  }, 30_000);

  test("native image over 20 MiB is rejected before host completion", async () => {
    const image = largePng(2700);
    expect(image.length).toBeGreaterThan(20 * 1024 * 1024);
    await writeFile(join(root, "oversize.png"), image);
    let called = false;
    await expect(read("oversize.png?q=Describe", hostSession(), async (...args) => {
      called = true; return answer(...args);
    })).rejects.toThrow(/too large|exceeds|20.*MiB/i);
    expect(called).toBe(false);
    expect((await read("pixel.png?q=Describe")).content).toEqual([{ type: "text", text: "A white pixel." }]);
  }, 30_000);

  test("native JSON jq query works without an available host model", async () => {
    const session = hostSession();
    session.modelRegistry = undefined;
    const result = await read("data.json?q=.value", session);
    expect(result.content.map(part => part.text).join("\n")).toContain("42");
  });

  test("host model resolution failure replaces only the worker image placeholder", async () => {
    const session = hostSession();
    session.modelRegistry = { getAvailable: () => [] } as unknown as ToolSession["modelRegistry"];
    await expect(read("pixel.png?q=Describe", session)).rejects.toThrow("No models available for image questions.");
    await expect(read("missing.png?q=Describe", session)).rejects.not.toThrow("No models available for image questions.");
  });

  test("native Eval tool.read reenters the host image-question path", async () => {
    let called = false;
    const result = await client.execute("eval", "nested-image", {
      language: "js", code: 'console.log((await tool.read({ path: "pixel.png?q=Describe" })).text)',
    }, undefined, undefined, { onInvoke: async (invocation, signal) => {
      called = true;
      expect(invocation.tool).toBe("read");
      return read(invocation.args.path as string, hostSession(), answer, signal);
    } });
    expect(called).toBe(true);
    expect(JSON.stringify(result)).toContain("A white pixel.");
  });

  test("aborting the parent read cancels the host completion", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const controller = new AbortController();
    const result = read("pixel.png?q=Describe", hostSession(), async (_model, _context, options) => {
      entered.resolve();
      const deferred = Promise.withResolvers<never>();
      const abort = () => { cancelled.resolve(); deferred.reject(options!.signal!.reason); };
      options!.signal!.addEventListener("abort", abort, { once: true });
      if (options!.signal!.aborted) abort();
      return await deferred.promise;
    }, controller.signal);
    const rejection = result.then(() => { throw new Error("cancelled read succeeded"); }, error => error);
    await entered.promise;
    controller.abort(new Error("read cancelled by host"));
    await cancelled.promise;
    const failure = await rejection;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/cancel|abort/i);
  });

  test("host image blocking and timeout settings govern provider calls", async () => {
    let calls = 0;
    await expect(read("pixel.png?q=Describe", hostSession({ "images.blockImages": true }), async (...args) => {
      calls++; return answer(...args);
    })).rejects.toThrow("images.blockImages=true");
    expect(calls).toBe(0);
    await expect(read("pixel.png?q=Describe", hostSession({ "images.questionTimeoutMs": 10 }), async (_model, _context, options) => {
      const deferred = Promise.withResolvers<never>();
      options!.signal!.addEventListener("abort", () => deferred.reject(options!.signal!.reason), { once: true });
      return await deferred.promise;
    })).rejects.toThrow("Image question timed out");
  });

  test("host cost gate admits and records native image cost without session usage accounting", async () => {
    const session = hostSession();
    let admitted = 0;
    const recorded: number[] = [];
    session.costGate = { admit: () => { admitted++; }, record: (cost: number) => { recorded.push(cost); } } as unknown as ToolSession["costGate"];
    await read("pixel.png?q=Describe", session, async (...args) => {
      const response = await answer(...args);
      return { ...response, usage: { ...response.usage, cost: { ...response.usage.cost, total: 0.25 } } };
    });
    expect(admitted).toBe(1);
    expect(recorded).toEqual([0.25]);
  });

  test("binding is rechecked after the host completion settles", async () => {
    let current = true;
    await expect(read("pixel.png?q=Describe", hostSession(), async (...args) => {
      current = false; return answer(...args);
    }, undefined, () => { if (!current) throw new Error("binding changed"); })).rejects.toThrow("binding changed");
  });

  test("only allowlisted native model metadata crosses the execute wire", () => {
    const metadata = imageQuestionModelMetadata(model);
    expect(Object.keys(metadata).sort()).toEqual(["api", "compat", "id", "input", "name", "provider"]);
    expect(metadata.compat).toEqual({});
    const decoder = imageQuestionModelMetadata({ ...model, transport: "pi-native", imageInputDecoder: "stb", compat: { stripImageInput: true, secret: "never-send" } } as unknown as Model);
    expect(Object.keys(decoder).sort()).toEqual(["api", "compat", "id", "imageInputDecoder", "input", "name", "provider", "transport"]);
    expect(decoder.compat).toEqual({ stripImageInput: true });
    expect(JSON.stringify(metadata)).not.toContain("secret");
    const parsed = parseRequest({ type: "execute", id: "p", tool: "read", toolCallId: "c", args: {}, imageQuestionModel: model });
    expect(parsed.type === "execute" && parsed.imageQuestionModel).toEqual(metadata);
    expect(() => parseRequest({ type: "execute", id: "p", tool: "eval", toolCallId: "c", args: {}, imageQuestionModel: model })).toThrow("only valid for read");
    expect(TOOL_RUNTIME_VERSION).toBe("0.16.0");
  });

  test.each(["declared-overflow", "decoded-overflow", "chunk-overflow", "incomplete", "cancelled"])("image transfer rejects %s and releases its parent cleanly", async mode => {
    const script = `import { decodeFrames, MAX_IMAGE_QUESTION_BASE64, IMAGE_QUESTION_CHUNK_CHARS } from ${JSON.stringify(join(import.meta.dir, "../src/protocol.ts"))};
      const mode = ${JSON.stringify(mode)};
      let parentId;
      const send = async message => { await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(message) + "\\n", error => error ? reject(error) : resolve())); };
      const begin = (id, length) => ({ type: "image-question-begin", id, parentId, resourceBinding: "fixture-binding", question: "q", mimeType: "image/png", length });
      for await (const frame of decodeFrames(process.stdin)) {
        const message = JSON.parse(frame);
        if (message.type === "initialize") await send({ type: "ready", protocolVersion: 1, resourceBinding: "fixture-binding", tools: [] });
        if (message.type === "execute") {
          parentId = message.id;
          await send(begin("bad", mode === "declared-overflow" ? MAX_IMAGE_QUESTION_BASE64 + 1 : mode === "decoded-overflow" ? MAX_IMAGE_QUESTION_BASE64 : 4));
          if (mode === "decoded-overflow") {
            for (let offset = 0; offset < MAX_IMAGE_QUESTION_BASE64; offset += IMAGE_QUESTION_CHUNK_CHARS)
              await send({ type: "image-question-chunk", id: "bad", offset, data: "A".repeat(Math.min(IMAGE_QUESTION_CHUNK_CHARS, MAX_IMAGE_QUESTION_BASE64 - offset)) });
            await send({ type: "image-question-commit", id: "bad" });
          } else if (mode === "chunk-overflow") await send({ type: "image-question-chunk", id: "bad", offset: 0, data: "AAAAAA==" });
          else if (mode === "incomplete") await send({ type: "image-question-commit", id: "bad" });
          else if (mode === "cancelled") {
            await send({ type: "image-question-cancel", id: "bad" });
            await send({ type: "image-question-commit", id: "bad" });
          }
        }
        if (message.type === "image-question-error") {
          await send(begin("good", 4));
          await send({ type: "image-question-chunk", id: "good", offset: 0, data: "YQ==" });
          await send({ type: "image-question-commit", id: "good" });
        }
        if (message.type === "image-question-result") await send({ type: "result", id: parentId, result: message.text });
      }`;
    const rogue = new RemoteRuntimeClient({ command: [process.execPath, "-e", script] });
    try {
      await rogue.initialize(root, { host: "omp", hostVersion: SUPPORTED_SDK_VERSION, runtimeVersion: TOOL_RUNTIME_VERSION,
        requestedTools: [], validateReady() {} });
      const questions: string[] = [];
      expect(await rogue.execute("read", "transfer-boundary", {}, undefined, undefined, { onImageQuestion: async question => {
        questions.push(question.id);
        expect(question.data).toBe("YQ==");
        return "only valid transfer admitted";
      } })).toBe("only valid transfer admitted");
      expect(questions).toEqual(["good"]);
      expect(rogue.isClosed).toBe(false);
    } finally { rogue.kill(); await rogue.waitForExit(); }
  });

  test.each(["tiny-chunks", "concurrent-begin", "missing-parent"])("image transfer bounds aggregate retention for %s", async mode => {
    const script = `import { decodeFrames } from ${JSON.stringify(join(import.meta.dir, "../src/protocol.ts"))};
      const mode = ${JSON.stringify(mode)};
      let parentId;
      const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
      const begin = (id, length, parent = parentId) => ({ type: "image-question-begin", id, parentId: parent, resourceBinding: "fixture-binding", question: "q", mimeType: "image/png", length });
      for await (const frame of decodeFrames(process.stdin)) {
        const message = JSON.parse(frame);
        if (message.type === "initialize") send({ type: "ready", protocolVersion: 1, resourceBinding: "fixture-binding", tools: [] });
        if (message.type === "execute") {
          parentId = message.id;
          if (mode === "missing-parent") send(begin("bad", 4, "nonexistent-parent"));
          else if (mode === "concurrent-begin") {
            send(begin("open", 4));
            send(begin("bad", 4));
            send({ type: "image-question-chunk", id: "bad", offset: 0, data: "YQ==" });
            send({ type: "image-question-commit", id: "bad" });
          } else {
            send(begin("bad", 64));
            for (let offset = 0; offset < 64; offset += 4)
              send({ type: "image-question-chunk", id: "bad", offset, data: "AAAA" });
            send({ type: "image-question-commit", id: "bad" });
          }
        }
        if (message.type === "image-question-error") {
          send({ type: "image-question-cancel", id: "open" });
          send({ type: "result", id: parentId, result: message.error.message });
        }
        if (message.type === "image-question-result") send({ type: "result", id: parentId, result: "unexpected provider admission" });
      }`;
    const rogue = new RemoteRuntimeClient({ command: [process.execPath, "-e", script] });
    try {
      await rogue.initialize(root, { host: "omp", hostVersion: SUPPORTED_SDK_VERSION, runtimeVersion: TOOL_RUNTIME_VERSION,
        requestedTools: [], validateReady() {} });
      let calls = 0;
      const result = await rogue.execute("read", "aggregate-bound", {}, undefined, undefined, {
        onImageQuestion: async () => { calls++; return "unexpected"; },
      });
      expect(result).toContain(mode === "tiny-chunks" ? "Invalid remote image question chunk"
        : mode === "concurrent-begin" ? "already has an in-flight image question" : "no authorized active read parent");
      expect(calls).toBe(0);
      expect(rogue.isClosed).toBe(false);
    } finally { rogue.kill(); await rogue.waitForExit(); }
  });

  test.each(["read", "eval", "wrong-binding"])("rejects reverse questions from an unarmed or wrong-binding %s parent", async (tool) => {
    const script = `import { decodeFrames } from ${JSON.stringify(join(import.meta.dir, "../src/protocol.ts"))};
      for await (const frame of decodeFrames(process.stdin)) {
        const message = JSON.parse(frame);
        if (message.type === "initialize") console.log(JSON.stringify({ type: "ready", protocolVersion: 1, resourceBinding: "fixture-binding", tools: [] }));
        if (message.type === "execute") console.log(JSON.stringify({ type: "image-question", id: "rogue", parentId: message.id, resourceBinding: ${JSON.stringify(tool === "wrong-binding" ? "other-binding" : "fixture-binding")}, question: "q", data: "x", mimeType: "image/png" }));
        if (message.type === "image-question-error") console.log(JSON.stringify({ type: "result", id: "req_1", result: message.error.message }));
      }`;
    const rogue = new RemoteRuntimeClient({ command: [process.execPath, "-e", script] });
    try {
      await rogue.initialize(root, { host: "omp", hostVersion: SUPPORTED_SDK_VERSION, runtimeVersion: TOOL_RUNTIME_VERSION,
        requestedTools: [], validateReady() {} });
      let called = false;
      expect(await rogue.execute(tool === "wrong-binding" ? "read" : tool, "rogue-parent", {}, undefined, undefined,
        tool === "wrong-binding" ? { onImageQuestion: async () => { called = true; return "unauthorized"; } } : {},
      )).toContain("no authorized active read parent");
      expect(called).toBe(false);
    } finally { rogue.kill(); await rogue.waitForExit(); }
  });
});
