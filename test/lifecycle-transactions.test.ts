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
import { Agent, ProxyMessageEventStream } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isLocalAgentSession, type AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubagentLifecycle, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { captureOmpToolSnapshot, projectOmpBashExecutionSchema } from "../src/omp/runtime-contract.ts";
import * as asyncBash from "../src/omp/async-bash.ts";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

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
  execute(name: string, args?: Record<string, unknown>, options?: {
    signal?: AbortSignal; onProgress?: (stage: string) => void;
  }): Promise<{ details?: unknown }>;
  state(family: Family): State;
  status(): Promise<{ mode: string }>;
};
const harnesses: Harness[] = [];
const nativeSessions: { session: AgentSession; auth: AuthStorage; id: string }[] = [];
const nativeProviderCleanups: (() => void)[] = [];

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

async function idleNativeChild(owner: Harness, id: string) {
  const child = await harness(owner.sessionFile.replace(/\.jsonl$/, `/subagent/${id}.jsonl`), {
    kind: "sub", id, name: id, depth: 1, parentId: owner.context.agent.id,
  });
  const native = await nativeChild(child);
  AgentRegistry.global().setStatus(id, "idle");
  AgentLifecycleManager.global().adopt(id, { idleTtlMs: 0 });
  return native;
}

/** Count real native subscriptions without replacing event delivery or cleanup. */
function observeSettlementListeners(session: AgentSession) {
  const holds = new Set<() => void>(), changes = new Set<Parameters<AgentRegistry["onChange"]>[0]>();
  const registry = AgentRegistry.global(), subscribe = session.subscribeIrcWakeHolds, onChange = registry.onChange;
  const holdSpy = spyOn(session, "subscribeIrcWakeHolds").mockImplementation(function (listener) {
    holds.add(listener);
    const unsubscribe = subscribe.call(session, listener);
    return () => { holds.delete(listener); unsubscribe(); };
  });
  const registrySpy = spyOn(registry, "onChange").mockImplementation(function (listener) {
    changes.add(listener);
    const unsubscribe = onChange.call(registry, listener);
    return () => { changes.delete(listener); unsubscribe(); };
  });
  return {
    holds, changes,
    restore() { holdSpy.mockRestore(); registrySpy.mockRestore(); },
  };
}

async function ensureNativeToolManifests() {
  if (!nativeToolManifests) {
    const native = await createNativeWorkerRuntime(directory);
    try {
      nativeToolManifests = REMOTE_TOOL_NAMES.map(name => {
        const snapshot = { ...captureOmpToolSnapshot(native.tools[name]), description: native.tools[name].description };
        return name === "bash" ? { ...snapshot, parameters: projectOmpBashExecutionSchema(snapshot.parameters) } : snapshot;
      });
    } finally { await native.dispose(); }
  }
}

/** The exported executor installs its private warm reviver; only its transport is a local no-op. */
async function nativeExecutorChild(owner: Harness, family: Family, id: string) {
  await ensureNativeToolManifests();
  const settings = Settings.isolated({
    "task.agentIdleTtlMs": 0, "task.softRequestBudget": 0, "task.completionProbe": false,
  });
  const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
  const modelRegistry = new ModelRegistry(auth, undefined, { settings, ignoreLocalModelConfig: true,
    fetch: async () => { throw new Error("Unexpected model registry network request"); } });
  const provider = "fixture-native-revival", model = "fixture-model";
  let requests = 0;
  modelRegistry.registerProvider(provider, {
    api: provider, apiKey: "fixture", baseUrl: "https://fixture.invalid",
    models: [{ id: model, name: model, reasoning: false, input: ["text"], supportsTools: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: () => {
      requests++;
      const stream = new ProxyMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: {
        role: "assistant", content: [{ type: "text", text: "Fixture ready." }],
        api: provider, provider, model, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      stream.end();
      return stream;
    },
  });
  nativeProviderCleanups.push(() => modelRegistry.unregisterProvider(provider));
  const sessions: { session: AgentSession; ref: AgentRef; errors: string[] }[] = [];
  const result = await runSubprocess({
    cwd: directory, id, index: 0, parentAgentId: owner.context.agent.id,
    agent: { name: id, description: "Native warm revival fixture", systemPrompt: "Reply with Fixture ready.",
      source: "project", tools: ["read", "write", "bash"] },
    task: "Persisted native revival fixture.", description: "Native warm revival fixture",
    structured: false, keepAlive: true, artifactsDir: `${family.root}/subagent`,
    modelOverride: `${provider}/${model}`, modelRegistry, authStorage: auth, settings,
    enableLsp: false, enableMCP: false, noContextFiles: true, skills: [], promptTemplates: [], rules: [],
    preloadedCustomToolPaths: [],
    preloadedPreparedExtensions: [
      { path: "<revival-observer>", resolvedPath: "<revival-observer>", error: null, factory: pi => {
        pi.on("session_start", () => {
          const ref = AgentRegistry.global().get(id)!, session = ref.session!;
          if (!isLocalAgentSession(session)) throw new Error("Native revival observer must run on the session's home thread");
          // Hold delivery after native ensureLive without replacing the executor's reviver.
          session.holdIrcWakes();
          const errors: string[] = [];
          session.extensionRunner!.onError(error => { errors.push(error.error); });
          sessions.push({ session, ref, errors });
          nativeSessions.push({ session, auth, id });
        });
      } },
      { path: "<remote-extension>", resolvedPath: "<remote-extension>", error: null, factory: extension },
    ],
  });
  expect(result.exitCode, result.error ?? result.stderr).toBe(0);
  expect(requests).toBe(1);
  expect(sessions).toHaveLength(1);
  return { sessions, requests: () => requests };
}
const settle = (promise: Promise<unknown>): Promise<Error | null> => promise.then(() => null, (error: Error) => error);
async function harness(sessionFile = join(directory, "owner.jsonl"), agent: ExtensionContext["agent"] = { kind: "main", id: `owner-${crypto.randomUUID()}`, name: "owner", depth: 0 }): Promise<Harness> {
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, { handler: Function }>();
  const nativeReads: string[] = [];
  const activeTools = ["read", "bash"], aborts: string[] = [];
  const manager = await SessionManager.open(sessionFile, dirname(sessionFile), undefined, { initialCwd: directory, suppressBreadcrumb: true });
  const ctx = { cwd: directory, model: undefined, agent, sessionManager: manager,
    abort() { aborts.push("abort"); },
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {} },
    async invokeTool(params: { path?: string; command?: string }) {
      if (params.path) { nativeReads.push(params.path); await readFile(params.path); }
      if (params.command) await writeFile(join(directory, "native-bash"), params.command);
      return { content: [{ type: "text", text: "local fixture" }] };
    },
  } as unknown as ExtensionContext;
  const session = {
    instanceKey: `main:${crypto.randomUUID()}`, sessionManager: manager, settings: Settings.isolated(),
    getToolByName: () => undefined, getAdvisorStats: () => ({ configured: false, advisors: [] }),
    async runToolRegistryMutation(mutate: () => Promise<void>) { await mutate(); },
  } as unknown as AgentSessionHandle;
  const registry = AgentRegistry.global();
  const ref = registry.register({
    id: agent.id, displayName: agent.name, kind: agent.kind, parentId: agent.parentId,
    session, sessionFile, status: "running",
  });
  await extension({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data?: unknown) => { manager.appendCustomEntry(customType, data); },
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
    on: (name: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(name, hook),
    getActiveTools: () => activeTools, getAllTools: () => REMOTE_TOOL_NAMES.map(name => ({
      name, description: name, parameters: { type: "object" }, sourceInfo: { source: "builtin" },
    })),
  } as unknown as ExtensionAPI);
  const h: Harness = { sessionFile, nativeReads, activeTools, context: ctx, aborts,
    setModel(model) { Object.assign(ctx, { model }); },
    async emit(name: string, event = {}) {
      try { return await hooks.get(name)!(event, ctx); }
      finally {
        if (name === "session_shutdown") {
          registry.unregister(agent.id, ref);
          await manager.close();
        }
      }
    },
    command: async (name: string, args = "") => await commands.get(name)!.handler(args, ctx),
    execute: async (name: string, args = {}, options) => await tools.get(name)!.execute(
      name, args, options?.signal, options?.onProgress ? update => {
        for (const item of update.content) if (item.type === "text") options.onProgress!(item.text);
      } : undefined, ctx,
    ),
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
  const authStores = new Set<AuthStorage>();
  for (const { session, auth, id } of nativeSessions.splice(0)) {
    await session.dispose();
    AgentRegistry.global().unregister(id);
    authStores.add(auth);
  }
  for (const cleanup of nativeProviderCleanups.splice(0)) cleanup();
  for (const auth of authStores) auth.close();
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

test.each(["session_before_switch", "session_before_branch", "session_before_tree"])("%s cancels deployment before an old-session family is published", async event => {
  const owner = await harness(); preparation = gate();
  const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid", cwd: "/remote" }));
  await preparation.entered; await owner.emit(event); preparation.release();
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
    session: { instanceKey: "other-thread:previous", ircWakesPending: true } as never,
    sessionFile: join(directory, "previous", "subagent", "child.jsonl"), status: "idle" });
  try {
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    expect((await owner.status()).mode).toBe("remote");
    expect(ref.session).not.toBeNull();
    expect(ref.status).toBe("idle");
    expect(ref.session?.ircWakesPending).toBe(true);
  } finally { registry.unregister(id); }
});

test("connect refuses running grandchildren through parked intermediates", async () => {
  const owner = await harness(), registry = AgentRegistry.global();
  const ownerId = owner.context.agent.id;
  const child = `${ownerId}-child`, grandchild = `${ownerId}-grandchild`;
  registry.register({ id: ownerId, displayName: "owner", kind: "main", session: {
    instanceKey: `main:${crypto.randomUUID()}`,
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

test("running native wake hold without queued messages refuses immediately and describes running work", async () => {
  const owner = await harness(), native = await idleNativeChild(owner, "held-running");
  native.session.holdIrcWakes();
  AgentRegistry.global().setStatus(native.ref.id, "running");
  const progress: string[] = [], listeners = observeSettlementListeners(native.session);
  const discoveries = discoveryBoundary.mock.calls.length, deployments = deploymentBoundary.mock.calls.length;
  try {
    expect(native.session.ircWakesPending).toBe(true);
    expect(native.session.hasQueuedIrcFrom("fixture-peer")).toBe(false);
    const error = await settle(owner.execute("remote_connect", { target: "fixture.invalid" }, {
      onProgress: stage => progress.push(stage),
    }));
    expect(error?.message).toContain("held-running (held-running, running)");
    expect(error?.message).toContain("running work");
    expect(error?.message).not.toContain("IRC wake held/queued/awaiting compaction");
    expect(error?.message).toContain("open /hub and press x");
    expect(error?.message).not.toMatch(/has pending messages|retry shortly/);
    expect(progress).toEqual([]);
    expect(listeners.holds.size).toBe(0);
    expect(listeners.changes.size).toBe(0);
    expect(discoveryBoundary.mock.calls.length).toBe(discoveries);
    expect(deploymentBoundary.mock.calls.length).toBe(deployments);
    expect(native.ref.session).toBe(native.session);
    expect(native.ref.status).toBe("running");
    expect(native.shutdowns()).toBe(0);
    expect((await owner.status()).mode).toBe("local");
  } finally { listeners.restore(); }
});

test.each(["progress", "native event"] as const)(
  "idle wake hold released by %s parks natively and connects within the same transaction", async releaseAt => {
    const owner = await harness(), native = await idleNativeChild(owner, "settling-idle");
    const release = native.session.holdIrcWakes(), entered = Promise.withResolvers<void>();
    const listeners = observeSettlementListeners(native.session), progress: string[] = [];
    const discoveries = discoveryBoundary.mock.calls.length, deployments = deploymentBoundary.mock.calls.length;
    try {
      const connecting = owner.execute("remote_connect", { target: "fixture.invalid" }, {
        onProgress(stage) {
          progress.push(stage);
          expect(listeners.holds.size).toBe(1);
          expect(listeners.changes.size).toBe(1);
          expect(discoveryBoundary.mock.calls.length).toBe(discoveries);
          expect(deploymentBoundary.mock.calls.length).toBe(deployments);
          if (releaseAt === "progress") release();
          entered.resolve();
        },
      });
      await entered.promise;
      if (releaseAt === "native event") release();
      await connecting;
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatch(/up to 1000 ms.*native IRC wakes.*held\/queued\/awaiting compaction/);
      expect(listeners.holds.size).toBe(0);
      expect(listeners.changes.size).toBe(0);
      expect(native.ref.status).toBe("parked");
      expect(native.ref.session).toBeNull();
      expect(native.shutdowns()).toBe(1);
      expect(native.session.isDisposed).toBe(true);
      expect((await owner.status()).mode).toBe("remote");
    } finally { listeners.restore(); }
  },
);

test.each(["caller abort", "remote_exit", "slash exit"] as const)(
  "%s cancels idle wake settlement before SSH and removes native listeners", async cancellation => {
    const owner = await harness(), native = await idleNativeChild(owner, "cancel-settlement");
    const release = native.session.holdIrcWakes(), entered = Promise.withResolvers<void>();
    const controller = new AbortController(), listeners = observeSettlementListeners(native.session);
    const discoveries = discoveryBoundary.mock.calls.length, deployments = deploymentBoundary.mock.calls.length;
    const transports = transport.mock.calls.length;
    try {
      const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid" }, {
        signal: controller.signal, onProgress() { entered.resolve(); },
      }));
      await entered.promise;
      expect(listeners.holds.size).toBe(1);
      expect(listeners.changes.size).toBe(1);
      if (cancellation === "caller abort") controller.abort(new Error("Fixture caller cancelled settlement"));
      else if (cancellation === "remote_exit") await owner.execute("remote_exit");
      else await owner.command("remote-exit");
      expect((await connecting)?.message).toMatch(/cancel|abort|exit/i);
      expect(listeners.holds.size).toBe(0);
      expect(listeners.changes.size).toBe(0);
      release();
      expect(discoveryBoundary.mock.calls.length).toBe(discoveries);
      expect(deploymentBoundary.mock.calls.length).toBe(deployments);
      expect(transport.mock.calls.length).toBe(transports);
      expect(native.ref.session).toBe(native.session);
      expect(native.ref.status).toBe("idle");
      expect(native.shutdowns()).toBe(0);
      expect(broker.hasOwner(owner.sessionFile)).toBe(false);
      expect((await owner.status()).mode).toBe("local");
      // Cancellation releases the transaction slot as well as its subscriptions.
      await owner.execute("remote_connect", { target: "fixture.invalid" });
      expect(native.ref.status).toBe("parked");
      expect((await owner.status()).mode).toBe("remote");
    } finally { listeners.restore(); }
  },
);

test("a new running child interrupts wake settlement and refuses without deploying", async () => {
  const owner = await harness(), native = await idleNativeChild(owner, "waiting-idle");
  native.session.holdIrcWakes();
  const entered = Promise.withResolvers<void>(), listeners = observeSettlementListeners(native.session);
  const registry = AgentRegistry.global(), id = "new-running-during-settlement";
  const discoveries = discoveryBoundary.mock.calls.length, deployments = deploymentBoundary.mock.calls.length;
  try {
    const connecting = settle(owner.execute("remote_connect", { target: "fixture.invalid" }, {
      onProgress() { entered.resolve(); },
    }));
    await entered.promise;
    registry.register({ id, displayName: "new running helper", kind: "sub",
      parentId: owner.context.agent.id, session: null, status: "running" });
    const error = await connecting;
    expect(error?.message).toContain(`new running helper (${id}, running)`);
    expect(error?.message).toContain("running work");
    expect(discoveryBoundary.mock.calls.length).toBe(discoveries);
    expect(deploymentBoundary.mock.calls.length).toBe(deployments);
    expect(listeners.holds.size).toBe(0);
    expect(listeners.changes.size).toBe(0);
    expect(native.ref.session).toBe(native.session);
    expect(native.ref.status).toBe("idle");
    expect(native.session.ircWakesPending).toBe(true);
    expect(native.shutdowns()).toBe(0);
    expect((await owner.status()).mode).toBe("local");
  } finally { registry.unregister(id); listeners.restore(); }
});

test.each([false, true])("idle worker handle with IRC pending=%s requires native parking without waiting or mutation", async pending => {
  const owner = await harness(), registry = AgentRegistry.global(), lifecycle = AgentLifecycleManager.global();
  const id = "worker-idle", progress: string[] = [];
  const session = { instanceKey: "foreign-thread:idle", ircWakesPending: pending } as AgentSessionHandle;
  const ref = registry.register({ id, displayName: "worker idle", kind: "sub", parentId: owner.context.agent.id,
    session, sessionFile: owner.sessionFile.replace(/\.jsonl$/, "/subagent/worker-idle.jsonl"), status: "idle" });
  const parking = spyOn(lifecycle, "park"), discoveries = discoveryBoundary.mock.calls.length;
  const deployments = deploymentBoundary.mock.calls.length;
  try {
    const error = await settle(owner.execute("remote_connect", { target: "fixture.invalid" }, {
      onProgress: stage => progress.push(stage),
    }));
    expect(error?.message).toContain("worker idle (worker-idle, idle)");
    expect(error?.message).toContain("worker-thread session requires native parking");
    expect(error?.message).toContain("immediate retry will not help");
    expect(error?.message).toContain("open /hub and press x");
    expect(error?.message?.includes("IRC wake held/queued/awaiting compaction")).toBe(pending);
    expect(progress).toEqual([]);
    expect(parking).not.toHaveBeenCalled();
    expect(discoveryBoundary.mock.calls.length).toBe(discoveries);
    expect(deploymentBoundary.mock.calls.length).toBe(deployments);
    expect(ref.session).toBe(session);
    expect(ref.status).toBe("idle");
    expect(session.ircWakesPending).toBe(pending);
    expect((await owner.status()).mode).toBe("local");
  } finally { parking.mockRestore(); registry.unregister(id); }
});

test.each(["admission", "publication"] as const)(
  "connect refuses an idle child with a deferred native IRC wake at %s", async boundary => {
    const owner = await harness(), progress: string[] = [];
    if (boundary === "publication") commit = gate();
    const connecting = boundary === "publication"
      ? settle(owner.execute("remote_connect", { target: "fixture.invalid" }, {
        onProgress: stage => progress.push(stage),
      })) : undefined;
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
    const listeners = observeSettlementListeners(native.session), timers = spyOn(globalThis, "setTimeout");
    const discoveries = discoveryBoundary.mock.calls.length, deployments = deploymentBoundary.mock.calls.length;
    const transports = transport.mock.calls.length;
    try {
      commit?.release();
      // Admission deliberately lets its one real native deadline expire; no fake authorization.
      const error = await (connecting ?? settle(owner.execute("remote_connect", { target: "fixture.invalid" }, {
        onProgress: stage => progress.push(stage),
      })));
      expect(error?.message).toContain("pending IRC helper");
      expect(error?.message).toContain("IRC wake held/queued/awaiting compaction");
      expect(error?.message).not.toMatch(/has pending messages|retry shortly/);
      expect(progress).toHaveLength(boundary === "admission" ? 1 : 0);
      expect(timers.mock.calls.some(([, delay]) => delay === 1000)).toBe(boundary === "admission");
      expect(listeners.holds.size).toBe(0);
      expect(listeners.changes.size).toBe(0);
      expect(discoveryBoundary.mock.calls.length).toBe(discoveries);
      expect(deploymentBoundary.mock.calls.length).toBe(deployments);
      expect(transport.mock.calls.length).toBe(transports);
      expect(native.ref.session).toBe(native.session);
      expect(native.ref.status).toBe("idle");
      expect(native.shutdowns()).toBe(0);
      expect(native.session.hasQueuedIrcFrom("fixture-peer")).toBe(true);
      expect((await owner.status()).mode).toBe("local");
    } finally { timers.mockRestore(); listeners.restore(); }
  },
);

test("connect refuses an unadopted idle child rather than silently leaving it live", async () => {
  const owner = await harness(), registry = AgentRegistry.global(), id = "unadopted-helper";
  const child = await harness(owner.sessionFile.replace(/\.jsonl$/, "/subagent/unadopted.jsonl"), {
    kind: "sub", id, name: "unadopted helper", depth: 1, parentId: owner.context.agent.id,
  });
  const native = await nativeChild(child);
  registry.setStatus(id, "idle");
  try {
    await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/unadopted helper.*idle/);
    expect((await owner.status()).mode).toBe("local");
    expect(native.ref.session).toBe(native.session);
    expect(native.ref.status).toBe("idle");
    expect(native.shutdowns()).toBe(0);
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

test("connect cancels native parking when a new idle wake hold appears before detach", async () => {
  const owner = await harness(), native = await idleNativeChild(owner, "hold-during-park");
  const lifecycle = AgentLifecycleManager.global(), park = lifecycle.park;
  const listeners = observeSettlementListeners(native.session);
  const racing = spyOn(lifecycle, "park").mockImplementation(function (id) {
    const pending = park.call(lifecycle, id);
    native.session.holdIrcWakes();
    return pending;
  });
  const deployments = deploymentBoundary.mock.calls.length;
  try {
    const error = await settle(owner.execute("remote_connect", { target: "fixture.invalid" }));
    expect(error?.message).toContain("hold-during-park (hold-during-park, idle)");
    expect(error?.message).toContain("IRC wake held/queued/awaiting compaction");
    expect(native.ref.session).toBe(native.session);
    expect(native.ref.status).toBe("idle");
    expect(native.session.ircWakesPending).toBe(true);
    expect(native.session.hasQueuedIrcFrom("fixture-peer")).toBe(false);
    expect(native.shutdowns()).toBe(0);
    expect(listeners.holds.size).toBe(0);
    expect(listeners.changes.size).toBe(0);
    expect(deploymentBoundary.mock.calls.length).toBe(deployments);
    expect((await owner.status()).mode).toBe("local");
  } finally { racing.mockRestore(); listeners.restore(); }
});

test("wake notifications from the detached session do not cancel completed parking", async () => {
  const owner = await harness(), native = await idleNativeChild(owner, "detached-wake");
  native.session.addDisposer(() => {
    expect(native.ref.session).toBeNull();
    expect(native.ref.status).toBe("parked");
    const release = native.session.holdIrcWakes();
    release();
    expect(native.session.ircWakesPending).toBe(false);
  });
  await owner.execute("remote_connect", { target: "fixture.invalid" });
  expect(native.ref.status).toBe("parked");
  expect(native.shutdowns()).toBe(1);
  expect(native.session.isDisposed).toBe(true);
  expect((await owner.status()).mode).toBe("remote");
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
      instanceKey: `main:${crypto.randomUUID()}`,
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
    instanceKey: `main:${crypto.randomUUID()}`,
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
  const id = "native-revival-child";
  const executor = await nativeExecutorChild(owner, family, id);
  const initial = executor.sessions[0]!, file = initial.session.sessionManager.getSessionFile()!;
  expect(initial.errors).toEqual([]);
  const initialUserMessages = initial.session.agent.state.messages.filter(message => message.role === "user");
  expect(JSON.stringify(initialUserMessages)).toContain("Persisted native revival fixture.");
  const oldState = [...family.members].find(member => member.sessionFile === file)!;
  const oldWorker = oldState.client!;
  const lifecycle = AgentLifecycleManager.global();
  await lifecycle.park(id);
  await oldWorker.waitForExit();
  expect(oldWorker.isClosed).toBe(true);
  expect(family.members.has(oldState)).toBe(false);
  expect(initial.ref.status).toBe("parked");
  expect(initial.ref.session).toBeNull();
  const workerCount = clients.length;
  if (exitDuringRevival) admission = gate();
  const sending = new IrcBus().send({ from: "fixture-peer", to: id, body: "Wake the parked child." });
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
  expect(executor.sessions).toHaveLength(2);
  expect(executor.requests()).toBe(1);
  const rebuilt = executor.sessions[1]!;
  expect(clients.length).toBe(workerCount + 1);
  if (exitDuringRevival) {
    // The real executor logs session_start errors instead of rejecting revival
    // (SDK 18.16.0 task/executor.ts:4235-4239); worker revocation is independent.
    expect(receipt.outcome).toBe("revived");
    expect(rebuilt.errors.join("\n")).toMatch(/cancel|abort|disconnect|closed/i);
    await lateWorker!.waitForExit();
    expect(lateWorker!.isClosed).toBe(true);
    expect(rebuilt.session.isDisposed).toBe(false);
    const marker = join(directory, "revived-local-fallback");
    const status = await rebuilt.session.getToolByName("remote_workspace_status")!.execute("revived-status", {});
    const failure = await settle(rebuilt.session.getToolByName("bash")!.execute(
      "revoked-revival-bash", { command: `printf unsafe > ${JSON.stringify(marker)}` },
    ));
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(status).toMatchObject({ details: { mode: "unavailable" } });
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toMatch(/disconnect|unavailable|closed|revoked/i);
    await rebuilt.session.dispose();
    expect(rebuilt.session.isDisposed).toBe(true);
    expect(family.members.size).toBe(0);
    expect(family.closing).toBe(true);
    expect(broker.hasOwner(owner.sessionFile)).toBe(false);
    return;
  }
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ outcome: "revived" });
  expect(rebuilt.session).not.toBe(initial.session);
  expect(rebuilt.session.sessionManager.getSessionFile()).toBe(file);
  expect(rebuilt.session.agent.state.messages.filter(message => message.role === "user")).toEqual(initialUserMessages);
  expect(rebuilt.session.hasQueuedIrcFrom("fixture-peer")).toBe(true);
  const revivedStates = [...family.members].filter(member => member.sessionFile === file);
  expect(revivedStates).toHaveLength(1);
  const revived = revivedStates[0]!;
  expect(rebuilt.errors).toEqual([]);
  expect(revived.client).toBe(clients.at(-1));
  expect(revived.client!.isClosed).toBe(false);
  expect(revived.family).toBe(family);
  expect(family.members.size).toBe(2);
  await owner.execute("remote_exit", { force: true });
  await clients.at(-1)!.waitForExit();
  expect(clients.at(-1)!.isClosed).toBe(true);
  await rebuilt.session.dispose();
  expect(family.members.size).toBe(0);
});

test("deferred native Bash callback observes revocation before issuing a remote request", async () => {
  const { owner, family } = await connected(), client = owner.state(family).client!;
  const manager = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 60_000 });
  let deferred: asyncBash.RemoteAsyncBashJobOptions | undefined;
  const localManager = spyOn(asyncBash, "resolveLocalAsyncJobManager").mockReturnValue(manager);
  const localOwner = spyOn(asyncBash, "resolveJobOwnerId").mockReturnValue(owner.context.agent.id);
  const schedule = spyOn(asyncBash, "startRemoteAsyncBashJob").mockImplementation(options => {
    deferred = options;
    return { content: [{ type: "text", text: "native callback retained" }] };
  });
  const requests = spyOn(client, "execute");
  try {
    await owner.execute("bash", { command: "printf remote-only", async: true });
    expect(deferred).toBeDefined();
    expect(requests).not.toHaveBeenCalled();
    broker.revoke(family);
    // Deliberately do not close the transport: the shared fence must win
    // before asynchronous cleanup or native job-callback delivery catches up.
    expect(client.isClosed).toBe(false);
    await expect(deferred!.execute({ command: "printf remote-only" }, new AbortController().signal, () => {}, () => {}))
      .rejects.toThrow(/revoked|local fallback is disabled/i);
    expect(requests).not.toHaveBeenCalled();
  } finally {
    requests.mockRestore(); schedule.mockRestore(); localOwner.mockRestore(); localManager.mockRestore();
    await manager.dispose({ timeoutMs: 1_000 });
  }
});

test("disabled edit stays unwrapped and read mode changes require reconnect in both directions", async () => {
  const { cfgEditMode } = await import("@oh-my-pi/pi-coding-agent/edit/settings");
  const owner = await harness();
  const local = AgentRegistry.global().get(owner.context.agent.id)!.session!;
  if (!isLocalAgentSession(local)) throw new Error("Expected local harness session");
  cfgEditMode.override(local.settings, "none");
  owner.activeTools.push("edit");
  await owner.emit("session_start");
  const disabled = await createNativeWorkerRuntime(directory, { editMode: "none" });
  const disabledMetadata = { ...captureOmpToolSnapshot(disabled.tools.edit), description: disabled.tools.edit.description };
  await disabled.dispose();
  const configureReady = (mode: "none" | "hashline") => {
    nativeToolManifests = mode === "none" ? REMOTE_TOOL_NAMES.map(name =>
      name === "edit" ? disabledMetadata : { name, description: name, parameters: { type: "object" } }) : undefined;
  };
  configureReady("none");
  await owner.execute("remote_connect", { target: "fixture.invalid", cwd: "/remote" });
  const family = active.get(owner.sessionFile)!, state = owner.state(family);
  expect(state.editMode).toBe("none");
  expect(state.wrappedTools.has("edit")).toBe(false);
  await expect(owner.execute("read", { path: "/remote/disabled" })).resolves.toHaveProperty("details");
  await expect(owner.execute("bash", { command: "printf available" })).resolves.toHaveProperty("details");
  for (const mode of ["hashline", "none"] as const) {
    cfgEditMode.override(local.settings, mode);
    await expect(owner.execute("read", { path: "/remote/stale-mode" })).rejects.toThrow(/edit mode changed.*Reconnect/);
    configureReady(mode);
    await owner.execute("remote_reconnect", { force: true });
    expect(state.editMode).toBe(mode);
    await expect(owner.execute("read", { path: "/remote/fresh-mode" })).resolves.toHaveProperty("details");
  }
  expect(state.wrappedTools.has("edit")).toBe(false);
}, 30_000);
