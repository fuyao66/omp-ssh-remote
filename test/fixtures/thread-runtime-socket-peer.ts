import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { ThreadRuntime, ThreadRuntimeOwner, type ThreadRuntimeAddress, type ThreadRuntimeConnection } from "../../src/thread-runtime.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../../src/omp/runtime-contract.ts";

if (!parentPort) throw new Error("Socket peer fixture requires a worker thread");
const { address, connection } = workerData as { address: ThreadRuntimeAddress; connection: ThreadRuntimeConnection };
// Exercise the real public main-thread guard independently of the successful
// facade connection; a mocked launcher cannot establish native ownership.
await assert.rejects(ThreadRuntimeOwner.create(() => connection, () => {}), /requires the main thread/);
const runtime = await ThreadRuntime.connect(address);
const client = await runtime.createClient(connection);
client.activateEvents?.();
await client.initialize(connection.cwd, OMP_RUNTIME_HANDSHAKE);
const identity = await client.execute("read", "peer-ready", { waitForAck: true });
parentPort.on("message", command => {
  if (command === "exit") process.exit(0); // No runtime.dispose(): the socket is the lifetime token.
});
parentPort.postMessage({ ready: true, guardRejected: true, identity });
