import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import type { RpcFrame, RpcMethod } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import { socketRpc, type ThreadRpcConnection } from "../../src/thread-rpc.ts";
import { ThreadRuntime } from "../../src/thread-runtime.ts";

type EmptyApi = Record<never, never>;
type AuthenticationApi = {
  attach: RpcMethod<[string], {
    createClient(): Promise<never>;
    prepare(): Promise<never>;
    close(): Promise<void>;
  }>;
};

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  // Failure deadline only: fake time cannot advance real socket authentication or EOF.
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), 8_000);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

async function authenticate(appendInvalidHeader: boolean): Promise<{ authenticated: boolean; rejected: boolean; closeCalls: number; replyWrites: number }> {
  const root = await mkdtemp(join(tmpdir(), "omp-thread-authentication-test-"));
  const path = join(root, "authentication.sock");
  const capability = crypto.randomUUID();
  const sockets: Socket[] = [];
  const connections: ThreadRpcConnection<AuthenticationApi, EmptyApi>[] = [];
  const lost = Promise.withResolvers<void>();
  let attachCalls = 0;
  let closeCalls = 0;
  let replyWrites = 0;
  let runtime: ThreadRuntime | undefined;
  const server = createServer(socket => {
    sockets.push(socket);
    const write = socket.write.bind(socket);
    // Instance-local fault injection preserves the native RpcLink's complete
    // success reply. Its first write contains reply + invalid header together,
    // placing resolve and carrier failure before connect()'s await continuation.
    socket.write = ((chunk: Uint8Array, callback?: (error?: Error | null) => void) => {
      const bytes = Buffer.from(chunk);
      if (replyWrites++ === 0) {
        const frame = deserialize(bytes.subarray(4)) as RpcFrame;
        assert.equal(frame.t, "ok", "native RpcLink must produce a valid attach success reply");
        return write(appendInvalidHeader ? Buffer.concat([bytes, Buffer.alloc(4)]) : bytes, callback);
      }
      return write(bytes, callback);
    }) as Socket["write"];
    const rpc = socketRpc<AuthenticationApi, EmptyApi>(socket, "authentication-fixture", () => lost.resolve());
    connections.push(rpc);
    rpc.link.handle("attach", supplied => {
      assert.equal(supplied, capability);
      attachCalls++;
      return {
        async createClient(): Promise<never> { throw new Error("fixture must not create a client"); },
        async prepare(): Promise<never> { throw new Error("fixture must not prepare a worker"); },
        async close() { closeCalls++; },
      };
    });
  });
  try {
    server.listen(path);
    await once(server, "listening");
    const result = (await deadline(Promise.allSettled([ThreadRuntime.connect({ path, capability })]), "authentication publication"))[0]!;
    if (result.status === "fulfilled") runtime = result.value;
    assert.equal(attachCalls, 1);
    assert.ok(replyWrites >= 1);
    if (appendInvalidHeader) {
      assert.equal(result.status, "rejected", "a valid attach reply cannot publish a facade after the same read closes its carrier");
      if (result.status === "rejected") assert.match(result.reason.message, /Invalid remote thread RPC frame length/);
      await deadline(lost.promise, "faulted authentication socket closure");
      assert.equal(closeCalls, 0, "failed publication must not call an impossible remote close");
      return { authenticated: true, rejected: true, closeCalls, replyWrites };
    }
    assert.equal(result.status, "fulfilled", "the identical native attach reply without the trailing fault must authenticate");
    assert.ok(runtime);
    assert.equal(runtime.isClosed, false);
    await deadline(runtime.dispose(), "control facade disposal");
    assert.equal(runtime.isClosed, true);
    assert.equal(closeCalls, 1);
    await deadline(lost.promise, "control authentication socket closure");
    return { authenticated: true, rejected: false, closeCalls, replyWrites };
  } finally {
    await runtime?.dispose().catch(() => {});
    for (const rpc of connections) rpc.close("authentication fixture cleanup");
    for (const socket of sockets) socket.destroy();
    try {
      if (server.listening) {
        const stopped = Promise.withResolvers<void>();
        server.close(error => error ? stopped.reject(error) : stopped.resolve());
        await stopped.promise;
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

const control = await authenticate(false);
const fault = await authenticate(true);
process.stdout.write(`${JSON.stringify({ disposed: true, authenticationControl: control, authenticationFault: fault })}\n`);
