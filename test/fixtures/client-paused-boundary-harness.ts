import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { dlopen, ptr } from "bun:ffi";
import { RemoteRuntimeClient } from "../../src/client.ts";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, TOOL_RUNTIME_VERSION, encodeMessage } from "../../src/protocol.ts";

const role = process.argv[2];
const BULK_COUNT = 16;
const BULK_BYTES = 1024 * 1024;
const PREFILL_BYTES = 8192;
const FINAL = { finished: true, sequenceCount: BULK_COUNT + 1, marker: "paused-boundary-final" };
type Control = { type: string; [key: string]: unknown };
type Capacity = { kind: "pipe" | "socket"; capacity: number; queued: number };
interface ControlChannel {
  send(message: Control): void;
  receive(type: string): Promise<Control>;
}

function channel(socket: Socket): ControlChannel {
  const messages: Control[] = [];
  let changed = Promise.withResolvers<void>();
  let text = "";
  socket.on("data", chunk => {
    text += chunk.toString();
    for (;;) {
      const end = text.indexOf("\n");
      if (end < 0) break;
      messages.push(JSON.parse(text.slice(0, end)) as Control);
      text = text.slice(end + 1);
      changed.resolve();
    }
  });
  return {
    send(message: Control) { socket.write(`${JSON.stringify(message)}\n`); },
    async receive(type: string): Promise<Control> {
      for (;;) {
        const index = messages.findIndex(message => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await changed.promise;
        changed = Promise.withResolvers<void>();
      }
    },
  };
}

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), 15_000);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

async function flush(bytes: string): Promise<void> {
  await new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
}

if (role === "holder") {
  const socket = createConnection(process.argv[3]!);
  const control = channel(socket);
  control.send({ type: "holder", pid: process.pid });
  // The control socket keeps this process and its inherited stdout alive.
  await new Promise<void>(resolve => socket.once("close", resolve));
  process.exit(0);
} else if (role === "producer") {
  const socket = createConnection(process.argv[3]!);
  const control = channel(socket);
  const inherited = process.argv[4] === "inherited";
  const libc = dlopen("libc.so.6", {
    fcntl: { args: ["i32", "i32"], returns: "i32" },
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
  });
  function capacity(): Capacity {
    const pipe = libc.symbols.fcntl(1, 1032); // Linux F_GETPIPE_SZ, observation only.
    const queued = new Int32Array(1);
    if (pipe > 0) {
      assert.equal(libc.symbols.ioctl(1, 0x541b, ptr(queued)), 0); // FIONREAD on the pipe.
      return { kind: "pipe", capacity: pipe, queued: queued[0]! };
    }
    const size = new Int32Array(1);
    const length = new Uint32Array([4]);
    assert.equal(libc.symbols.getsockopt(1, 1, 7, ptr(size), ptr(length)), 0); // SO_SNDBUF.
    assert.equal(libc.symbols.ioctl(1, 0x5411, ptr(queued)), 0); // TIOCOUTQ includes socket accounting.
    return { kind: "socket", capacity: size[0]!, queued: queued[0]! };
  }
  control.send({ type: "producer", pid: process.pid });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    if (request.type === "initialize") {
      await flush(encodeMessage({ type: "ready", protocolVersion: PROTOCOL_VERSION, host: "omp",
        hostVersion: request.hostVersion, runtimeVersion: TOOL_RUNTIME_VERSION, cwd: request.cwd, tools: [] }));
    } else if (request.type === "execute") {
      if (inherited) {
        spawn(process.execPath, [import.meta.path, "holder", process.argv[3]!], {
          stdio: ["ignore", "inherit", "ignore"],
        }).unref();
      }
      await flush(encodeMessage({ type: "capture", id: request.id,
        capture: { kind: "output", start: 0, end: 4, text: "gate", open: false } }));
      await control.receive("bulk");
      let bulkBytes = 0;
      for (let sequence = 0; sequence < BULK_COUNT; sequence++) {
        const frame = encodeMessage({ type: "update", id: request.id,
          result: { sequence, content: String.fromCharCode(65 + sequence).repeat(BULK_BYTES) } });
        assert.ok(Buffer.byteLength(frame) < MAX_FRAME_BYTES);
        bulkBytes += Buffer.byteLength(frame);
        await flush(frame);
      }
      control.send({ type: "bulk-written", bulkBytes, ...capacity() });
      let prefillCount = 0;
      let finish: Control;
      for (;;) {
        finish = await control.receive("finish");
        if (finish.inspect) {
          control.send({ type: "capacity", ...capacity() });
        } else if (finish.prefill) {
          await flush(encodeMessage({ type: "update", id: request.id,
            result: { sequence: BULK_COUNT + prefillCount, content: "P".repeat(PREFILL_BYTES) } }));
          prefillCount++;
          control.send({ type: "prefill-written", prefillCount, ...capacity() });
        } else break;
      }
      const tailPayload = Number(finish.tailPayload);
      const tail = encodeMessage({ type: "update", id: request.id,
        result: { sequence: BULK_COUNT + prefillCount, content: "T".repeat(tailPayload) } });
      const result = encodeMessage({ type: "result", id: request.id,
        result: { ...FINAL, sequenceCount: BULK_COUNT + prefillCount + 1 } });
      await flush(tail + result);
      control.send({ type: "final-written", tailBytes: Buffer.byteLength(tail + result), ...capacity() });
      // This control acknowledgement proves the write callback returned before
      // actual exit. Parent delivery credit remains withheld until waitForExit.
      await control.receive("exit");
      process.exit(27);
    }
  }
} else {
  assert.equal(role, "host");
  const inherited = process.argv[3] === "inherited";
  const root = await mkdtemp(join(tmpdir(), "omp-client-boundary-"));
  const path = join(root, "control.sock");
  const producerReady = Promise.withResolvers<ControlChannel>();
  const holderReady = Promise.withResolvers<number>();
  const sockets = new Set<Readable>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const control = channel(socket);
    void control.receive("producer").then(() => producerReady.resolve(control));
    void control.receive("holder").then(message => holderReady.resolve(Number(message.pid)));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  let armed = false;
  let queuePauseObserved = false;
  let observedSource: Readable | undefined;
  let pauseCalls = 0;
  const paused = Promise.withResolvers<Readable>();
  const originalPause = Readable.prototype.pause;
  Readable.prototype.pause = function<T extends Readable>(this: T): T {
    originalPause.call(this);
    if (this === observedSource) pauseCalls++;
    if (armed && !sockets.has(this)) {
      const stack = new Error().stack ?? "";
      queuePauseObserved = stack.includes("onData") && stack.includes("src/client.ts");
      observedSource = this;
      pauseCalls = 1;
      armed = false;
      paused.resolve(this);
    }
    return this;
  };
  let client: RemoteRuntimeClient | undefined;
  let holder: number | undefined;
  let holderStart: string | undefined;
  const release = Promise.withResolvers<void>();
  try {
    client = new RemoteRuntimeClient({ command: [process.execPath, import.meta.path, "producer", path,
      inherited ? "inherited" : "plain"], delivery: "acknowledged" });
    const control = await deadline(producerReady.promise, "producer control connection");
    await client.initialize("/fixture/workspace", { host: "omp", hostVersion: "fixture",
      runtimeVersion: TOOL_RUNTIME_VERSION, requestedTools: [], validateReady() {} });
    const entered = Promise.withResolvers<void>();
    const hash = createHash("sha256");
    let delivered = 0;
    let tailPayload = 0;
    let prefillCount = 0;
    let settled = false;
    const pending = client.execute("read", "boundary", {}, undefined, value => {
      const update = value as { sequence: number; content: string };
      assert.equal(update.sequence, delivered);
      assert.equal(update.content, delivered < BULK_COUNT
        ? String.fromCharCode(65 + delivered).repeat(BULK_BYTES)
        : delivered < BULK_COUNT + prefillCount ? "P".repeat(PREFILL_BYTES) : "T".repeat(tailPayload));
      hash.update(update.content);
      delivered++;
    }, { onCapture: async capture => {
      assert.ok(capture.kind === "output");
      assert.equal(capture.text, "gate");
      entered.resolve();
      await release.promise;
    } });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await deadline(entered.promise, "first delivery ACK hold");
    if (inherited) {
      holder = await deadline(holderReady.promise, "inherited stdout readiness");
      const stat = await readFile(`/proc/${holder}/stat`, "utf8");
      holderStart = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]!;
    }
    armed = true;
    control.send({ type: "bulk" });
    const source = await deadline(paused.promise, "actual acquisition pause");
    const highWaterMarkAtPause = source.readableHighWaterMark;
    const bulk = await deadline(control.receive("bulk-written"), "bounded bulk write completion");
    assert.equal(queuePauseObserved, true, "observe the client's raw queue pause, not another readable");
    assert.equal(source.isPaused(), true, "acquisition must remain paused while the first ACK is withheld");
    assert.ok(Number(bulk.bulkBytes) > MAX_FRAME_BYTES, "combined individually valid updates must exceed the queue limit");
    assert.equal(delivered, 0);
    async function prefill(): Promise<void> {
      control.send({ type: "finish", prefill: true });
      const written = await deadline(control.receive("prefill-written"), "readable prefill write");
      prefillCount++;
      assert.equal(written.prefillCount, prefillCount);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const readableSteps = Math.ceil(highWaterMarkAtPause / PREFILL_BYTES);
    while (source.readableLength < highWaterMarkAtPause && prefillCount <= readableSteps) await prefill();
    assert.ok(source.readableLength >= highWaterMarkAtPause, "fill actual Readable buffering before the tail");
    // Also fill one bounded upstream read-ahead window, not an arbitrary stream.
    for (let step = 0; step < readableSteps; step++) await prefill();
    control.send({ type: "finish", inspect: true });
    const tailCapacity = await deadline(control.receive("capacity"), "kernel capacity after prefill");
    const free = Number(tailCapacity.capacity) - Number(tailCapacity.queued);
    const tailBudget = Math.min(Math.floor(free * 3 / 4), 2 * highWaterMarkAtPause + 4096);
    assert.ok(tailBudget > 1024, `producer must have finite room for a result: ${JSON.stringify(bulk)}`);
    tailPayload = tailBudget - 512;
    control.send({ type: "finish", tailPayload });
    const written = await deadline(control.receive("final-written"), "final write before ACK");
    assert.ok(Number(written.tailBytes) <= tailBudget);
    const readableBeforeExit = source.readableLength;
    const pauseCallsBeforeExit = pauseCalls;
    assert.equal(settled, false);
    control.send({ type: "exit" });
    assert.equal(await deadline(client.waitForExit(), "actual exit before ACK"), 27);
    // Let the exit fence run without changing the stream's pause/read behavior.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    const readableAfterExit = source.readableLength;
    const pausedAfterExit = source.isPaused();
    release.resolve();
    const result = await deadline(pending, "all buffered updates and final result");
    assert.deepEqual(result, { ...FINAL, sequenceCount: BULK_COUNT + prefillCount + 1 });
    assert.equal(delivered, BULK_COUNT + prefillCount + 1);
    const expected = createHash("sha256");
    for (let sequence = 0; sequence < BULK_COUNT; sequence++) expected.update(String.fromCharCode(65 + sequence).repeat(BULK_BYTES));
    for (let sequence = 0; sequence < prefillCount; sequence++) expected.update("P".repeat(PREFILL_BYTES));
    expected.update("T".repeat(tailPayload));
    const digest = hash.digest("hex");
    assert.equal(digest, expected.digest("hex"));
    if (holder !== undefined) process.kill(holder, 0);
    process.stdout.write(`${JSON.stringify({ inherited, bulk, tailCapacity, written, highWaterMarkAtPause,
      highWaterMarkAfterDrain: source.readableHighWaterMark,
      readableBeforeExit, readableAfterExit, pausedAfterExit, pauseCallsBeforeExit, pauseCalls, queuePauseObserved,
      prefillCount, kernelTailIsolated: Number(written.queued) > 0, tailPayload, delivered, digest, actualExitBeforeAck: true })}\n`);
  } finally {
    release.resolve();
    armed = false;
    Readable.prototype.pause = originalPause;
    client?.kill("SIGKILL");
    if (client) await deadline(client.waitForExit(), "failure cleanup process exit");
    if (holder !== undefined) {
      try {
        const stat = await readFile(`/proc/${holder}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] === holderStart) process.kill(holder, "SIGKILL");
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
