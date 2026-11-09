import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { RpcMethod } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import { RemoteRuntimeClient, type RemoteRuntimeClientApi, type RemoteExecuteOptions, type RemoteInitializeOptions, type HostToolInvoker } from "./client.ts";
import { startRemoteWorkerPreparation, type PreparedRemoteWorker, type RemoteWorkerCacheAudit } from "./deploy.ts";
import type { RemoteRuntimeHandshake } from "./runtime-contract.ts";
import type { EventMessage, ReadyMessage } from "./protocol.ts";
import { buildSshWorkerCommand, type SshWorkerOptions } from "./ssh.ts";
import { socketRpc, ThreadCallbackBudget, type ThreadRpcConnection } from "./thread-rpc.ts";

export interface ThreadRuntimeAddress { path: string; capability: string }
export interface ThreadRuntimeConnection extends SshWorkerOptions {
  cwd: string;
  pythonLsp?: boolean;
  typescriptLsp?: boolean;
  cppLsp?: boolean;
}
interface ClientSink {
  event(event: EventMessage): Promise<void>;
  closed(error: Error): Promise<void>;
}
interface ClientHandle {
  initialize(cwd: string, handshake: RemoteRuntimeHandshake, timeoutMs?: number, options?: RemoteInitializeOptions): Promise<ReadyMessage>;
  execute(tool: string, toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal,
    update?: (value: unknown) => Promise<void>, options?: RemoteExecuteOptions): Promise<unknown>;
  stopService(name: string, instanceId: string): Promise<unknown>;
  close(timeoutMs?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  waitForExit(): Promise<number | null>;
}
interface RuntimeHandle {
  createClient(connection: ThreadRuntimeConnection, sink: ClientSink): Promise<ClientHandle>;
  prepare(signal?: AbortSignal, progress?: (stage: string) => Promise<void>): Promise<PreparedRemoteWorker>;
  close(): Promise<void>;
}
type Bootstrap = { attach: RpcMethod<[string], RuntimeHandle> };
type EmptyApi = Record<never, never>;

/** Actual processes and deployment producers live here, never in a native worker realm. */
export class ThreadRuntimeOwner {
  readonly address: ThreadRuntimeAddress;
  readonly #server: Server;
  readonly #directory: string;
  readonly #controller = new AbortController();
  readonly #clients = new Set<RemoteRuntimeClient>();
  readonly #prepared = new Set<PreparedRemoteWorker>();
  readonly #producers = new Set<Promise<void>>();
  readonly #commits = new Set<Promise<void>>();
  #rpc?: ThreadRpcConnection<Bootstrap, EmptyApi>;
  #socket?: Socket;
  #admissionTimer?: NodeJS.Timeout;
  #closing = false;
  #peerClosed = false;
  #closePromise?: Promise<void>;
  #disposePromise?: Promise<void>;
  readonly #budget: ThreadCallbackBudget;

  private constructor(directory: string, private readonly connection: () => ThreadRuntimeConnection,
    private readonly assertActive: () => void, private readonly onDisposed: () => void) {
    this.#directory = directory;
    const path = process.platform === "win32"
      ? `\\\\.\\pipe\\omp-remote-${process.pid}-${crypto.randomUUID()}`
      : join(directory, "runtime.sock");
    this.address = { path, capability: crypto.randomUUID() };
    this.#server = createServer(socket => this.#accept(socket));
    this.#server.on("error", error => this.#fail(error));
    this.#budget = new ThreadCallbackBudget(error => this.#fail(error), () => this.#closing);
  }

  static async create(connection: () => ThreadRuntimeConnection, assertActive: () => void,
    onDisposed: () => void = () => {}): Promise<ThreadRuntimeOwner> {
    if (!isMainThread) throw new Error("Remote process ownership requires the main thread");
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-"));
    const owner = new ThreadRuntimeOwner(directory, connection, assertActive, onDisposed);
    try {
      const listening = Promise.withResolvers<void>();
      owner.#server.once("error", listening.reject);
      owner.#server.listen(owner.address.path, () => { owner.#server.off("error", listening.reject); listening.resolve(); });
      await listening.promise;
      owner.#server.unref();
      owner.#admissionTimer = setTimeout(() => owner.#fail(new Error("Remote thread socket admission timed out")), 10_000);
      owner.#admissionTimer.unref?.();
      return owner;
    } catch (error) { await owner.dispose(); throw error; }
  }

  get peerClosed(): boolean { return this.#peerClosed; }

  #accept(socket: Socket): void {
    if (this.#socket || this.#closing) { socket.destroy(); return; }
    this.#socket = socket;
    let authenticated = false;
    this.#rpc = socketRpc<Bootstrap, EmptyApi>(socket, "remote-main-owner", () => {
      this.#peerClosed = true;
      void this.dispose().catch(() => {});
    });
    this.#rpc.link.handle("attach", capability => {
      if (authenticated || capability !== this.address.capability) throw new Error("Invalid remote thread socket capability");
      this.#assertWork();
      authenticated = true;
      clearTimeout(this.#admissionTimer);
      this.#server.close();
      return {
        createClient: async (connection, sink) => this.#createClient(connection, sink),
        prepare: async (signal, progress) => this.#prepare(signal, progress),
        close: () => this.close(),
      };
    });
  }

  #assertWork(): void {
    if (this.#closing) throw new Error("Remote thread owner is closing; local fallback is disabled");
    this.assertActive();
  }

  #fail(error: Error): void {
    void this.dispose().catch(() => {});
    this.#rpc?.close(error.message);
  }

  #createClient(requested: ThreadRuntimeConnection, sink: ClientSink): ClientHandle {
    this.#assertWork();
    const authoritative = this.connection();
    const paths = [authoritative, ...this.#prepared].find(value =>
      value.workerPath === requested.workerPath && value.pythonLspPack === requested.pythonLspPack &&
      value.typescriptLspPack === requested.typescriptLspPack && value.cppLspPack === requested.cppLspPack);
    if (!paths || requested.cwd !== authoritative.cwd) throw new Error("Remote thread transport settings changed");
    const client = new RemoteRuntimeClient({ command: buildSshWorkerCommand({ ...authoritative,
      workerPath: paths.workerPath, pythonLspPack: paths.pythonLspPack,
      typescriptLspPack: paths.typescriptLspPack, cppLspPack: paths.cppLspPack }), delivery: "acknowledged" });
    this.#clients.add(client);
    let exited = false;
    const release = () => { if (exited && client.isClosed) this.#clients.delete(client); };
    void client.waitForExit().then(() => { exited = true; release(); });
    client.onClose(error => {
      this.#budget.send([error], () => sink.closed(error), true);
      release();
    });
    client.onEvent(async event => {
      try { await this.#budget.call([event], () => sink.event(event)); }
      catch (error) { if (!this.#closing) throw error; }
    });
    return {
      initialize: async (cwd, handshake, timeoutMs, options = {}) => {
        this.#assertWork();
        if (cwd !== authoritative.cwd) throw new Error("Remote thread workspace changed");
        // Artifact paths do not identify a lease. The caller forwards its exact transaction/lease signal.
        const signal = AbortSignal.any([this.#controller.signal, ...(options.signal ? [options.signal] : [])]);
        return client.initialize(cwd, handshake, timeoutMs, { ...options, signal });
      },
      execute: (tool, toolCallId, args, signal, update, options = {}) => {
        this.#assertWork();
        const invoke = options.onInvoke;
        const onInvoke: HostToolInvoker | undefined = invoke ? (message, invocationSignal, onUpdate) =>
          invoke(message, invocationSignal, value => {
            this.#budget.send([value], async () => { await onUpdate(value); });
          }) : undefined;
        return client.execute(tool, toolCallId, args, signal, update, { ...options, onInvoke });
      },
      stopService: (name, instanceId) => { this.#assertWork(); return client.stopService(name, instanceId); },
      close: timeoutMs => client.close(timeoutMs),
      kill: async signal => { client.kill(signal); await client.waitForExit(); },
      waitForExit: () => client.waitForExit(),
    };
  }

  async #prepare(signal?: AbortSignal, progress?: (stage: string) => Promise<void>): Promise<PreparedRemoteWorker> {
    this.#assertWork();
    const operation = startRemoteWorkerPreparation({ ...this.connection(),
      signal: AbortSignal.any([this.#controller.signal, ...(signal ? [signal] : [])]),
      onProgress: progress ? stage => this.#budget.send([stage], () => progress(stage)) : undefined,
    });
    // Keep the delivery/disposal continuation, not merely the caller's cancellation race.
    const delivered = operation.ready.then(async prepared => {
      if (this.#closing) { await prepared.dispose(); throw new Error("Remote thread preparation was closed"); }
      this.#prepared.add(prepared);
      return prepared;
    });
    const settled = operation.settled.then(async () => { await delivered.catch(() => {}); });
    this.#producers.add(settled);
    void settled.then(() => { this.#producers.delete(settled); }, error => this.#fail(asError(error)));
    const prepared = await delivered;
    return {
      workerPath: prepared.workerPath, home: prepared.home, signal: prepared.signal,
      pythonLspPack: prepared.pythonLspPack, typescriptLspPack: prepared.typescriptLspPack, cppLspPack: prepared.cppLspPack,
      cacheAudit: prepared.cacheAudit,
      commitUsage: () => this.#commit(prepared),
      dispose: async () => { await prepared.dispose(); this.#prepared.delete(prepared); },
    };
  }

  #commit(prepared: PreparedRemoteWorker): Promise<RemoteWorkerCacheAudit> {
    this.#assertWork();
    const task = prepared.commitUsage();
    const settled = task.then(() => {}, () => {});
    this.#commits.add(settled);
    void settled.then(() => this.#commits.delete(settled));
    return task;
  }

  close(timeoutMs = 10_000): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const completion = Promise.withResolvers<void>();
    this.#closePromise = completion.promise;
    this.#closing = true;
    clearTimeout(this.#admissionTimer);
    this.#controller.abort(new Error("Remote thread owner closed"));
    void this.#closeResources(timeoutMs).then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #closeResources(timeoutMs: number): Promise<void> {
    const failures: unknown[] = [];
    const stopClient = async (client: RemoteRuntimeClient) => {
      try { await client.close(timeoutMs); }
      catch { client.kill("SIGKILL"); }
      await client.waitForExit();
      this.#clients.delete(client);
    };
    const results = await Promise.allSettled([
      ...[...this.#clients].map(stopClient),
      ...[...this.#prepared].map(async prepared => { await prepared.dispose(); this.#prepared.delete(prepared); }),
      ...this.#producers,
      ...this.#commits,
    ]);
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    // A producer canceled before delivery may still have entered its existing finally cleanup.
    const remaining = await Promise.allSettled([...this.#prepared].map(value => value.dispose()));
    for (const result of remaining) if (result.status === "rejected") failures.push(result.reason);
    this.#prepared.clear();
    if (failures.length) throw new AggregateError(failures, "Remote thread resource cleanup failed");
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const completion = Promise.withResolvers<void>();
    this.#disposePromise = completion.promise;
    void this.#disposeResources().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #disposeResources(): Promise<void> {
    try { await this.close(); }
    finally {
      this.#rpc?.close();
      this.#socket?.destroy();
      if (this.#server.listening) this.#server.close();
      await rm(this.#directory, { recursive: true, force: true });
      this.onDisposed();
    }
  }
}

export class ThreadRuntime {
  readonly #clients = new Set<ThreadRuntimeClient>();
  readonly #cleanupCalls = new Set<Promise<unknown>>();
  #disposePromise?: Promise<void>;
  #closed = false;
  private constructor(private readonly rpc: ThreadRpcConnection<EmptyApi, Bootstrap>, private readonly remote: RuntimeHandle) {}

  static async connect(address: ThreadRuntimeAddress): Promise<ThreadRuntime> {
    const socket = createConnection(address.path);
    let runtime: ThreadRuntime | undefined;
    let terminal: Error | undefined;
    const rpc = socketRpc<EmptyApi, Bootstrap>(socket, "remote-worker-facade", error => {
      terminal = error;
      runtime?.lost(error);
    });
    const timer = setTimeout(() => rpc.close("Remote thread socket connection timed out"), 10_000);
    timer.unref?.();
    try {
      const remote = await rpc.link.call("attach", address.capability);
      if (terminal || rpc.link.closed) throw terminal ?? new Error("Remote thread channel closed during authentication");
      runtime = new ThreadRuntime(rpc, remote);
      return runtime;
    } catch (error) { rpc.close(); throw error; }
    finally { clearTimeout(timer); }
  }

  get isClosed(): boolean { return this.#closed || this.#disposePromise !== undefined; }

  lost(error: Error): void {
    this.#closed = true;
    for (const client of this.#clients) client.lost(error);
  }

  async createClient(connection: ThreadRuntimeConnection): Promise<RemoteRuntimeClientApi> {
    if (this.#closed) throw new Error("Remote thread channel is closed");
    const client = new ThreadRuntimeClient(this, () => this.#clients.delete(client));
    this.#clients.add(client);
    try {
      client.handle = await this.remote.createClient(connection, {
        event: event => client.event(event),
        closed: async error => { client.lost(error); },
      });
      return client;
    } catch (error) { this.#clients.delete(client); client.lost(asError(error)); throw error; }
  }

  async prepare(signal?: AbortSignal, onProgress?: (stage: string) => void): Promise<PreparedRemoteWorker> {
    const prepared = await this.remote.prepare(signal, onProgress ? async stage => { invokeVoid(() => onProgress(stage), error => this.rpc.close(error.message)); } : undefined);
    const result: PreparedRemoteWorker = { ...prepared,
      commitUsage: async () => result.cacheAudit = await prepared.commitUsage(),
      dispose: () => this.cleanup(prepared.dispose()),
    };
    return result;
  }

  cleanup<T>(promise: Promise<T>): Promise<T> {
    this.#cleanupCalls.add(promise);
    void promise.then(() => this.#cleanupCalls.delete(promise), () => this.#cleanupCalls.delete(promise));
    return promise;
  }

  fire(promise: Promise<unknown>): void {
    void promise.catch(error => { if (!this.#closed && !this.#disposePromise) this.rpc.close(asError(error).message); });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const completion = Promise.withResolvers<void>();
    this.#disposePromise = completion.promise;
    void this.#disposeResources().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #disposeResources(): Promise<void> {
    try {
      if (!this.#closed) await this.remote.close();
      await Promise.allSettled([...this.#cleanupCalls]);
    } finally { this.#closed = true; this.rpc.close(); }
  }
}

class ThreadRuntimeClient implements RemoteRuntimeClientApi {
  handle!: ClientHandle;
  readonly #events = new Set<(event: EventMessage) => void | Promise<void>>();
  readonly #closedListeners = new Set<(error: Error) => void>();
  readonly #activation = Promise.withResolvers<void>();
  #closed = false;
  #closePromise?: Promise<void>;
  constructor(private readonly runtime: ThreadRuntime, private readonly release: () => void) { void this.#activation.promise.catch(() => {}); }
  get isClosed(): boolean { return this.#closed; }
  onClose(listener: (error: Error) => void): () => void {
    if (this.#closed) listener(new Error("Remote transport is closed")); else this.#closedListeners.add(listener);
    return () => { this.#closedListeners.delete(listener); };
  }
  onEvent(listener: (event: EventMessage) => void | Promise<void>): () => void {
    this.#events.add(listener); return () => { this.#events.delete(listener); };
  }
  activateEvents(): void { this.#activation.resolve(); }
  async event(event: EventMessage): Promise<void> {
    await this.#activation.promise;
    if (!this.#closed) await Promise.all([...this.#events].map(listener => listener(event)));
  }
  lost(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#activation.reject(error);
    for (const listener of this.#closedListeners) invokeVoid(() => listener(error), () => {});
    this.#closedListeners.clear(); this.#events.clear();
    this.release();
  }
  initialize(cwd: string, handshake: RemoteRuntimeHandshake, timeoutMs?: number, options?: RemoteInitializeOptions): Promise<ReadyMessage> {
    return this.handle.initialize(cwd, handshake, timeoutMs, options);
  }
  execute(tool: string, toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal,
    update?: (value: unknown) => void, options: RemoteExecuteOptions = {}): Promise<unknown> {
    const invocation = options.onInvoke;
    const onInvoke: HostToolInvoker | undefined = invocation ? (message, invocationSignal, onUpdate) =>
      invocation(message, invocationSignal, value => {
        // Native tool progress is a void source; never await it inside an invocation.
        const budget = this.#invokeBudget;
        budget.send([value], async () => { await onUpdate(value); });
      }) : undefined;
    return this.handle.execute(tool, toolCallId, args, signal,
      update ? async value => { invokeVoid(() => update(value), error => this.runtime.fire(Promise.reject(error))); } : undefined,
      { ...options, onInvoke,
        onCapture: options.onCapture ? async capture => { invokeVoid(() => options.onCapture!(capture), error => this.runtime.fire(Promise.reject(error))); } : undefined });
  }
  readonly #invokeBudget = new ThreadCallbackBudget(error => this.runtime.fire(Promise.reject(error)), () => this.#closed);
  stopService(name: string, instanceId: string): Promise<unknown> { return this.handle.stopService(name, instanceId); }
  close(timeoutMs?: number): Promise<void> {
    return this.#closePromise ??= this.runtime.cleanup(this.handle.close(timeoutMs).finally(() => this.lost(new Error("Remote runtime closed"))));
  }
  kill(signal?: NodeJS.Signals): void {
    this.lost(new Error("Remote runtime killed")); this.runtime.fire(this.handle.kill(signal));
  }
  waitForExit(): Promise<number | null> { return this.runtime.cleanup(this.handle.waitForExit()); }
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function invokeVoid(callback: () => unknown, fail: (error: Error) => void): void {
  let result: unknown;
  try { result = callback(); }
  catch (error) { fail(asError(error)); return; }
  if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(error => fail(asError(error)));
}
