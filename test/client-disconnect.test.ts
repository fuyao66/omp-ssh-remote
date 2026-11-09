import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient, type SpawnSpec } from "../src/client.ts";
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

async function withClient(fixture: string | readonly string[], run: (client: RemoteRuntimeClient) => Promise<void>, mode?: string, delivery?: SpawnSpec["delivery"]): Promise<void> {
  const client = new RemoteRuntimeClient({
    command: typeof fixture === "string"
      ? [process.execPath, join(import.meta.dir, "fixtures", fixture), ...(mode ? [mode] : [])]
      : [...fixture],
    ...(delivery ? { delivery } : {}),
  });
  try {
    await run(client);
  } finally {
    client.kill();
    await deadline(client.waitForExit(), "fixture process exit");
  }
}

function lifecycle(mode: string, run: (client: RemoteRuntimeClient) => Promise<void>, delivery?: SpawnSpec["delivery"]): Promise<void> {
  return withClient("lifecycle-worker.ts", run, mode, delivery);
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

  test("awaits asynchronous ready validation before initialization resolves", async () => {
    await lifecycle("normal", async client => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let initialized = false;
      const initializing = client.initialize("/remote/workspace", {
        ...OMP_RUNTIME_HANDSHAKE,
        async validateReady(ready) {
          await OMP_RUNTIME_HANDSHAKE.validateReady(ready);
          entered.resolve();
          await release.promise;
        },
      });
      void initializing.then(() => { initialized = true; }, () => {});
      try {
        await deadline(entered.promise, "asynchronous ready validation entry");
        expect(initialized).toBe(false);
        release.resolve();
        await deadline(initializing, "asynchronous ready validation delivery");
        expect(initialized).toBe(true);
      } finally {
        release.resolve();
      }
    });
  });

  test("asynchronous ready validation failure terminates initialization", async () => {
    await lifecycle("normal", async client => {
      await expect(client.initialize("/remote/workspace", {
        ...OMP_RUNTIME_HANDSHAKE,
        async validateReady() { throw new Error("asynchronous admission rejected"); },
      })).rejects.toThrow("asynchronous admission rejected");
      expect(client.isClosed).toBe(true);
      await deadline(client.waitForExit(), "asynchronous admission failure exit");
    });
  });

  for (const transition of ["abort", "close"] as const) {
    test(`${transition} during asynchronous ready validation cannot admit a closed client`, async () => {
      await lifecycle("normal", async client => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const controller = new AbortController();
        const initializing = client.initialize("/remote/workspace", {
          ...OMP_RUNTIME_HANDSHAKE,
          async validateReady(ready) {
            await OMP_RUNTIME_HANDSHAKE.validateReady(ready);
            entered.resolve();
            await release.promise;
          },
        }, undefined, { signal: controller.signal });
        void initializing.catch(() => {});
        try {
          await deadline(entered.promise, `${transition} held-validator entry`);
          let closing: Promise<void> | undefined;
          const reason = new Error("cancelled during ready validation");
          if (transition === "abort") controller.abort(reason);
          else {
            closing = client.close();
            void closing.catch(() => {});
          }
          expect(client.isClosed).toBe(true);
          release.resolve();
          await expect(deadline(initializing, `${transition} held-validator rejection`)).rejects.toThrow(
            transition === "abort" ? reason.message : "Remote runtime closed",
          );
          if (closing) {
            await deadline(closing, "graceful close during ready validation");
            expect(await client.waitForExit()).toBe(0);
          } else {
            await deadline(client.waitForExit(), "abort during ready validation process exit");
          }
        } finally {
          release.resolve();
        }
      });
    });
  }

  test("SIGKILL escalates a prior kill when the worker ignores SIGTERM", async () => {
    await lifecycle("ignore-sigterm", async client => {
      const worker = Promise.withResolvers<number>();
      client.onEvent(event => {
        if (typeof event.payload.workerPid === "number") worker.resolve(event.payload.workerPid);
      });
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      const pid = await deadline(worker.promise, "SIGTERM-resistant worker readiness");
      try {
        client.kill();
        expect(client.isClosed).toBe(true);
        client.kill("SIGKILL");
        await deadline(client.waitForExit(), "SIGKILL escalation exit");
      } finally {
        // Native cleanup must remain effective even if escalation regresses.
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    });
  });

  for (const channel of ["update", "capture"] as const) {
    test(`awaits asynchronous ${channel} delivery before settling its final result`, async () => {
      await lifecycle(`delivery-${channel}`, async client => {
        await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let delivered = false;
        let settled = false;
        const deliver = async () => {
          entered.resolve();
          await release.promise;
          delivered = true;
        };
        const pending = client.execute("read", `await-${channel}`, { path: "file.txt" }, undefined,
          channel === "update" ? deliver : undefined,
          channel === "capture" ? { onCapture: deliver } : {});
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
          await deadline(entered.promise, `${channel} delivery entry`);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(settled).toBe(false);
          release.resolve();
          expect(await deadline(pending, `${channel} delivery completion`)).toEqual({ delivered: true });
          expect(delivered).toBe(true);
        } finally {
          release.resolve();
        }
      }, "acknowledged");
    });

    test(`an asynchronous ${channel} delivery failure rejects execution and stops the worker`, async () => {
      await lifecycle(`delivery-${channel}`, async client => {
        await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
        const rejectDelivery = async () => { throw new Error(`${channel} delivery failed`); };
        const pending = client.execute("read", `reject-${channel}`, { path: "file.txt" }, undefined,
          channel === "update" ? rejectDelivery : undefined,
          channel === "capture" ? { onCapture: rejectDelivery } : {});
        await expect(pending).rejects.toThrow(`${channel} delivery failed`);
        expect(client.isClosed).toBe(true);
        await deadline(client.waitForExit(), `${channel} delivery failure exit`);
      }, "acknowledged");
    });
  }

  test("a direct asynchronous update observer may await another request on the same client", async () => {
    await lifecycle("delivery-update", async client => {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      const observed = Promise.withResolvers<unknown>();
      const pending = client.execute("read", "direct-observer-parent", { path: "parent.txt" }, undefined, async () => {
        try {
          const result = await client.execute("read", "direct-observer-nested", { path: "nested.txt" });
          observed.resolve(result);
        } catch (error) {
          observed.reject(error);
        }
      });
      void pending.catch(() => {});
      void observed.promise.catch(() => {});
      expect(await deadline(pending, "direct observer parent result")).toEqual({ delivered: true });
      expect(await deadline(observed.promise, "same-client observer nested result")).toEqual({ delivered: true });
      expect(client.isClosed).toBe(false);
    });
  });

  for (const channel of ["update", "capture"] as const) {
    test(`a direct asynchronous ${channel} observer rejection does not reject execution`, async () => {
      await lifecycle(`delivery-${channel}`, async client => {
        await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
        const observer = async () => { throw new Error(`${channel} observer failed`); };
        const pending = client.execute("read", `direct-${channel}-rejection`, { path: "file.txt" }, undefined,
          channel === "update" ? observer : undefined,
          channel === "capture" ? { onCapture: observer } : {});
        expect(await deadline(pending, `direct ${channel} result after observer rejection`)).toEqual({ delivered: true });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(client.isClosed).toBe(false);
      });
    });
  }

  for (const delivery of [undefined, "acknowledged"] as const) {
    for (const channel of ["update", "capture"] as const) {
      const mode = delivery ?? "direct";
      test(`${mode} ${channel} observers may return array.push's numeric result`, async () => {
        await lifecycle(`delivery-${channel}`, async client => {
          await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
          const observations: unknown[] = [];
          const observer = (value: unknown) => observations.push(value);
          const pending = client.execute("read", `${mode}-${channel}-numeric`, { path: "file.txt" }, undefined,
            channel === "update" ? observer : undefined,
            channel === "capture" ? { onCapture: observer } : {});
          expect(await deadline(pending, `${mode} ${channel} numeric callback result`)).toEqual({ delivered: true });
          expect(observations).toEqual(channel === "update"
            ? [{ phase: "delivering" }]
            : [{ kind: "output", start: 0, end: 8, text: "captured", open: false }]);
          expect(client.isClosed).toBe(false);
        }, delivery);
      });

      test(`${mode} ${channel} observers assimilate rejected non-Promise thenables`, async () => {
        await lifecycle(`delivery-${channel}`, async client => {
          await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
          const assimilated = Promise.withResolvers<void>();
          const failure = new Error(`${mode} ${channel} thenable rejected`);
          const observer = () => ({
            then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
              assimilated.resolve();
              reject(failure);
            },
          });
          const pending = client.execute("read", `${mode}-${channel}-thenable`, { path: "file.txt" }, undefined,
            channel === "update" ? observer : undefined,
            channel === "capture" ? { onCapture: observer } : {});
          void pending.catch(() => {});
          await deadline(assimilated.promise, `${mode} ${channel} thenable assimilation`);
          if (delivery === "acknowledged") {
            await expect(pending).rejects.toThrow(failure.message);
            expect(client.isClosed).toBe(true);
            await deadline(client.waitForExit(), `${mode} ${channel} thenable failure exit`);
          } else {
            expect(await deadline(pending, `${mode} ${channel} result despite thenable rejection`)).toEqual({ delivered: true });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(client.isClosed).toBe(false);
          }
        }, delivery);
      });
    }
  }

  test("does not await an Eval invocation before reading its parent's final result", async () => {
    await lifecycle("invoke-pending", async client => {
      await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      const pending = client.execute("eval", "pending-invocation", { code: "nested call" }, undefined, undefined, {
        async onInvoke(_invocation, signal) {
          entered.resolve(signal);
          await release.promise;
          return { late: true };
        },
      });
      void pending.catch(() => {});
      try {
        const signal = await deadline(entered.promise, "Eval invocation entry");
        expect(await deadline(pending, "Eval result with invocation outstanding")).toEqual({ delivered: true });
        expect(signal.aborted).toBe(true);
      } finally {
        release.resolve();
      }
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
    mode: "stdout-eof" | "stdout-eof-ignore-sigterm" | "exit-pending" | "exit-result" | "exit-capture-result" | "exit-capture-result-no-descendant" | "exit-chatty-descendant",
    run: (client: RemoteRuntimeClient, descendant: Promise<number>, worker: string) => Promise<void>,
    delivery?: SpawnSpec["delivery"],
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
  if (process.argv[2] === "chatty") {
    process.once("message", () => {
      process.disconnect?.();
      process.stdout.on("error", () => {});
      // Ignorable frames keep a finite byte snapshot valid even at a partial line.
      const frame = " ".repeat(4096) + "\n";
      const pump = () => {
        while (process.stdout.write(frame.repeat(16))) {}
        process.stdout.once("drain", pump);
      };
      pump();
    });
  } else {
    process.disconnect?.();
  }
});`;
    await writeFile(worker, String.raw`import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { encodeMessage, PROTOCOL_VERSION, REMOTE_TOOL_NAMES, TOOL_RUNTIME_VERSION } from ` + JSON.stringify(join(import.meta.dir, "../src/protocol.ts")) + String.raw`;
const mode = ` + JSON.stringify(mode) + String.raw`;
if (mode === "stdout-eof-ignore-sigterm") process.on("SIGTERM", () => {});
// Bun keeps fd 1 open after stdout.end(), so the EOF mode speaks the protocol on
// fd 3, the pipe's only reference, which it can genuinely close while staying alive.
const send = mode.startsWith("stdout-eof")
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
  if (mode.startsWith("stdout-eof")) {
    if (mode === "stdout-eof-ignore-sigterm") {
      await send({ type: "event", event: "launch-completion", payload: { workerPid: process.pid } });
    }
    closeSync(3);
    continue;
  }
  if (mode !== "exit-capture-result-no-descendant") {
    const child = spawn(process.execPath, ["-e", ` + JSON.stringify(holder) + ", " + JSON.stringify(descendantFile) + String.raw`, mode === "exit-chatty-descendant" ? "chatty" : "silent"], {
      stdio: ["ignore", process.stdout, process.stderr, "ipc"],
    });
    await once(child, "message");
    await send({ type: "event", event: "launch-completion", payload: { descendantPid: child.pid } });
    if (mode === "exit-chatty-descendant") child.send("start");
  }
  if (mode.startsWith("exit-capture-result")) {
    await send({ type: "event", event: "launch-completion", payload: { completionId: "unrelated-listener" } });
    await send({ type: "capture", id: request.id,
      capture: { kind: "output", start: 0, end: 8, text: "captured", open: false } });
    await send({ type: "result", id: request.id, result: "x".repeat(4 * 1024 * 1024) });
  } else if (mode === "exit-result") {
    await send({ type: "result", id: request.id, result: { completedBeforeExit: true } });
  }
  process.exit(27);
}`);
    try {
      const command = mode.startsWith("stdout-eof")
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
        await run(client, descendant.promise, worker);
      }, undefined, delivery);
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

  test("stdout EOF rejects pending execution before a SIGTERM-resistant worker exits", async () => {
    await withTransportWorker("stdout-eof-ignore-sigterm", async client => {
      const worker = Promise.withResolvers<number>();
      client.onEvent(event => {
        if (typeof event.payload.workerPid === "number") worker.resolve(event.payload.workerPid);
      });
      let exited = false;
      void client.waitForExit().then(() => { exited = true; });
      const pending = client.execute("read", "stdout-eof-ignore-sigterm", { path: "pending.txt" });
      void pending.catch(() => {});
      try {
        const pid = await deadline(worker.promise, "output-less resistant worker identity");
        await expect(deadline(pending, "EOF rejection before forced process exit")).rejects.toThrow("output stream ended");
        expect(client.isClosed).toBe(true);
        expect(exited).toBe(false);
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        // This is the first SIGKILL: pending must already have rejected above
        // while the real worker remained alive and its exit promise unresolved.
        client.kill("SIGKILL");
        await deadline(client.waitForExit(), "output-less resistant worker cleanup");
      }
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

  test("an inherited descendant writing continuously cannot extend the exit drain boundary", async () => {
    await withTransportWorker("exit-chatty-descendant", async (client, descendant) => {
      const pending = client.execute("read", "chatty-descendant", { path: "pending.txt" });
      void pending.catch(() => {});
      const pid = await deadline(descendant, "continuously writing descendant readiness");
      expect(await deadline(client.waitForExit(), "worker exit with continuously inherited output")).toBe(27);
      await expect(deadline(pending, "finite inherited-output snapshot")).rejects.toThrow("exited with code 27");
      expect(client.isClosed).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
    });
  }, 15_000);

  test("exit-drain disposal lets the client host exit while an inherited writer remains alive", async () => {
    await withTransportWorker("exit-chatty-descendant", async (_client, _descendant, worker) => {
      const { writeFile } = await import("node:fs/promises");
      const probe = join(worker, "..", "client-probe.ts");
      const report = join(worker, "..", "client-probe.json");
      await writeFile(probe, `
import { writeFile } from "node:fs/promises";
import { RemoteRuntimeClient } from ${JSON.stringify(join(import.meta.dir, "../src/client.ts"))};
import { OMP_RUNTIME_HANDSHAKE } from ${JSON.stringify(join(import.meta.dir, "../src/omp/runtime-contract.ts"))};
const client = new RemoteRuntimeClient({ command: [process.execPath, ${JSON.stringify(worker)}] });
let descendantPid;
client.onEvent(event => {
  if (typeof event.payload.descendantPid === "number") descendantPid = event.payload.descendantPid;
});
await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
let failure;
try {
  await client.execute("read", "disposal-probe", { path: "pending.txt" });
  throw new Error("execution unexpectedly resolved");
} catch (error) {
  failure = String(error);
}
const exitCode = await client.waitForExit();
await writeFile(${JSON.stringify(report)}, JSON.stringify({ descendantPid, exitCode, failure }));
// No process.exit(), kill(), or close(): natural host exit proves pipe disposal.
`);
      const host = spawn(process.execPath, [probe], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      host.stderr?.on("data", chunk => { stderr += String(chunk); });
      const exited = once(host, "exit");
      try {
        const [code, signal] = await deadline(exited, "natural client-host exit after drain disposal");
        expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
        const result = JSON.parse(await readFile(report, "utf8"));
        expect(result.exitCode).toBe(27);
        expect(result.failure).toContain("exited with code 27");
        expect(typeof result.descendantPid).toBe("number");
        expect(() => process.kill(result.descendantPid, 0)).not.toThrow();
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        await deadline(exited, "client-host probe cleanup");
      }
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

  for (const inheritedPipes of [false, true]) {
    test(`a withheld capture ACK preserves the exact 4 MiB final result after exit ${inheritedPipes ? "with" : "without"} inherited pipes`, async () => {
      const mode = inheritedPipes ? "exit-capture-result" : "exit-capture-result-no-descendant";
      await withTransportWorker(mode, async (client, descendant) => {
        const entered = Promise.withResolvers<void>();
        const releaseCapture = Promise.withResolvers<void>();
        const releaseEvent = Promise.withResolvers<void>();
        let captureDelivered = false;
        let settled = false;
        let closeCalls = 0;
        client.onClose(() => { closeCalls++; });
        client.onEvent(event => {
          if (event.payload.completionId === "unrelated-listener") return releaseEvent.promise;
        });
        const pending = client.execute("read", "capture-before-final-result", { path: "large.txt" }, undefined, undefined, {
          async onCapture(capture) {
            expect(capture).toEqual({ kind: "output", start: 0, end: 8, text: "captured", open: false });
            entered.resolve();
            await releaseCapture.promise;
            captureDelivered = true;
          },
        });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
          await deadline(entered.promise, "withheld capture callback entry");
          // The worker must flush all 4 MiB and actually exit while delivery is
          // withheld. Neither an exit callback nor a subsequent close may reject.
          expect(await deadline(client.waitForExit(), "worker exit before capture ACK")).toBe(27);
          await new Promise<void>(resolve => setImmediate(resolve));
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(closeCalls).toBe(0);
          expect(captureDelivered).toBe(false);
          releaseCapture.resolve();
          const result = await deadline(pending, "buffered 4 MiB result after capture ACK");
          expect(captureDelivered).toBe(true);
          expect(typeof result).toBe("string");
          expect((result as string).length).toBe(4 * 1024 * 1024);
          expect(result).toBe("x".repeat(4 * 1024 * 1024));
          const closed = Promise.withResolvers<void>();
          client.onClose(() => { closed.resolve(); });
          await deadline(closed.promise, "parser-drained transport closure");
          expect(closeCalls).toBe(1);
          if (inheritedPipes) {
            const pid = await deadline(descendant, "capture result descendant readiness");
            expect(() => process.kill(pid, 0)).not.toThrow();
          }
        } finally {
          releaseCapture.resolve();
          releaseEvent.resolve();
        }
      }, "acknowledged");
    }, 15_000);
  }
});
