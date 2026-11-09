import { threadId } from "node:worker_threads";
import { assertFamilyLeaseActive } from "../../src/family-broker.ts";
import { ThreadFamilyBridge, type ThreadFamilyDecision, type ThreadMemberIdentity } from "../../src/thread-family.ts";

export type WorkerCommand =
  | { op: "init"; channelName: string }
  | { op: "reserve"; identity: ThreadMemberIdentity; generation?: string }
  | { op: "commit"; token: string; generation: string; identity: ThreadMemberIdentity }
  | { op: "detach"; token: string; identity: ThreadMemberIdentity }
  | { op: "runtime-closed" | "watch-runtime-close" | "probe-runtime"; token: string }
  | { op: "worker-identity" }
  | { op: "lease" | "stats" | "hold-close" | "release-close" | "dispose" }
  | { op: "fast-timeout"; identity: ThreadMemberIdentity };

const port = globalThis as unknown as {
  onmessage: (event: MessageEvent<WorkerCommand & { id: string }>) => void;
  postMessage(value: unknown): void;
};
let bridge: ThreadFamilyBridge;
let decision: ThreadFamilyDecision | undefined;
let closeStarted = 0;
let closeFinished = 0;
let releaseClose: (() => void) | undefined;
let closeGate: Promise<void> | undefined;

async function close(): Promise<void> {
  closeStarted++;
  port.postMessage({ event: "closing" });
  await closeGate;
  closeFinished++;
}

async function execute(command: WorkerCommand): Promise<unknown> {
  switch (command.op) {
    case "init":
      bridge = new ThreadFamilyBridge(command.channelName);
      return;
    case "reserve":
      decision = await bridge.reserve(command.identity, close, command.generation);
      return decision;
    case "commit":
      return await bridge.commit(command.token, command.generation, command.identity);
    case "detach":
      return await bridge.detach(command.token, command.identity);
    case "runtime-closed":
      return bridge.runtimeClosed(command.token);
    case "watch-runtime-close": {
      const runtime = bridge.runtime(command.token);
      const lost = runtime.lost.bind(runtime);
      runtime.lost = error => {
        lost(error);
        port.postMessage({ event: "runtime-closed" });
      };
      return;
    }
    case "probe-runtime":
      if (decision?.kind !== "active") throw new Error("No active fixture lease");
      // Reach the real owner's work handler without admitting an SSH process.
      return await bridge.runtime(command.token).createClient({
        ...decision.family.connection, workerPath: `${decision.family.connection.workerPath}.not-admitted`,
      });
    case "worker-identity":
      return { pid: process.pid, threadId };
    case "lease":
      if (decision?.kind !== "active") throw new Error("No active fixture lease");
      assertFamilyLeaseActive({ ownerSessionFile: decision.family.ownerSessionFile, members: new Set(),
        closing: false, generation: decision.family.generation, revocation: decision.family.revocation });
      return "active";
    case "stats":
      return { closeStarted, closeFinished };
    case "hold-close": {
      const gate = Promise.withResolvers<void>();
      closeGate = gate.promise;
      releaseClose = gate.resolve;
      return;
    }
    case "release-close":
      releaseClose?.();
      closeGate = undefined;
      releaseClose = undefined;
      return;
    case "fast-timeout": {
      // Advance only the bridge deadline deterministically in this isolated
      // worker. IPC still uses the real BroadcastChannel and timeout handler.
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 10_000 && typeof args[0] === "function") {
          const callback = args[0];
          queueMicrotask(() => callback(...args.slice(2)));
          return { unref() {} } as unknown as NodeJS.Timeout;
        }
        return original(...args);
      }) as typeof setTimeout;
      try { return await bridge.reserve(command.identity, close); }
      finally { globalThis.setTimeout = original; }
    }
    case "dispose":
      releaseClose?.();
      await bridge.dispose();
      return;
  }
}

port.onmessage = event => {
  const command = event.data;
  void execute(command).then(
    value => port.postMessage({ id: command.id, value }),
    error => port.postMessage({ id: command.id, error: error instanceof Error ? error.message : String(error) }),
  );
};
port.postMessage({ event: "ready" });
