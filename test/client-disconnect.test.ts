import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { PROTOCOL_VERSION, TOOL_RUNTIME_VERSION, type InitializeRequest } from "../src/protocol.ts";

async function deadline<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  // Bound a real child-process event, not a guessed delay; fake time cannot
  // advance the spawned Bun process or establish that it actually exited.
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function withClient(fixture: string | readonly string[], run: (client: RemoteRuntimeClient) => Promise<void>, mode?: string): Promise<void> {
  const client = new RemoteRuntimeClient({
    command: typeof fixture === "string"
      ? [process.execPath, join(import.meta.dir, "fixtures", fixture), ...(mode ? [mode] : [])]
      : [...fixture],
  });
  try {
    await run(client);
  } finally {
    client.kill();
    await deadline(client.waitForExit(), "fixture process exit");
  }
}

function lifecycle(mode: string, run: (client: RemoteRuntimeClient) => Promise<void>): Promise<void> {
  return withClient("lifecycle-worker.ts", run, mode);
}

describe("remote runtime disconnects", () => {
  test("rejects a pending tool call without local fallback and exits on repeated kill", async () => {
    await withClient("hanging-worker.ts", async (client) => {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      const pending = client.execute("read", "pending-read", { path: "file.txt" });
      client.kill();
      client.kill();
      await expect(pending).rejects.toThrow(/Remote runtime (?:killed|exited)/);
      await deadline(client.waitForExit(), "killed process exit");
      client.kill();
      await expect(client.execute("read", "later-read", { path: "file.txt" })).rejects.toThrow("disconnected");
    });
  });

  test("kills a worker that ignores graceful shutdown past the deadline", async () => {
    await withClient("stubborn-worker.ts", async (client) => {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      await expect(client.close(20)).rejects.toThrow("Remote runtime shutdown timed out after 20ms");
      expect(client.isClosed).toBe(true);
      await deadline(client.waitForExit(), "shutdown-timeout process exit");
    });
  });

  test("fatal initialization frames terminate the process, not just the ready promise", async () => {
    await lifecycle("fatal-initialize", async (client) => {
      await expect(client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE)).rejects.toThrow("fixture initialization failed");
      await deadline(client.waitForExit(), "fatal initialization process exit");
    });
  });

  test("fatal session frames terminate the process after ready and close only once", async () => {
    await lifecycle("fatal-execute", async (client) => {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      let closed = 0;
      client.onClose(() => { closed++; });
      await expect(client.execute("read", "fatal-read", { path: "file.txt" })).rejects.toThrow("fixture session failed");
      // close() must still await the process even though the protocol is closed.
      await deadline(client.close(), "fatal session close");
      await deadline(client.waitForExit(), "fatal session process exit");
      client.kill();
      client.kill();
      expect(closed).toBe(1);
    });
  });

  test("cancels initialization after receipt but before ready and exits", async () => {
    await lifecycle("stall", async (client) => {
      const initializing = Promise.withResolvers<void>();
      client.onEvent(() => { initializing.resolve(); });
      const controller = new AbortController();
      const ready = client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE, undefined, { signal: controller.signal });
      void ready.catch(() => {}); // Also consume rejection if the receipt assertion fails.
      await deadline(initializing.promise, "worker initialize receipt");
      controller.abort(new Error("connect cancelled"));
      await expect(ready).rejects.toThrow("connect cancelled");
      await deadline(client.waitForExit(), "cancelled initialization process exit");
    });
  });

  test("already cancelled initialization exits without waiting for ready", async () => {
    await lifecycle("stall", async (client) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled before initialize"));
      await expect(client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE, undefined, { signal: controller.signal })).rejects.toThrow("cancelled before initialize");
      await deadline(client.waitForExit(), "pre-cancelled process exit");
    });
  });

  test("initialization timeout also terminates its process", async () => {
    await lifecycle("stall", async (client) => {
      await expect(client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE, 20)).rejects.toThrow("initialization timed out");
      await deadline(client.waitForExit(), "initialize-timeout process exit");
    });
  });

  test("normal close waits for actual exit, is repeatable, and tolerates later kill", async () => {
    await lifecycle("normal", async (client) => {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      const closing = client.close();
      expect(client.close()).toBe(closing);
      await deadline(closing, "normal close");
      expect(await deadline(client.waitForExit(), "normal process exit")).toBe(0);
      await client.close();
      client.kill();
      client.kill();
      expect(client.isClosed).toBe(true);
    });
  });

  test("a listener settling after close does not terminate graceful shutdown for an unsendable ACK", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-late-ack-"));
    const marker = join(root, "shutdown.txt");
    const client = new RemoteRuntimeClient({
      command: [process.execPath, join(import.meta.dir, "fixtures/lifecycle-worker.ts"), "late-ack", marker],
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.onEvent(() => { entered.resolve(); return release.promise; });
    try {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      await deadline(entered.promise, "completion listener entry");
      const closing = client.close();
      expect(client.isClosed).toBe(true);
      release.resolve();
      await deadline(closing, "late ACK graceful close");
      expect(await client.waitForExit()).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("shutdown received");
    } finally {
      release.resolve();
      client.kill();
      await deadline(client.waitForExit(), "late ACK fixture exit");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a real completion listener rejection still terminates a live transport", async () => {
    await lifecycle("late-ack", async (client) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<Error>();
      client.onClose(closed.resolve);
      client.onEvent(() => { entered.resolve(); return release.promise; });
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      await deadline(entered.promise, "rejecting listener entry");
      release.reject(new Error("completion listener failed"));
      expect((await deadline(closed.promise, "listener failure closure")).message).toBe("completion listener failed");
      expect(await deadline(client.waitForExit(), "listener failure exit")).not.toBe(0);
    });
  });

  test("close before ready rejects initialization and waits for process exit", async () => {
    await lifecycle("stall", async (client) => {
      const initializing = Promise.withResolvers<void>();
      client.onEvent(() => { initializing.resolve(); });
      const ready = client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      void ready.catch(() => {});
      await deadline(initializing.promise, "worker initialize receipt");
      const closing = client.close();
      await expect(ready).rejects.toThrow("Remote runtime closed");
      await deadline(closing, "close before ready");
      expect(await deadline(client.waitForExit(), "closed initialization process exit")).toBe(0);
    });
  });

  for (const bashServices of [false, true]) {
    test(`forwards negotiated bash service capability ${bashServices}`, async () => {
      await lifecycle("normal", async (client) => {
        const ready = await client.initialize("/remote/workspace", { ...OMP_RUNTIME_HANDSHAKE, bashServices });
        expect(ready.capabilities?.bashServices).toBe(bashServices);
        await client.close();
        expect(await deadline(client.waitForExit(), "negotiated worker exit")).toBe(0);
      });
    });
  }

  test("admits a ready message only after the requested resource binding is echoed", async () => {
    await lifecycle("normal", async (client) => {
      const resourceBinding = "requested-remote-binding";
      let admitted = false;
      const handshake = {
        ...OMP_RUNTIME_HANDSHAKE,
        validateReady(ready: Parameters<typeof OMP_RUNTIME_HANDSHAKE.validateReady>[0]) {
          expect(ready.resourceBinding).toBe(resourceBinding);
          OMP_RUNTIME_HANDSHAKE.validateReady(ready);
          admitted = true;
        },
      };
      const ready = await client.initialize("/remote/workspace", handshake, undefined, { resourceBinding });
      expect(ready.resourceBinding).toBe(resourceBinding);
      expect(admitted).toBe(true);
      await client.close();
      expect(await deadline(client.waitForExit(), "bound worker exit")).toBe(0);
    });
  });

  for (const mode of ["wrong-binding", "missing-binding"]) {
    test(`rejects and terminates a worker with ${mode} before admitting its tools`, async () => {
      await lifecycle(mode, async (client) => {
        let admitted = false;
        const handshake = {
          ...OMP_RUNTIME_HANDSHAKE,
          validateReady() { admitted = true; },
        };
        await expect(client.initialize("/remote/workspace", handshake, undefined, {
          resourceBinding: "requested-remote-binding",
        })).rejects.toThrow("Remote runtime resource binding mismatch");
        expect(admitted).toBe(false);
        expect(client.isClosed).toBe(true);
        await deadline(client.waitForExit(), "mismatched binding process exit");
      });
    });
  }

  test("failed spawn rejects initialization and settles its exit waiter", async () => {
    const client = new RemoteRuntimeClient({ command: ["/nonexistent/omp-ssh-remote-worker"] });
    try {
      await expect(client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE)).rejects.toThrow();
      expect(await deadline(client.waitForExit(), "failed spawn completion")).toBeNull();
    } finally {
      client.kill();
    }
  });
});

describe("native worker fatal lifecycle", () => {
  // Spawn directly: a client that kills on a fatal frame would mask a worker
  // that incorrectly waits for more stdin after sending its fatal error.
  async function runWorker(request: unknown): Promise<{ code: number | null; output: string; stdinOpen: boolean }> {
    const child = spawn(process.execPath, [join(import.meta.dir, "../src/worker.ts")], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const [code] = await deadline(exited, "native worker process exit", 15_000);
      const stdinOpen = !child.stdin.writableEnded;
      await deadline(closed, "native worker stdio close");
      return { code, output, stdinOpen };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
      await deadline(closed, "native worker cleanup");
    }
  }

  test("invalid cwd is fatal and exits while host stdin remains open", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-worker-invalid-cwd-"));
    try {
      const request: InitializeRequest = {
        type: "initialize", protocolVersion: PROTOCOL_VERSION, host: "omp",
        runtimeVersion: TOOL_RUNTIME_VERSION, cwd: join(root, "missing"), tools: [],
      };
      const result = await runWorker(request);
      expect(result.code).toBe(1);
      expect(result.stdinOpen).toBe(true);
      expect(JSON.parse(result.output.trim()).type).toBe("error");
      expect(result.output).toContain("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("malformed input is fatal and exits without host EOF", async () => {
    const result = await runWorker({ type: "not-a-request" });
    expect(result.code).toBe(1);
    expect(result.stdinOpen).toBe(true);
    expect(JSON.parse(result.output.trim()).type).toBe("error");
  }, 20_000);

  test("shutdown before initialization exits normally without host EOF", async () => {
    const result = await runWorker({ type: "shutdown" });
    expect(result.code).toBe(0);
    expect(result.stdinOpen).toBe(true);
    expect(result.output).toBe("");
  }, 20_000);
});


describe("transport settlement before inherited pipe closure", () => {
  async function withTransportWorker(
    mode: "stdout-eof" | "exit-pending" | "exit-result",
    run: (client: RemoteRuntimeClient, descendant: Promise<number>) => Promise<void>,
  ): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "omp-transport-settlement-"));
    const worker = join(root, "worker.ts");
    const descendantFile = join(root, "descendant.pid");
    const descendant = Promise.withResolvers<number>();
    let descendantPid: number | undefined;
    // The descendant announces readiness over IPC and then holds both inherited
    // output descriptors until the test releases it with SIGKILL in finally.
    const holder = String.raw`import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
const server = createServer();
server.listen(process.argv[1] + ".sock", async () => {
  await writeFile(process.argv[1], String(process.pid));
  process.send?.({ ready: true });
  process.disconnect?.();
});`;
    await writeFile(worker, String.raw`import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { encodeMessage, PROTOCOL_VERSION, REMOTE_TOOL_NAMES, TOOL_RUNTIME_VERSION } from ` + JSON.stringify(join(import.meta.dir, "../src/protocol.ts")) + String.raw`;
const mode = ` + JSON.stringify(mode) + String.raw`;
// Bun keeps fd 1 open after stdout.end(), so the EOF mode speaks the protocol on
// fd 3, the pipe's only reference, which it can genuinely close while staying alive.
const send = mode === "stdout-eof"
  ? async message => { writeSync(3, encodeMessage(message)); }
  : message => new Promise((resolve, reject) => {
    process.stdout.write(encodeMessage(message), error => error ? reject(error) : resolve());
  });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === "initialize") {
    await send({ type: "ready", protocolVersion: PROTOCOL_VERSION, host: "omp",
      hostVersion: request.hostVersion, runtimeVersion: TOOL_RUNTIME_VERSION,
      editMode: request.editMode, cwd: request.cwd,
      tools: REMOTE_TOOL_NAMES.map(name => ({ name, description: name, parameters: { type: "object" } })) });
  }
  if (request.type !== "execute") continue;
  if (mode === "stdout-eof") {
    closeSync(3);
    continue;
  }
  const child = spawn(process.execPath, ["-e", ` + JSON.stringify(holder) + ", " + JSON.stringify(descendantFile) + String.raw`], {
    stdio: ["ignore", process.stdout, process.stderr, "ipc"],
  });
  await once(child, "message");
  await send({ type: "event", event: "launch-completion", payload: { descendantPid: child.pid } });
  if (mode === "exit-result") {
    await send({ type: "result", id: request.id, result: { completedBeforeExit: true } });
  }
  process.exit(27);
}`);
    try {
      const command = mode === "stdout-eof"
        ? ["/bin/sh", "-c", 'exec "$0" "$1" 3>&1 1>/dev/null', process.execPath, worker]
        : [process.execPath, worker];
      await withClient(command, async client => {
        client.onEvent(event => {
          const pid = event.payload.descendantPid;
          if (typeof pid === "number") {
            descendantPid = pid;
            descendant.resolve(pid);
          }
        });
        await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
        await run(client, descendant.promise);
      });
    } finally {
      try {
        // The marker also covers a failure before the ready event reaches the host.
        descendantPid ??= Number(await readFile(descendantFile, "utf8").catch(() => "")) || undefined;
        if (descendantPid !== undefined) {
          try { process.kill(descendantPid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  test("stdout EOF rejects pending execution, notifies close once, and stops the still-running worker", async () => {
    await withTransportWorker("stdout-eof", async client => {
      const closed = Promise.withResolvers<Error>();
      let closeCalls = 0;
      client.onClose(error => { closeCalls++; closed.resolve(error); });
      const pending = client.execute("read", "stdout-eof", { path: "pending.txt" });
      void pending.catch(() => {});
      await deadline(closed.promise, "stdout EOF session closure");
      await expect(pending).rejects.toThrow("output stream ended");
      expect(client.isClosed).toBe(true);
      expect(closeCalls).toBe(1);
      // The fixture never exits on its own; only the client's stop ends it.
      expect(await deadline(client.waitForExit(), "client stop of the output-less worker")).toBeNull();
    });
  }, 15_000);

  test("worker exit rejects pending execution before its descendant releases inherited pipes", async () => {
    await withTransportWorker("exit-pending", async (client, descendant) => {
      const pending = client.execute("read", "exit-pending", { path: "pending.txt" });
      void pending.catch(() => {});
      const pid = await deadline(descendant, "inherited-pipe descendant readiness");
      expect(await deadline(client.waitForExit(), "worker exit with inherited pipes")).toBe(27);
      await expect(deadline(pending, "pending execution rejection after worker exit")).rejects.toThrow("exited with code 27");
      expect(client.isClosed).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
    });
  }, 15_000);

  test("a result written before exit resolves before inherited pipes close", async () => {
    await withTransportWorker("exit-result", async (client, descendant) => {
      const pending = client.execute("read", "exit-result", { path: "completed.txt" });
      void pending.catch(() => {});
      const pid = await deadline(descendant, "result-holding descendant readiness");
      expect(await deadline(client.waitForExit(), "worker exit after result")).toBe(27);
      expect(await deadline(pending, "result written before worker exit")).toEqual({ completedBeforeExit: true });
      expect(() => process.kill(pid, 0)).not.toThrow();
    });
  }, 15_000);
});
