import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import { RpcClosedError, type RpcMethod } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import {
  socketRpc, ThreadCallbackBudget, THREAD_RPC_CALLBACK_BYTES, THREAD_RPC_CALLBACK_CALLS, THREAD_RPC_FRAME_BYTES,
  type ThreadRpcConnection,
} from "../src/thread-rpc.ts";

type Api = {
  echo: RpcMethod<[unknown], unknown>;
  reenter: RpcMethod<[(value: number) => Promise<number>], number>;
  inner: RpcMethod<[number], number>;
  abort: RpcMethod<[AbortSignal], unknown>;
  pending: RpcMethod<[], void>;
};

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const timer = Promise.withResolvers<never>();
  // Failure deadline only: fake time cannot drive the real socket's readiness or EOF.
  const handle = setTimeout(() => timer.reject(new Error(`${label} timed out`)), 5_000);
  try { return await Promise.race([promise, timer.promise]); }
  finally { clearTimeout(handle); }
}

async function withPair(run: (left: ThreadRpcConnection<Api, Api>, right: ThreadRpcConnection<Api, Api>,
  sockets: [Socket, Socket], losses: [Error[], Error[]]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-thread-rpc-test-"));
  const server = createServer();
  const sockets: Socket[] = [];
  const connections: ThreadRpcConnection<Api, Api>[] = [];
  try {
    server.listen(join(root, "rpc.sock"));
    await once(server, "listening");
    const accepted = once(server, "connection");
    const outgoing = createConnection(join(root, "rpc.sock"));
    sockets.push(outgoing);
    const [incoming] = await accepted as [Socket];
    sockets.push(incoming);
    const losses: [Error[], Error[]] = [[], []];
    const left = socketRpc<Api, Api>(outgoing, "test-left", error => losses[0].push(error));
    const right = socketRpc<Api, Api>(incoming, "test-right", error => losses[1].push(error));
    connections.push(left, right);
    await run(left, right, [outgoing, incoming], losses);
  } finally {
    for (const connection of connections) connection.close("test cleanup");
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      const stopped = Promise.withResolvers<void>();
      server.close(error => error ? stopped.reject(error) : stopped.resolve());
      await stopped.promise;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const turn = () => {
  const next = Promise.withResolvers<void>();
  setImmediate(next.resolve);
  return next.promise;
};

describe("native RpcLink over an owned socket", () => {
  test("preserves undefined, binary views and BigInt without JSON coercion", async () => {
    await withPair(async (left, right) => {
      right.link.handle("echo", value => value);
      expect(await deadline(left.link.call("echo", undefined), "undefined reply")).toBeUndefined();
      const original = {
        missing: undefined,
        values: [undefined, 9_007_199_254_740_993n],
        bytes: new Uint8Array([255, 0, 128, 17]).subarray(1, 3),
      };
      const received = await deadline(left.link.call("echo", original), "binary reply") as typeof original;
      expect(Object.hasOwn(received, "missing")).toBe(true);
      expect(received.missing).toBeUndefined();
      expect(received.values).toEqual(original.values);
      expect(received.bytes).toBeInstanceOf(Uint8Array);
      expect([...received.bytes]).toEqual([0, 128]);
      expect(received.bytes).not.toBe(original.bytes);
    });
  });

  test("serves a nested RPC while the originating call awaits its callback", async () => {
    await withPair(async (left, right) => {
      const order: string[] = [];
      right.link.handle("inner", value => { order.push("nested"); return value + 1; });
      right.link.handle("reenter", async callback => {
        order.push("outer");
        const value = await callback(40);
        order.push("returned");
        return value + 1;
      });
      const result = await deadline(left.link.call("reenter", async value => {
        order.push("callback");
        return left.link.call("inner", value);
      }), "reentrant callback");
      expect(result).toBe(42);
      expect(order).toEqual(["outer", "callback", "nested", "returned"]);
    });
  });

  test("mirrors live and already-aborted signals with their Error reason", async () => {
    await withPair(async (left, right) => {
      const entered = Promise.withResolvers<void>();
      right.link.handle("abort", signal => {
        const result = Promise.withResolvers<unknown>();
        const aborted = () => result.resolve(signal.reason);
        if (signal.aborted) aborted();
        else { signal.addEventListener("abort", aborted, { once: true }); entered.resolve(); }
        return result.promise;
      });
      const controller = new AbortController();
      const pending = left.link.call("abort", controller.signal);
      void pending.catch(() => {});
      await deadline(entered.promise, "remote signal listener");
      controller.abort(new Error("live cancellation"));
      const live = await deadline(pending, "mirrored abort");
      expect(live).toBeInstanceOf(Error);
      expect((live as Error).message).toBe("live cancellation");
      const aborted = new AbortController();
      aborted.abort(new Error("cancelled before transfer"));
      const early = await deadline(left.link.call("abort", aborted.signal), "already-aborted signal");
      expect(early).toBeInstanceOf(Error);
      expect((early as Error).message).toBe("cancelled before transfer");
    });
  });

  test("records peer loss before native close aborts an imported signal", async () => {
    await withPair(async (left, right, sockets, losses) => {
      const entered = Promise.withResolvers<void>();
      const observed = Promise.withResolvers<{ lossRecorded: boolean; reason: unknown }>();
      const release = Promise.withResolvers<void>();
      right.link.handle("abort", signal => {
        signal.addEventListener("abort", () => {
          observed.resolve({ lossRecorded: losses[1].length === 1, reason: signal.reason });
        }, { once: true });
        entered.resolve();
        return release.promise;
      });
      const controller = new AbortController();
      const pending = left.link.call("abort", controller.signal);
      const settled = Promise.allSettled([pending]);
      try {
        await deadline(entered.promise, "imported signal listener");
        sockets[0].destroy();
        const observation = await deadline(observed.promise, "native signal abort on peer loss");
        expect(observation.lossRecorded).toBe(true);
        expect(observation.reason).toBeInstanceOf(RpcClosedError);
        expect(controller.signal.aborted).toBe(false);
        const result = (await deadline(settled, "peer-loss call rejection"))[0]!;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(RpcClosedError);
      } finally { release.resolve(); }
    });
  });

  test("rejects an oversized incoming length header without waiting for a body", async () => {
    await withPair(async (left, right, sockets, losses) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let received = 0;
      const hold = () => { if (++received === 3) entered.resolve(); return release.promise; };
      left.link.handle("pending", hold);
      right.link.handle("pending", hold);
      const settled = Promise.allSettled([
        left.link.call("pending"), left.link.call("pending"), right.link.call("pending"),
      ]);
      try {
        await deadline(entered.promise, "pending calls before malformed header");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(THREAD_RPC_FRAME_BYTES + 1);
        sockets[1].write(header); // Deliberately send no body and leave the peer socket open.
        const results = await deadline(settled, "oversized-header rejection");
        expect(losses[0]).toHaveLength(1);
        expect(losses[0][0]!.message).toBe("Invalid remote thread RPC frame length");
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") expect(result.reason).toBeInstanceOf(RpcClosedError);
        }
        await expect(left.link.call("pending")).rejects.toBeInstanceOf(RpcClosedError);
      } finally { release.resolve(); }
    });
  });

  test("peer disappearance rejects both pending directions and future calls exactly once", async () => {
    await withPair(async (left, right, sockets, losses) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let count = 0;
      const pendingHandler = () => { if (++count === 2) entered.resolve(); return release.promise; };
      left.link.handle("pending", pendingHandler);
      right.link.handle("pending", pendingHandler);
      const pending = [left.link.call("pending"), right.link.call("pending")];
      const settled = Promise.allSettled(pending); // Consume both before the socket can disappear.
      try {
        await deadline(entered.promise, "bidirectional pending handlers");
        const closed = Promise.all(sockets.map(socket => once(socket, "close")));
        sockets[1].destroy();
        const results = await deadline(settled, "link-close rejections");
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") expect(result.reason).toBeInstanceOf(RpcClosedError);
        }
        await deadline(closed, "socket closure");
        await expect(left.link.call("pending")).rejects.toBeInstanceOf(RpcClosedError);
        await expect(right.link.call("pending")).rejects.toBeInstanceOf(RpcClosedError);
        left.close(); right.close();
        expect(losses.map(errors => errors.length)).toEqual([1, 1]);
      } finally { release.resolve(); }
    });
  });
});

describe("void callback admission", () => {
  test("caps outstanding calls, consumes every rejection and releases rejected slots", async () => {
    const failures: Error[] = [];
    const budget = new ThreadCallbackBudget(error => failures.push(error), () => false);
    const deliveries = Array.from({ length: THREAD_RPC_CALLBACK_CALLS }, () => Promise.withResolvers<void>());
    let delivered = 0;
    try {
      for (const delivery of deliveries) budget.send([], () => { delivered++; return delivery.promise; });
      budget.send([], async () => { delivered++; });
      expect(delivered).toBe(THREAD_RPC_CALLBACK_CALLS);
      expect(failures.some(error => /backlog exceeded/.test(error.message))).toBe(true);
      const settled = Promise.allSettled(deliveries.map(delivery => delivery.promise));
      for (const delivery of deliveries) delivery.reject(new Error("fixture callback rejected"));
      await settled;
      await turn(); // Drain send()'s rejection consumers, not a wall-clock sleep.
      expect(failures.filter(error => error.message === "fixture callback rejected")).toHaveLength(THREAD_RPC_CALLBACK_CALLS);
      expect(await budget.call([], async () => "recovered")).toBe("recovered");
      budget.send([], () => { throw new Error("synchronous callback failure"); });
      await turn();
      expect(failures.some(error => error.message === "synchronous callback failure")).toBe(true);
      expect(await budget.call([], async () => "still usable")).toBe("still usable");
    } finally {
      for (const delivery of deliveries) delivery.resolve();
      await turn();
    }
  });

  test("caps outstanding serialized bytes before the call-count limit and releases settled bytes", async () => {
    const failures: Error[] = [];
    const budget = new ThreadCallbackBudget(error => failures.push(error), () => false);
    const args = [new Uint8Array(Math.floor(THREAD_RPC_CALLBACK_BYTES / 3))];
    const bytes = serialize(args).length;
    expect(bytes * 2).toBeLessThanOrEqual(THREAD_RPC_CALLBACK_BYTES);
    expect(bytes * 3).toBeGreaterThan(THREAD_RPC_CALLBACK_BYTES);
    expect(3).toBeLessThan(THREAD_RPC_CALLBACK_CALLS);
    const deliveries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let delivered = 0;
    try {
      for (const delivery of deliveries) budget.send(args, () => { delivered++; return delivery.promise; });
      budget.send(args, async () => { delivered++; });
      expect(delivered).toBe(2);
      expect(failures.some(error => /backlog exceeded/.test(error.message))).toBe(true);
      deliveries[0]!.resolve();
      deliveries[1]!.reject(new Error("large callback rejected"));
      await Promise.allSettled(deliveries.map(delivery => delivery.promise));
      await turn();
      expect(failures.some(error => error.message === "large callback rejected")).toBe(true);
      expect(await budget.call(args, async () => "bytes released")).toBe("bytes released");
    } finally {
      for (const delivery of deliveries) delivery.resolve();
      await turn();
    }
  });

  test("revocation skips ordinary callbacks but permits explicitly allowed cleanup delivery", async () => {
    let delivered = 0;
    const failures: Error[] = [];
    const budget = new ThreadCallbackBudget(error => failures.push(error), () => true);
    budget.send([], async () => { delivered++; });
    expect(await budget.call([], async () => { delivered++; })).toBeUndefined();
    expect(await budget.call([], async () => { delivered++; return "closed"; }, true)).toBe("closed");
    expect(delivered).toBe(1);
    expect(failures).toEqual([]);
  });
});
