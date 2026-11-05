import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { RemoteRuntimeClient } from "../src/client.ts";
import { REMOTE_TOOL_NAMES } from "../src/protocol.ts";
import * as ssh from "../src/ssh.ts";
import * as identity from "../src/omp/host-identity.ts";
import * as deployment from "../src/deploy.ts";
import * as configuration from "../src/connect-options.ts";
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { Database } from "bun:sqlite";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubagentLifecycle } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { captureOmpToolSnapshot, projectOmpBashExecutionSchema } from "../src/omp/runtime-contract.ts";

function gate() {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  return { entered: entered.promise, release: () => released.resolve(), async wait() { entered.resolve(); await released.promise; } };
}
let discovery: ReturnType<typeof gate> | undefined, preparation: ReturnType<typeof gate> | undefined;
let commit: ReturnType<typeof gate> | undefined, admission: ReturnType<typeof gate> | undefined;
let directory = "", sequence = 0;
let nativeToolManifests: ReturnType<typeof captureOmpToolSnapshot>[] | undefined;
const clients: RemoteRuntimeClient[] = [];
const releases: string[] = [];
const initialize = RemoteRuntimeClient.prototype.initialize;
const tracking = spyOn(RemoteRuntimeClient.prototype, "initialize").mockImplementation(async function (this: RemoteRuntimeClient, ...args) {
  clients.push(this);
  if (admission) {
    const current = admission;
    this.onEvent(async () => { await current.wait(); });
  }
  return initialize.apply(this, args);
});
const worker = `import {createInterface} from "node:readline";
import {watch} from "node:fs";
const release=process.argv[1];
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.type==="initialize") {
  if(release) {
   const pending=new Promise(resolve=>{const w=watch(release.slice(0,release.lastIndexOf("/")),(_,n)=>{if(n===release.split("/").at(-1)){w.close();resolve();}})});
   console.log(JSON.stringify({type:"event",event:"lsp-operation-begin",payload:{}}));
   await pending;
  }
  console.log(JSON.stringify({type:"ready",protocolVersion:1,host:"omp",hostVersion:m.hostVersion,runtimeVersion:m.runtimeVersion,cwd:m.cwd,editMode:m.editMode,resourceBinding:m.resourceBinding,tools:JSON.parse(process.argv[2]||"null")??m.tools.map(name=>({name,description:name,parameters:{type:"object"}}))}));
 } else if(m.type==="execute") console.log(JSON.stringify({type:"result",id:m.id,result:{content:[{type:"text",text:"remote fixture"}],details:{pid:process.pid,path:m.args.path}}}));
 else if(m.type==="shutdown") process.exit(0);
}`;
const transport = spyOn(ssh, "buildSshWorkerCommand").mockImplementation(() => {
  const release = admission ? join(directory, `release-${sequence++}`) : "";
  if (release) releases.push(release);
  return [process.execPath, "-e", worker, release, JSON.stringify(nativeToolManifests ?? null)];
});
const hostIdentity = spyOn(identity, "resolveOmpHostVersion").mockResolvedValue("18.16.0");
const discoveryBoundary = spyOn(configuration, "loadConfiguredSshHosts").mockImplementation(async () => {
  await discovery?.wait(); return [];
});
const deploymentBoundary = spyOn(deployment, "prepareRemoteWorker").mockImplementation(async options => {
  await preparation?.wait(); options.signal!.throwIfAborted();
  const cacheAudit = { available: false as const, observedAt: "fixture", warning: "fixture cache" };
  return { workerPath: "/fixture/worker", home: "/remote", signal: options.signal!, cacheAudit, async dispose() {},
    async commitUsage() { await commit?.wait(); options.signal!.throwIfAborted(); return cacheAudit; } };
});
const { default: extension, closeRemoteFamily } = await import("../src/extension.ts");
const { getRemoteFamilyBroker } = await import("../src/family-broker.ts");
type Family = Parameters<typeof closeRemoteFamily>[0];
type State = Family["members"] extends Set<infer S> ? S : never;
const broker = getRemoteFamilyBroker<Family>();
const active = (globalThis as unknown as Record<symbol, Map<string, Family>>)[Symbol.for("omp-ssh-remote/session-families")]!;
type Harness = {
  sessionFile: string;
  nativeReads: string[];
  emit(name: string, event?: unknown): Promise<unknown>;
  command(name: string, args?: string): Promise<unknown>;
  setModel(model: { provider: string; api?: string } | undefined): void;
  activeTools: string[];
  context: ExtensionContext;
  aborts: string[];
  execute(name: string, args?: Record<string, unknown>): Promise<{ details?: unknown }>;
  state(family: Family): State;
  status(): Promise<{ mode: string }>;
};
const harnesses: Harness[] = [];
const nativeSessions: { session: AgentSession; auth: AuthStorage; id: string }[] = [];

/** Real native disposal and runner; the harness supplies the extension's registered handlers. */
async function nativeChild(child: Harness) {
  const settings = Settings.isolated();
  const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
  const modelRegistry = new ModelRegistry(auth, undefined, { settings, ignoreLocalModelConfig: true,
    fetch: async () => { throw new Error("Unexpected model registry network request"); } });
  const sessionManager = SessionManager.inMemory(directory), runtime = new ExtensionRuntime();
  let shutdowns = 0;
  const shutdown = Promise.withResolvers<void>();
  const loaded = await loadExtensionFromFactory(pi => {
    pi.on("session_shutdown", async () => {
      shutdowns++;
      await child.emit("session_shutdown");
      shutdown.resolve();
    });
  }, directory, new EventBus(), runtime);
  const runner = new ExtensionRunner([loaded], runtime, directory, sessionManager, modelRegistry,
    undefined, settings, undefined, undefined, child.context.agent);
  const session = new AgentSession({
    agent: new Agent({ initialState: { model: modelRegistry.getAll()[0], systemPrompt: [], tools: [], messages: [] } }),
    sessionManager, settings, modelRegistry, extensionRunner: runner,
    agentId: child.context.agent.id, agentKind: "sub", memoryEnabled: false,
  });
  nativeSessions.push({ session, auth, id: child.context.agent.id });
  await initializeExtensions(session, {
    reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw error; },
  });
  await mkdir(dirname(child.sessionFile), { recursive: true });
  await writeFile(child.sessionFile, "");
  const ref = AgentRegistry.global().register({
    id: child.context.agent.id, displayName: child.context.agent.name, kind: "sub",
    parentId: child.context.agent.parentId, session, sessionFile: child.sessionFile, status: "running",
  });
  return { session, ref, shutdowns: () => shutdowns, shutdown: shutdown.promise };
}

/** Model-free native session reconstruction with the real remote extension. */
async function nativeRemoteChild(manager: SessionManager, id: string, parentId: string, expected?: AgentRef) {
  if (!nativeToolManifests) {
    const native = await createNativeWorkerRuntime(directory);
    try {
      nativeToolManifests = REMOTE_TOOL_NAMES.map(name => {
        const snapshot = { ...captureOmpToolSnapshot(native.tools[name]), description: native.tools[name].description };
        return name === "bash" ? { ...snapshot, parameters: projectOmpBashExecutionSchema(snapshot.parameters) } : snapshot;
      });
    } finally { await native.dispose(); }
  }
  const settings = Settings.isolated();
  const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
  const modelRegistry = new ModelRegistry(auth, undefined, { settings, ignoreLocalModelConfig: true,
    fetch: async () => { throw new Error("Unexpected model registry network request"); } });
  const runtime = new ExtensionRuntime();
  const loaded = await loadExtensionFromFactory(extension, directory, new EventBus(), runtime);
  const runner = new ExtensionRunner([loaded], runtime, directory, manager, modelRegistry,
    undefined, settings, undefined, undefined, { kind: "sub", id, name: id, depth: 1, parentId });
  const errors: string[] = [];
  runner.onError(error => { errors.push(error.error); });
  const session = new AgentSession({
    agent: new Agent({ initialState: { model: modelRegistry.getAll()[0], systemPrompt: [], tools: [],
      messages: manager.buildSessionContext().messages } }),
    sessionManager: manager, settings, modelRegistry, extensionRunner: runner,
    agentId: id, agentKind: "sub", memoryEnabled: false,
  });
  nativeSessions.push({ session, auth, id });
  // Hold only the rebuilt session: delivery still traverses native IrcBus and
  // ensureLive, but a deferred peer message cannot initiate a provider request.
  if (expected) session.holdIrcWakes();
  const registry = AgentRegistry.global(), file = manager.getSessionFile()!;
  const ref = expected ?? registry.register({
    id, displayName: id, kind: "sub", parentId, session, sessionFile: file, status: "running",
  });
  if (expected && !registry.attachSession(id, session, file, expected)) {
    throw new Error("Revival lost native ref ownership");
  }
  if (expected) registry.setStatus(id, "running", expected);
  try {
    await initializeExtensions(session, {
      reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); },
    });
  } catch (error) {
    await session.dispose();
    throw error;
  }
  return { session, ref, errors };
}
const settle = (promise: Promise<unknown>): Promise<Error | null> => promise.then(() => null, (error: Error) => error);
async function harness(sessionFile = join(directory, "owner.jsonl"), agent: ExtensionContext["agent"] = { kind: "main", id: `owner-${crypto.randomUUID()}`, name: "owner", depth: 0 }): Promise<Harness> {
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, { handler: Function }>();
  const nativeReads: string[] = [];
  const activeTools = ["read", "bash"], aborts: string[] = [];
  const ctx = { cwd: directory, model: undefined, agent, sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [] },
    abort() { aborts.push("abort"); },
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {} },
    async invokeTool(params: { path?: string; command?: string }) {
      if (params.path) { nativeReads.push(params.path); await readFile(params.path); }
      if (params.command) await writeFile(join(directory, "native-bash"), params.command);
      return { content: [{ type: "text", text: "local fixture" }] };
    },
  } as unknown as ExtensionContext;
  await extension({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
    on: (name: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(name, hook),
    getActiveTools: () => activeTools, getAllTools: () => REMOTE_TOOL_NAMES.map(name => ({
      name, description: name, parameters: { type: "object" }, sourceInfo: { source: "builtin" },
    })),
  } as unknown as ExtensionAPI);
  const h: Harness = { sessionFile, nativeReads, activeTools, context: ctx, aborts,
    setModel(model) { Object.assign(ctx, { model }); },
    emit: async (name: string, event = {}) => await hooks.get(name)!(event, ctx),
    command: async (name: string, args = "") => await commands.get(name)!.handler(args, ctx),
    execute: async (name: string, args = {}) => await tools.get(name)!.execute(name, args, undefined, undefined, ctx),
    state: (family: Family): State => [...family.members].find(member => member.sessionFile === sessionFile)!,
    status: async () => (await tools.get("remote_workspace_status")!.execute("status", {}, undefined, undefined, ctx)).details as { mode: string },
  };
  harnesses.push(h); await h.emit("session_start"); return h;
}
async function connected() {
  const owner = await harness();
  await owner.execute("remote_connect", { target: "fixture.invalid", cwd: "/remote" });
  return { owner, family: active.get(owner.sessionFile)! };
}
async function releaseAdmission() {
  admission?.release();
  await Promise.all(releases.map(path => writeFile(path, "ready")));
}
beforeEach(async () => { directory = await mkdtemp("/tmp/omp-lifecycle-"); });
afterEach(async () => {
  for (const { session, auth, id } of nativeSessions.splice(0)) {
    await session.dispose();
    AgentRegistry.global().unregister(id);
    auth.close();
  }
  discovery?.release(); preparation?.release(); commit?.release(); await releaseAdmission();
  for (const client of clients) client.kill();
  await Promise.all(clients.map(client => client.waitForExit()));
  for (const h of harnesses) await h.emit("session_shutdown").catch(() => {});
  clients.length = releases.length = harnesses.length = 0;
  discovery = preparation = commit = admission = undefined;
  nativeToolManifests = undefined;
  await rm(directory, { recursive: true, force: true });
});
afterAll(() => {
  for (const spy of [tracking, transport, hostIdentity, discoveryBoundary, deploymentBoundary]) spy.mockRestore();
});

test("owner exit cannot resurrect a child reconnect suspended at usage commit", async () => {
  const { owner, family } = await connected();
  const child = await harness(`${family.root}/subagent/child.jsonl`), state = child.state(family);
  commit = gate();
  const reconnect = settle(child.execute("remote_reconnect", { force: true }));
  await commit.entered;
  await owner.execute("remote_exit", { force: true });
  commit.release();
  const error = await reconnect;
  expect(error, "revoked reconnect must reject").toBeInstanceOf(Error);
  expect(state.client?.isClosed ?? true, "revoked child must not publish a live client").toBe(true);
  expect(state.connectionError, "revocation must remain unavailable").toBeTruthy();
});

test("child shutdown cancels pending admission without republishing its binding", async () => {
  const { family } = await connected();
  admission = gate();
  const childFile = `${family.root}/subagent/pending.jsonl`;
  const attaching = settle(harness(childFile));
  await admission.entered;
  const child = harnesses.at(-1)!, state = child.state(family), pending = clients.at(-1)!;
  await child.emit("session_shutdown");
  const detachedBinding = state.binding;
  await releaseAdmission(); await attaching;
  expect(state.client?.isClosed ?? true, "shutdown must not publish the admitted client").toBe(true);
  expect(state.binding, "shutdown binding must not be replaced by late ready").toBe(detachedBinding);
  await pending.waitForExit();
  expect(pending.isClosed).toBe(true);
});

test("slash exit cancels owner connect during SSH configuration discovery", async () => {
  const owner = await harness(); discovery = gate();
  const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid", cwd: "/remote" }));
  await discovery.entered; await owner.command("remote-exit"); discovery.release();
  const error = await connecting;
  expect(error, "exit must cancel discovery-stage connect").toBeInstanceOf(Error);
  expect(error?.message).toMatch(/cancel|abort|exit/i);
  expect((await owner.status()).mode).toBe("local");
  expect(broker.hasOwner(owner.sessionFile)).toBe(false);
});

test("session navigation cancels deployment before an old-session family is published", async () => {
  const owner = await harness(); preparation = gate();
  const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid", cwd: "/remote" }));
  await preparation.entered; await owner.emit("session_before_switch"); preparation.release();
  const error = await connecting;
  expect(error, "navigation must cancel deployment-stage connect").toBeInstanceOf(Error);
  expect(error?.message).toMatch(/cancel|abort|navigat|switch/i);
  expect(broker.hasOwner(owner.sessionFile)).toBe(false);
  expect((await owner.status()).mode).toBe("local");
});

test("forced reconnect rotates binding, drops remote proposals, and routes to the new worker", async () => {
  const { owner, family } = await connected(), state = owner.state(family);
  const old = state.client!, binding = state.binding;
  const previous = await owner.execute("read", { path: "/remote/before" });
  state.proposalSources.push("local", "remote", "remote");
  const result = await owner.execute("remote_reconnect", { force: true });
  await old.waitForExit();
  expect(old.isClosed).toBe(true); expect(state.binding).not.toBe(binding);
  expect(state.client).not.toBe(old); expect(state.proposalSources).toEqual(["local"]);
  expect(result.details).toMatchObject({ droppedRemoteProposals: 2, replacedLiveTransport: true });
  const next = await owner.execute("read", { path: "/remote/after" });
  expect(next.details).toMatchObject({ path: "/remote/after" });
  expect((next.details as { pid: number }).pid).not.toBe((previous.details as { pid: number }).pid);
  expect(owner.nativeReads).toEqual([]);
});

test("transport death rejects wrapped filesystem tools without native local fallback", async () => {
  const { owner, family } = await connected(), state = owner.state(family);
  const marker = join(directory, "local-only"); await writeFile(marker, "local sentinel");
  state.client!.kill(); await state.client!.waitForExit();
  await expect(owner.execute("read", { path: marker })).rejects.toThrow(/disconnect|unavailable|closed/i);
  await expect(owner.execute("bash", { command: "create local marker" })).rejects.toThrow(/disconnect|unavailable|closed/i);
  expect(owner.nativeReads).toEqual([]);
  expect(await readFile(marker, "utf8")).toBe("local sentinel");
  expect(await Bun.file(join(directory, "native-bash")).exists()).toBe(false);
});

test("connect ignores live idle children from a previous transcript root", async () => {
  const owner = await harness(undefined, { kind: "main", id: "Main", name: "owner", depth: 0 });
  const registry = AgentRegistry.global(), id = "previous-root-child";
  const ref = registry.register({ id, displayName: "previous helper", kind: "sub", parentId: "Main",
    session: {} as never, sessionFile: join(directory, "previous", "subagent", "child.jsonl"), status: "idle" });
  try {
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    expect((await owner.status()).mode).toBe("remote");
    expect(ref.session).not.toBeNull();
    expect(ref.status).toBe("idle");
  } finally { registry.unregister(id); }
});

test("connect refuses running grandchildren through parked intermediates", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  const ownerId = owner.context.agent.id;
  const child = `${ownerId}-child`, grandchild = `${ownerId}-grandchild`;
  registry.register({ id: ownerId, displayName: "owner", kind: "main", session: {
    sessionManager: owner.context.sessionManager, getToolByName: () => undefined, settings: Settings.isolated(),
    getAdvisorStats: () => ({ configured: false, advisors: [] }),
  } as never });
  registry.register({ id: child, displayName: "parked parent", kind: "sub", parentId: ownerId,
    sessionFile: owner.sessionFile.replace(/\.jsonl$/, "/subagent/parent.jsonl"), session: null, status: "parked" });
  registry.register({ id: grandchild, displayName: "active grandchild", kind: "sub", parentId: child,
    sessionFile: owner.sessionFile.replace(/\.jsonl$/, "/subagent/parent/subagent/child.jsonl"), session: {} as never, status: "running" });
  try {
    for (const connect of [
      () => owner.execute("remote_connect", { target: "fixture.invalid" }),
      () => owner.command("remote-connect", "fixture.invalid"),
    ]) {
      const error = await settle(connect());
      expect(error?.message).toContain(`active grandchild (${grandchild}, running)`);
      expect(error?.message).toContain("open /hub and press x");
    }
    expect((await owner.status()).mode).toBe("local");
    registry.detachSession(grandchild); registry.setStatus(grandchild, "parked");
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    expect((await owner.status()).mode).toBe("remote");
  } finally { for (const id of [grandchild, child, ownerId]) registry.unregister(id); }
});

test("connect parks this-root idle children through native lifecycle disposal", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  const child = await harness(owner.sessionFile.replace(/\.jsonl$/, "/subagent/idle.jsonl"), {
    kind: "sub", id: "idle-helper", name: "idle helper", depth: 1, parentId: owner.context.agent.id,
  });
  const native = await nativeChild(child);
  registry.setStatus(native.ref.id, "idle");
  AgentLifecycleManager.global().adopt(native.ref.id, { idleTtlMs: 0 });
  await owner.execute("remote_connect", { target: "fixture.invalid" });
  expect(native.ref.session).toBeNull();
  expect(native.ref.status).toBe("parked");
  expect(native.shutdowns()).toBe(1);
  expect(native.session.isDisposed).toBe(true);
  expect((await child.status()).mode).toBe("local");
  expect((await owner.status()).mode).toBe("remote");
});

test("connect parking releases idle child extension state from a revoked family", async () => {
  const { owner, family } = await connected();
  const child = await harness(`${family.root}/subagent/retained-idle.jsonl`, {
    kind: "sub", id: "retained-idle", name: "retained idle", depth: 1, parentId: owner.context.agent.id,
  });
  const state = child.state(family), worker = state.client!;
  const native = await nativeChild(child);
  AgentRegistry.global().setStatus(native.ref.id, "idle");
  AgentLifecycleManager.global().adopt(native.ref.id, { idleTtlMs: 0 });
  await owner.execute("remote_exit", { force: true });
  expect(family.members.has(state)).toBe(true);
  await owner.execute("remote_connect", { target: "fixture.invalid" });
  expect(native.ref.status).toBe("parked");
  expect(native.ref.session).toBeNull();
  expect(native.shutdowns()).toBe(1);
  expect(state.sessionFile).toBeUndefined();
  expect(state.hostContext).toBeUndefined();
  expect(state.family).toBeUndefined();
  expect(state.client).toBeUndefined();
  expect(family.members.size).toBe(0);
  await worker.waitForExit();
  expect(worker.isClosed).toBe(true);
  expect((await owner.status()).mode).toBe("remote");
});

test.each(["admission", "publication"] as const)(
  "connect refuses an idle child with a deferred native IRC wake at %s", async boundary => {
    const owner = await harness();
    if (boundary === "publication") commit = gate();
    const connecting = boundary === "publication"
      ? settle(owner.execute("remote_connect", { target: "fixture.invalid" })) : undefined;
    if (connecting) await commit!.entered;
    const child = await harness(owner.sessionFile.replace(/\.jsonl$/, "/subagent/pending-irc.jsonl"), {
      kind: "sub", id: "pending-irc", name: "pending IRC helper", depth: 1, parentId: owner.context.agent.id,
    });
    const native = await nativeChild(child);
    native.session.holdIrcWakes();
    await native.session.deliverIrcMessage({
      id: "deferred-fixture-message", from: "fixture-peer", to: native.ref.id,
      body: "Do not lose this accepted message.", ts: Date.now(),
    });
    await finalizeSubagentLifecycle({
      id: native.ref.id, session: native.session, aborted: false, keepAlive: true,
      isolated: false, agentIdleTtlMs: 0, reviveSession: null,
    });
    expect(native.ref.status).toBe("idle");
    expect(native.session.ircWakesPending).toBe(true);
    expect(native.session.hasQueuedIrcFrom("fixture-peer")).toBe(true);
    commit?.release();
    const error = await (connecting ?? settle(owner.execute("remote_connect", { target: "fixture.invalid" })));
    expect(error?.message).toContain("pending IRC helper");
    expect(error?.message).toContain("has pending messages; retry shortly");
    expect(native.ref.session).toBe(native.session);
    expect(native.ref.status).toBe("idle");
    expect(native.shutdowns()).toBe(0);
    expect(native.session.hasQueuedIrcFrom("fixture-peer")).toBe(true);
    expect((await owner.status()).mode).toBe("local");
  },
);

test("connect refuses an unadopted idle child rather than silently leaving it live", async () => {
  const owner = await harness(), registry = AgentRegistry.global(), id = "unadopted-helper";
  registry.register({ id, displayName: "unadopted helper", kind: "sub", parentId: owner.context.agent.id,
    session: {} as never, sessionFile: owner.sessionFile.replace(/\.jsonl$/, "/subagent/unadopted.jsonl"), status: "idle" });
  try {
    await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/unadopted helper.*idle/);
    expect((await owner.status()).mode).toBe("local");
  } finally { registry.unregister(id); }
});

test("connect cancels native parking if the idle child starts running before detach", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  const child = await harness(owner.sessionFile.replace(/\.jsonl$/, "/subagent/waking.jsonl"), {
    kind: "sub", id: "waking-child", name: "waking child", depth: 1, parentId: owner.context.agent.id,
  });
  const native = await nativeChild(child), lifecycle = AgentLifecycleManager.global();
  registry.setStatus(native.ref.id, "idle");
  lifecycle.adopt(native.ref.id, { idleTtlMs: 0 });
  const park = lifecycle.park;
  const racing = spyOn(lifecycle, "park").mockImplementation(function (id) {
    const pending = park.call(lifecycle, id);
    registry.setStatus(id, "running");
    return pending;
  });
  try {
    await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/waking child.*running/);
    expect(native.ref.session).toBe(native.session);
    expect(native.ref.status).toBe("running");
    expect(native.shutdowns()).toBe(0);
    expect((await owner.status()).mode).toBe("local");
  } finally { racing.mockRestore(); }
});

test("connect refuses native parking when session disposal fails", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  const child = await harness(owner.sessionFile.replace(/\.jsonl$/, "/subagent/failing.jsonl"), {
    kind: "sub", id: "failing-child", name: "failing child", depth: 1, parentId: owner.context.agent.id,
  });
  const native = await nativeChild(child);
  registry.setStatus(native.ref.id, "idle");
  AgentLifecycleManager.global().adopt(native.ref.id, { idleTtlMs: 0 });
  const failure = spyOn(native.session, "dispose").mockRejectedValue(new Error("fixture disposal failure"));
  try {
    await expect(owner.execute("remote_connect", { target: "fixture.invalid" }))
      .rejects.toThrow(/could not be parked.*fixture disposal failure.*failing child/);
    expect((await owner.status()).mode).toBe("local");
    expect(broker.hasOwner(owner.sessionFile)).toBe(false);
  } finally { failure.mockRestore(); }
});

test("connect parks a child that becomes idle during deployment before publishing", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  commit = gate();
  const connecting = owner.execute("remote_connect", { target: "fixture.invalid" });
  await commit.entered;
  const child = await harness(owner.sessionFile.replace(/\.jsonl$/, "/subagent/late-idle.jsonl"), {
    kind: "sub", id: "late-idle", name: "late idle", depth: 1, parentId: owner.context.agent.id,
  });
  const native = await nativeChild(child);
  registry.setStatus(native.ref.id, "idle");
  AgentLifecycleManager.global().adopt(native.ref.id, { idleTtlMs: 0 });
  commit.release();
  await connecting;
  expect(native.ref.session).toBeNull();
  expect(native.ref.status).toBe("parked");
  expect(native.shutdowns()).toBe(1);
  expect((await owner.status()).mode).toBe("remote");
});

test("connect refuses a child that starts running before publication and kills the unpublished worker", async () => {
  const owner = await harness(), registry = AgentRegistry.global(), id = "late-wake";
  const ref = registry.register({ id, displayName: "late wake", kind: "sub", parentId: owner.context.agent.id,
    session: null, sessionFile: owner.sessionFile.replace(/\.jsonl$/, "/subagent/late.jsonl"), status: "parked" });
  commit = gate();
  const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid" }));
  try {
    await commit.entered;
    registry.setStatus(id, "running");
    commit.release();
    expect((await connecting)?.message).toContain("late wake (late-wake, running)");
    expect((await owner.status()).mode).toBe("local");
    expect(broker.hasOwner(owner.sessionFile)).toBe(false);
    const pending = clients.at(-1)!;
    await pending.waitForExit();
    expect(pending.isClosed).toBe(true);
    expect(ref.session).toBeNull();
  } finally { registry.unregister(id); }
});

test("connect refuses initializing children without transcripts but ignores a proven other-root lineage", async () => {
  const owner = await harness(undefined, { kind: "main", id: "Main", name: "owner", depth: 0 });
  const registry = AgentRegistry.global();
  registry.register({ id: "other-parent", displayName: "other parent", kind: "sub", parentId: "Main",
    session: null, sessionFile: join(directory, "other", "subagent", "parent.jsonl"), status: "parked" });
  registry.register({ id: "other-initializing", displayName: "other initializing", kind: "sub",
    parentId: "other-parent", session: null, status: "running" });
  registry.register({ id: "initializing", displayName: "new helper", kind: "sub",
    parentId: "Main", session: null, status: "running" });
  try {
    const error = await settle(owner.execute("remote_connect", { target: "fixture.invalid" }));
    expect(error?.message).toContain("new helper (initializing, running)");
    expect(error?.message).not.toContain("other initializing");
    registry.unregister("initializing");
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    expect((await owner.status()).mode).toBe("remote");
  } finally { for (const id of ["initializing", "other-initializing", "other-parent"]) registry.unregister(id); }
});

test("connect excludes its own native subagent ref", async () => {
  const owner = await harness(undefined, { kind: "sub", id: "sub-owner", name: "sub owner", depth: 1 });
  const registry = AgentRegistry.global();
  registry.register({ id: owner.context.agent.id, displayName: "sub owner", kind: "sub",
    sessionFile: owner.sessionFile, session: { sessionManager: owner.context.sessionManager,
      getToolByName: () => undefined, settings: Settings.isolated(),
      getAdvisorStats: () => ({ configured: false, advisors: [] }),
    } as never, status: "running" });
  try {
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    expect((await owner.status()).mode).toBe("remote");
  } finally { registry.unregister(owner.context.agent.id); }
});

test.each(["park", "ttl-park", "one-shot", "hard-abort", "interrupt"] as const)(
  "native lifecycle %s closes attached child workers when the session is disposed", async transition => {
    const { owner, family } = await connected();
    const child = await harness(`${family.root}/subagent/disposable.jsonl`, {
      kind: "sub", id: "disposable-child", name: "disposable child", depth: 1, parentId: owner.context.agent.id,
    });
    const state = child.state(family), worker = state.client!;
    const native = await nativeChild(child);
    if (transition === "park" || transition === "ttl-park") {
      AgentRegistry.global().setStatus(native.ref.id, "idle");
      AgentLifecycleManager.global().adopt(native.ref.id, { idleTtlMs: transition === "ttl-park" ? 1 : 0 });
      if (transition === "park") await AgentLifecycleManager.global().park(native.ref.id);
      else await native.shutdown;
    } else {
      if (transition === "hard-abort") AgentRegistry.global().setStatus(native.ref.id, "aborted");
      await finalizeSubagentLifecycle({
        id: native.ref.id, session: native.session, aborted: transition !== "one-shot",
        keepAlive: transition !== "one-shot", isolated: false, agentIdleTtlMs: 0,
        reviveSession: transition === "interrupt" ? async () => { throw new Error("fixture revival is not invoked"); } : null,
      });
      if (transition === "interrupt") {
        expect(native.shutdowns()).toBe(0);
        expect(state.client).toBe(worker);
        expect(worker.isClosed).toBe(false);
        expect(native.ref.status).toBe("idle");
        await AgentLifecycleManager.global().park(native.ref.id);
      }
    }
    expect(native.shutdowns()).toBe(1);
    expect(family.members.has(state)).toBe(false);
    expect(state.client).toBeUndefined();
    await worker.waitForExit();
    expect(worker.isClosed).toBe(true);
    expect((await owner.status()).mode).toBe("remote");
  },
);

test("native park cancels an in-flight child attach and kills its late worker", async () => {
  const { owner, family } = await connected();
  admission = gate();
  const attaching = settle(harness(`${family.root}/subagent/parking.jsonl`, {
    kind: "sub", id: "parking-child", name: "parking child", depth: 1, parentId: owner.context.agent.id,
  }));
  await admission.entered;
  const child = harnesses.at(-1)!, state = child.state(family), worker = clients.at(-1)!;
  const native = await nativeChild(child);
  AgentRegistry.global().setStatus(native.ref.id, "idle");
  AgentLifecycleManager.global().adopt(native.ref.id, { idleTtlMs: 0 });
  await AgentLifecycleManager.global().park(native.ref.id);
  await releaseAdmission();
  expect(await attaching).toBeInstanceOf(Error);
  expect(native.shutdowns()).toBe(1);
  expect(family.members.has(state)).toBe(false);
  expect(state.client).toBeUndefined();
  await worker.waitForExit();
  expect(worker.isClosed).toBe(true);
});

test("owner exit closes every child worker while retaining revoked-session guards until shutdown", async () => {
  const { owner, family } = await connected();
  const child = await harness(`${family.root}/subagent/exit.jsonl`);
  const state = child.state(family), worker = state.client!, ownerWorker = owner.state(family).client!;
  await owner.execute("remote_exit", { force: true });
  await Promise.all([worker.waitForExit(), ownerWorker.waitForExit()]);
  expect(worker.isClosed).toBe(true);
  expect(ownerWorker.isClosed).toBe(true);
  expect(state.client).toBeUndefined();
  expect(family.members.has(state)).toBe(true);
  expect((await child.status()).mode).toBe("unavailable");
  await child.emit("session_shutdown");
  expect(family.members.has(state)).toBe(false);
  expect(family.members.size).toBe(0);
});

test("owner switch refuses live children and closes its worker once children shut down", async () => {
  const { owner, family } = await connected();
  const child = await harness(`${family.root}/subagent/navigation.jsonl`);
  const state = child.state(family), worker = state.client!, ownerWorker = owner.state(family).client!;
  expect(await owner.emit("session_before_switch")).toEqual({ cancel: true });
  expect(worker.isClosed).toBe(false);
  expect(ownerWorker.isClosed).toBe(false);
  await child.emit("session_shutdown");
  await worker.waitForExit();
  expect(worker.isClosed).toBe(true);
  expect(family.members.has(state)).toBe(false);
  expect(await owner.emit("session_before_switch")).toBeUndefined();
  await ownerWorker.waitForExit();
  expect(ownerWorker.isClosed).toBe(true);
  expect(broker.hasOwner(owner.sessionFile)).toBe(false);
  expect(family.members.size).toBe(0);
});

test("connect refuses enabled autoresearch before deployment", async () => {
  const owner = await harness();
  owner.activeTools.push("run_experiment");
  await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/autoresearch.*off/i);
  await expect(owner.command("remote-connect", "fixture.invalid")).rejects.toThrow(/autoresearch.*off/i);
  expect((await owner.status()).mode).toBe("local");
});

test.each([{ provider: "cursor" }, { provider: "custom", api: "cursor-agent" }])("Cursor provider cannot connect or start a bound turn: %j", async model => {
  const owner = await harness();
  owner.setModel(model);
  await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/Cursor.*locally.*unavailable while bound/i);
  await expect(owner.command("remote-connect", "fixture.invalid")).rejects.toThrow(/Cursor.*locally.*unavailable while bound/i);
  owner.setModel({ provider: "fixture" });
  await owner.execute("remote_connect", { target: "fixture.invalid" });
  owner.setModel(model);
  await owner.emit("before_agent_start");
  expect(owner.aborts).toEqual(["abort"]);
  owner.setModel({ provider: "fixture" });
  await owner.emit("before_agent_start");
  expect(owner.aborts).toEqual(["abort"]);
});

test("Cursor advisor effective models veto connect and bound turns", async () => {
  const owner = await harness(), registry = AgentRegistry.global(), id = owner.context.agent.id;
  const advisors = [{ name: "local-review", model: { provider: "cursor", api: "cursor-agent" } }];
  registry.register({ id, displayName: "owner", kind: "main", session: {
    sessionManager: owner.context.sessionManager, settings: Settings.isolated(), getToolByName: () => undefined,
    getAdvisorStats: () => ({ configured: true, advisors }),
  } as never });
  try {
    await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/Advisor local-review: Cursor/);
    await expect(owner.command("remote-connect", "fixture.invalid")).rejects.toThrow(/Advisor local-review: Cursor/);
    advisors[0]!.model = { provider: "fixture", api: "fixture" };
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    advisors[0]!.model = { provider: "cursor", api: "cursor-agent" };
    await owner.emit("before_agent_start");
    expect(owner.aborts).toEqual(["abort"]);
  } finally { registry.unregister(id); }
});

test("switching to Cursor after connect aborts before_agent_start without throwing", async () => {
  const { owner } = await connected();
  owner.setModel({ provider: "cursor", api: "cursor-agent" });
  expect(await owner.emit("before_agent_start")).toBeUndefined();
  expect(owner.aborts).toEqual(["abort"]);
});

test("connect admission rechecks descendants created during deployment", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  const child = `${owner.context.agent.id}-late-child`;
  preparation = gate();
  const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid" }));
  await preparation.entered;
  registry.register({ id: child, displayName: "child", kind: "sub", parentId: owner.context.agent.id, session: {} as never });
  try {
    preparation.release();
    const error = await connecting;
    expect(error?.message).toMatch(/live descendant/i);
    expect((await owner.status()).mode).toBe("local");
    expect(broker.hasOwner(owner.sessionFile)).toBe(false);
  } finally { registry.unregister(child); }
});

test("a native task session named advisor retains its remote workspace wrappers", async () => {
  const { owner, family } = await connected();
  const child = await harness(`${family.root}/subagent/advisor.jsonl`, {
    kind: "sub", id: "advisor", name: "advisor", depth: 1, parentId: owner.context.agent.id,
  });
  expect(await child.emit("tool_call", { toolName: "read", input: { path: "/remote/project" } })).toBeUndefined();
  expect(await child.execute("read", { path: "/remote/project" })).toMatchObject({ details: { path: "/remote/project" } });
  expect(child.nativeReads).toEqual([]);
});

test.each([false, true])("native IRC revival reattaches exactly once and contains owner-exit races: %s", async exitDuringRevival => {
  const { owner, family } = await connected();
  const manager = SessionManager.create(directory, `${family.root}/subagent`);
  manager.appendMessage({ role: "user", content: "Persisted native revival fixture.", timestamp: Date.now() });
  // Native persistence keeps a user-only session ephemeral until its first reply.
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Fixture ready." }],
    api: "anthropic-messages", provider: "anthropic", model: "fixture-model", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  });
  await manager.flush();
  const file = manager.getSessionFile()!, id = "native-revival-child";
  const initial = await nativeRemoteChild(manager, id, owner.context.agent.id);
  expect(initial.errors).toEqual([]);
  const oldState = [...family.members].find(member => member.sessionFile === file)!;
  const oldWorker = oldState.client!;
  let rebuilt: Awaited<ReturnType<typeof nativeRemoteChild>> | undefined;
  const lifecycle = AgentLifecycleManager.global();
  AgentRegistry.global().setStatus(id, "idle");
  lifecycle.adopt(id, { idleTtlMs: 0, revive: async expected => {
    const reopened = await SessionManager.open(expected.sessionFile!, undefined, undefined, {
      suppressBreadcrumb: true, throwIfMissing: true,
    });
    rebuilt = await nativeRemoteChild(reopened, id, owner.context.agent.id, expected);
    return rebuilt.session;
  } });
  await lifecycle.park(id);
  await oldWorker.waitForExit();
  expect(oldWorker.isClosed).toBe(true);
  expect(family.members.has(oldState)).toBe(false);
  expect(initial.ref.status).toBe("parked");
  expect(initial.ref.session).toBeNull();
  const workerCount = clients.length;
  if (exitDuringRevival) admission = gate();
  const sending = new IrcBus().send({ from: "fixture-peer", to: id, body: "Wake the parked child." }, { suppressRelay: true });
  let lateWorker: RemoteRuntimeClient | undefined;
  if (exitDuringRevival) {
    await Promise.race([admission!.entered, sending.then(receipt => {
      throw new Error(`Revival finished before transport admission: ${JSON.stringify(receipt)}`);
    })]);
    lateWorker = clients.at(-1)!;
    await owner.execute("remote_exit", { force: true });
    await releaseAdmission();
  }
  const receipt = await sending;
  expect(clients.length).toBe(workerCount + 1);
  if (exitDuringRevival) {
    expect(receipt.outcome).toBe("failed");
    expect(receipt.error).toMatch(/cancel|abort|disconnect|closed/i);
    await lateWorker!.waitForExit();
    expect(lateWorker!.isClosed).toBe(true);
    expect(nativeSessions.at(-1)!.session.isDisposed).toBe(true);
    expect(family.members.size).toBe(0);
    expect(family.closing).toBe(true);
    expect(broker.hasOwner(owner.sessionFile)).toBe(false);
    return;
  }
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ outcome: "revived" });
  expect(rebuilt).toBeDefined();
  expect(rebuilt!.session).not.toBe(initial.session);
  expect(rebuilt!.session.sessionManager.getSessionFile()).toBe(file);
  expect(rebuilt!.session.agent.state.messages.some(message =>
    message.role === "user" && message.content === "Persisted native revival fixture.")).toBe(true);
  expect(rebuilt!.session.hasQueuedIrcFrom("fixture-peer")).toBe(true);
  const revivedStates = [...family.members].filter(member => member.sessionFile === file);
  expect(revivedStates).toHaveLength(1);
  const revived = revivedStates[0]!;
  expect(rebuilt!.errors).toEqual([]);
  expect(revived.client).toBe(clients.at(-1));
  expect(revived.client!.isClosed).toBe(false);
  expect(revived.family).toBe(family);
  expect(family.members.size).toBe(2);
  await owner.execute("remote_exit", { force: true });
  await clients.at(-1)!.waitForExit();
  expect(clients.at(-1)!.isClosed).toBe(true);
  await rebuilt!.session.dispose();
  expect(family.members.size).toBe(0);
});
