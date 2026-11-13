import { BroadcastChannel, isMainThread } from "node:worker_threads";
import { resolve } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { RemoteConnectRequest } from "./connect-options.ts";
import type { RemoteWorkerCacheAudit } from "./deploy.ts";
import { assertFamilyLeaseActive, familyLease, getRemoteFamilyBroker, type FamilyBrokerFamily } from "./family-broker.ts";
import { ThreadRuntime, ThreadRuntimeOwner, type ThreadRuntimeAddress } from "./thread-runtime.ts";

export { isMainThread as isFamilyAuthorityThread };
export type FamilyConnection = Omit<RemoteConnectRequest, "cwd"> & {
  cwd: string; workerPath: string; pythonLspPack?: string; typescriptLspPack?: string; cppLspPack?: string;
};
export interface ThreadFamilyDescriptor {
  ownerSessionFile: string;
  localCwd: string;
  remoteCwd: string;
  connection: FamilyConnection;
  cacheAudit?: RemoteWorkerCacheAudit;
  /** The owner session's effective LSP switch; subagents combine it with task.enableLsp. */
  lspEnabled: boolean;
  generation: string;
  revocation: SharedArrayBuffer;
}
export interface ThreadMemberIdentity {
  agentId: string;
  registryGeneration: number;
  instanceKey: string;
  sessionFile: string;
}
export interface ThreadMemberControl {
  readonly token: string;
  readonly identity: ThreadMemberIdentity;
  close(timeoutMs?: number): Promise<void>;
}
export interface ThreadFamilySource extends FamilyBrokerFamily {
  localCwd: string;
  remoteCwd: string;
  connection: FamilyConnection;
  cacheAudit?: RemoteWorkerCacheAudit;
  lspEnabled: boolean;
  threadMembers?: Set<ThreadMemberControl>;
}
export type ThreadFamilyDecision = { kind: "local" } | { kind: "unavailable"; reason: string } |
  { kind: "active"; token: string; family: ThreadFamilyDescriptor; runtime: ThreadRuntimeAddress };

type Request = { op: "reserve"; identity: ThreadMemberIdentity; generation?: string } |
  { op: "commit"; token: string; generation: string; identity: ThreadMemberIdentity } |
  { op: "detach"; token: string; identity: ThreadMemberIdentity } | { op: "close"; token: string };
type Frame = { protocol: 1; from: string; to: string; id: string } &
  ({ kind: "request"; request: Request } | { kind: "reply"; value?: unknown; error?: string });
type Reservation = { peer: string; identity: ThreadMemberIdentity; family: ThreadFamilySource; control: ThreadMemberControl };
const CHANNEL_KEY = Symbol.for("omp-ssh-remote/thread-family-channel-v1");
const DEADLINE_MS = 10_000;

/** Metadata/control only. SSH clients and native session objects never cross this channel. */
export class ThreadFamilyBridge {
  readonly #channel: BroadcastChannel;
  readonly #peer = isMainThread ? "main" : crypto.randomUUID();
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly #callbacks = new Map<string, () => Promise<void>>();
  readonly #reservations = new Map<string, Reservation>();
  readonly #owners = new Map<string, Reservation & { owner: ThreadRuntimeOwner }>();
  readonly #runtimes = new Map<string, ThreadRuntime>();
  #stopRegistry?: () => void;
  #closed = false;
  #disposing = false;
  #disposePromise?: Promise<void>;

  constructor(channelName = `omp-ssh-remote/families/v1/${process.pid}`) {
    this.#channel = new BroadcastChannel(channelName);
    this.#channel.unref();
    this.#channel.onmessage = event => { void this.#receive(event.data); };
    this.#channel.onmessageerror = () => this.#failPending("Remote family control message could not be decoded");
    if (isMainThread) this.#stopRegistry = AgentRegistry.global().onChange(() => this.reap());
  }

  #send(frame: Frame): void { this.#channel.postMessage(frame); }

  async #call(to: string, request: Request): Promise<unknown> {
    if (this.#disposing && request.op !== "close" && request.op !== "detach") throw new Error("Remote family authority is shutting down");
    if (this.#closed) throw new Error("Remote family control channel is closed; local fallback is disabled");
    const id = crypto.randomUUID();
    const { promise, resolve: resolveValue, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error("Remote family control timed out; local fallback is disabled"));
    }, DEADLINE_MS);
    timer.unref?.();
    this.#pending.set(id, { resolve: resolveValue, reject, timer });
    try { this.#send({ protocol: 1, from: this.#peer, to, id, kind: "request", request }); }
    catch (error) {
      clearTimeout(timer); this.#pending.delete(id);
      reject(error);
    }
    return await promise;
  }

  async #receive(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const frame = value as Frame;
    if (frame.to !== this.#peer || frame.from === this.#peer || typeof frame.id !== "string") return;
    if (frame.protocol !== 1) { this.#failPending("Remote family control protocol mismatch"); return; }
    if (frame.kind === "reply") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error)); else pending.resolve(frame.value);
      return;
    }
    if (frame.kind !== "request") return;
    try {
      const result = frame.request.op === "close"
        ? await this.#closeMember(frame.request.token)
        : await this.#authorityRequest(frame.from, frame.request);
      this.#send({ protocol: 1, from: this.#peer, to: frame.from, id: frame.id, kind: "reply", value: result });
    } catch (error) {
      try { this.#send({ protocol: 1, from: this.#peer, to: frame.from, id: frame.id, kind: "reply", error: error instanceof Error ? error.message : "Remote family control failed" }); } catch {}
    }
  }

  #current(identity: ThreadMemberIdentity): boolean {
    const ref = AgentRegistry.global().get(identity.agentId);
    const file = ref?.session?.sessionManager.getSessionFile();
    return ref?.generation === identity.registryGeneration && ref.session?.instanceKey === identity.instanceKey &&
      file !== undefined && resolve(file) === resolve(identity.sessionFile);
  }

  /** Registry detach itself is silent; every operation consuming membership reaps first. */
  reap(): void {
    if (!isMainThread) return;
    for (const [token, entry] of this.#reservations) {
      if (this.#current(entry.identity)) continue;
      entry.family.threadMembers?.delete(entry.control);
      this.#reservations.delete(token);
    }
  }

  async #authorityRequest(peer: string, request: Exclude<Request, { op: "close" }>): Promise<unknown> {
    if (this.#disposing && request.op !== "detach") throw new Error("Remote family authority is shutting down");
    if (!isMainThread) throw new Error("Remote family authority is not available on this thread");
    this.reap();
    if (request.op !== "detach" && !this.#current(request.identity)) throw new Error("Remote family member session was replaced or detached");
    if (request.op === "reserve") {
      const broker = getRemoteFamilyBroker<ThreadFamilySource>();
      const family = broker.find(request.identity.sessionFile);
      if (!family) return { kind: "local" } satisfies ThreadFamilyDecision;
      try { assertFamilyLeaseActive(family); }
      catch { return { kind: "unavailable", reason: "Remote runtime family was revoked; local fallback is disabled" } satisfies ThreadFamilyDecision; }
      if (request.generation !== undefined && family.generation !== request.generation) throw new Error("Remote family generation changed before reconnect");
      const token = crypto.randomUUID();
      const identity = { ...request.identity, sessionFile: resolve(request.identity.sessionFile) };
      const control: ThreadMemberControl = { token, identity, close: async timeoutMs => {
        this.reap();
        const owner = this.#owners.get(token)?.owner;
        const results = await Promise.allSettled([
          ...(this.#reservations.has(token) && !owner?.peerClosed ? [this.#call(peer, { op: "close", token })] : []),
          ...(owner ? [owner.close(timeoutMs)] : []),
        ]);
        family.threadMembers?.delete(control); this.#reservations.delete(token);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Remote thread member cleanup failed");
      } };
      const owner = await ThreadRuntimeOwner.create(() => ({ ...family.connection, cwd: family.remoteCwd }), () => {
        if (this.#closed || this.#disposing || !this.#reservations.has(token) || !this.#current(identity)) {
          throw new Error("Remote family member session was replaced or detached");
        }
        assertFamilyLeaseActive(family);
      }, () => {
        family.threadMembers?.delete(control);
        this.#reservations.delete(token);
        this.#owners.delete(token);
      });
      try {
        if (this.#closed || this.#disposing || !this.#current(identity)) throw new Error("Remote family member session was replaced or detached");
        if (request.generation !== undefined && family.generation !== request.generation) throw new Error("Remote family generation changed during reconnect");
        assertFamilyLeaseActive(family);
      } catch (error) { await owner.dispose(); throw error; }
      (family.threadMembers ??= new Set()).add(control);
      broker.retain(family, identity.sessionFile);
      this.#reservations.set(token, { peer, identity, family, control });
      this.#owners.set(token, { peer, identity, family, control, owner });
      const descriptor: ThreadFamilyDescriptor = {
        ownerSessionFile: family.ownerSessionFile, localCwd: family.localCwd, remoteCwd: family.remoteCwd,
        connection: family.connection, cacheAudit: family.cacheAudit, lspEnabled: family.lspEnabled, ...familyLease(family),
      };
      return { kind: "active", token, family: descriptor, runtime: owner.address } satisfies ThreadFamilyDecision;
    }
    const entry = this.#reservations.get(request.token) ?? this.#owners.get(request.token);
    if (!entry) {
      if (request.op === "detach") return;
      throw new Error("Remote family attachment no longer exists");
    }
    if (entry.peer !== peer || entry.identity.instanceKey !== request.identity.instanceKey ||
        entry.identity.registryGeneration !== request.identity.registryGeneration || entry.identity.agentId !== request.identity.agentId ||
        entry.identity.sessionFile !== resolve(request.identity.sessionFile)) throw new Error("Remote family member identity changed");
    if (request.op === "detach") {
      entry.family.threadMembers?.delete(entry.control); this.#reservations.delete(request.token);
      await this.#owners.get(request.token)?.owner.dispose();
      return;
    }
    if (!this.#reservations.has(request.token)) throw new Error("Remote family attachment no longer exists");
    assertFamilyLeaseActive(entry.family);
    if (entry.family.generation !== request.generation) throw new Error("Remote family generation changed during attachment");
  }

  async reserve(identity: ThreadMemberIdentity, close: () => Promise<void>, generation?: string): Promise<ThreadFamilyDecision> {
    if (isMainThread) throw new Error("Main-thread members use the authoritative local broker directly");
    const result = await this.#call("main", { op: "reserve", identity, ...(generation !== undefined ? { generation } : {}) }) as ThreadFamilyDecision;
    if (!result || !["local", "unavailable", "active"].includes(result.kind)) throw new Error("Invalid remote family decision; local fallback is disabled");
    if (result.kind === "active") {
      if (typeof result.token !== "string" || !(result.family?.revocation instanceof SharedArrayBuffer) ||
          result.family.revocation.byteLength !== Int32Array.BYTES_PER_ELEMENT || typeof result.family.generation !== "string") {
        throw new Error("Invalid remote family lease; local fallback is disabled");
      }
      this.#callbacks.set(result.token, close);
      try {
        const runtime = await ThreadRuntime.connect(result.runtime);
        if (this.#disposing || this.#closed) { await runtime.dispose(); throw new Error("Remote family control is closing"); }
        this.#runtimes.set(result.token, runtime);
      } catch (error) {
        this.#callbacks.delete(result.token);
        await this.#call("main", { op: "detach", token: result.token, identity }).catch(() => {});
        throw error;
      }
    }
    return result;
  }

  runtime(token: string): ThreadRuntime {
    const runtime = this.#runtimes.get(token);
    if (!runtime) throw new Error("Remote thread transport is unavailable; local fallback is disabled");
    return runtime;
  }

  runtimeClosed(token: string): boolean {
    return this.#runtimes.get(token)?.isClosed ?? true;
  }

  async closeFamilyResources(family: ThreadFamilySource, timeoutMs?: number): Promise<void> {
    const results = await Promise.allSettled([...this.#owners.values()]
      .filter(entry => entry.family === family).map(entry => entry.owner.close(timeoutMs)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Remote thread family cleanup failed");
  }

  async commit(token: string, generation: string, identity: ThreadMemberIdentity): Promise<void> {
    await this.#call("main", { op: "commit", token, generation, identity });
  }

  async detach(token: string, identity: ThreadMemberIdentity): Promise<void> {
    this.#callbacks.delete(token);
    const runtime = this.#runtimes.get(token);
    this.#runtimes.delete(token);
    const results = await Promise.allSettled([
      ...(runtime ? [runtime.dispose()] : []),
    ]);
    try { await this.#call("main", { op: "detach", token, identity }); }
    catch (error) { results.push({ status: "rejected", reason: error }); }
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Remote thread detach failed");
  }

  async #closeMember(token: string): Promise<void> {
    const close = this.#callbacks.get(token);
    if (close) await close();
    this.#callbacks.delete(token);
  }

  #failPending(message: string): void {
    for (const entry of this.#pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.#pending.clear();
  }

  dispose(): Promise<void> {
    return this.#disposePromise ??= this.#dispose();
  }

  async #dispose(): Promise<void> {
    if (this.#closed) return;
    this.#disposing = true;
    const entries = [...new Map([...this.#reservations.values(), ...this.#owners.values()]
      .map(entry => [entry.control.token, entry])).values()];
    if (isMainThread) for (const family of new Set(entries.map(entry => entry.family))) {
      getRemoteFamilyBroker<ThreadFamilySource>().revoke(family);
    }
    const settled = await Promise.allSettled(isMainThread
      ? entries.map(entry => entry.control.close())
      : [...this.#callbacks.values()].map(close => close()));
    const owned = await Promise.allSettled(isMainThread
      ? [...this.#owners.values()].map(entry => entry.owner.dispose())
      : [...this.#runtimes.values()].map(runtime => runtime.dispose()));
    settled.push(...owned);
    this.#runtimes.clear();
    this.#closed = true;
    this.#stopRegistry?.();
    this.#failPending("Remote family control channel was disposed; local fallback is disabled");
    this.#callbacks.clear(); this.#channel.close();
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Remote family control cleanup failed");
  }
}

export function getThreadFamilyBridge(): ThreadFamilyBridge {
  const owner = globalThis as typeof globalThis & { [CHANNEL_KEY]?: ThreadFamilyBridge };
  return owner[CHANNEL_KEY] ??= new ThreadFamilyBridge();
}
