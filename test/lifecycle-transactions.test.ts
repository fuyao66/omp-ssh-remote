import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { RemoteRuntimeClient } from "../src/client.ts";
import { REMOTE_TOOL_NAMES } from "../src/protocol.ts";
import * as ssh from "../src/ssh.ts";
import * as identity from "../src/omp/host-identity.ts";
import * as deployment from "../src/deploy.ts";
import * as configuration from "../src/connect-options.ts";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function gate() {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  return { entered: entered.promise, release: () => released.resolve(), async wait() { entered.resolve(); await released.promise; } };
}
let discovery: ReturnType<typeof gate> | undefined, preparation: ReturnType<typeof gate> | undefined;
let commit: ReturnType<typeof gate> | undefined, admission: ReturnType<typeof gate> | undefined;
let directory = "", sequence = 0;
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
  console.log(JSON.stringify({type:"ready",protocolVersion:1,host:"omp",hostVersion:m.hostVersion,runtimeVersion:m.runtimeVersion,cwd:m.cwd,editMode:m.editMode,resourceBinding:m.resourceBinding,tools:m.tools.map(name=>({name,description:name,parameters:{type:"object"}}))}));
 } else if(m.type==="execute") console.log(JSON.stringify({type:"result",id:m.id,result:{content:[{type:"text",text:"remote fixture"}],details:{pid:process.pid,path:m.args.path}}}));
 else if(m.type==="shutdown") process.exit(0);
}`;
const transport = spyOn(ssh, "buildSshWorkerCommand").mockImplementation(() => {
  const release = admission ? join(directory, `release-${sequence++}`) : "";
  if (release) releases.push(release);
  return [process.execPath, "-e", worker, release];
});
const hostIdentity = spyOn(identity, "resolveOmpHostVersion").mockResolvedValue("18.15.0");
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
  discovery?.release(); preparation?.release(); commit?.release(); await releaseAdmission();
  for (const client of clients) client.kill();
  await Promise.all(clients.map(client => client.waitForExit()));
  for (const h of harnesses) await h.emit("session_shutdown").catch(() => {});
  clients.length = releases.length = harnesses.length = 0;
  discovery = preparation = commit = admission = undefined;
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

test.each(["running", "idle"] as const)("connect refuses %s descendants including live grandchildren", async status => {
  const owner = await harness(), registry = AgentRegistry.global();
  const ownerId = owner.context.agent.id;
  const child = `${ownerId}-child`, grandchild = `${ownerId}-grandchild`;
  registry.register({ id: ownerId, displayName: "owner", kind: "main", session: {
    sessionManager: owner.context.sessionManager, getToolByName: () => undefined, settings: Settings.isolated(),
    getAdvisorStats: () => ({ configured: false, advisors: [] }),
  } as never });
  registry.register({ id: child, displayName: "child", kind: "sub", parentId: ownerId, session: null, status: "parked" });
  registry.register({ id: grandchild, displayName: "grandchild", kind: "sub", parentId: child, session: {} as never, status });
  try {
    await expect(owner.execute("remote_connect", { target: "fixture.invalid" })).rejects.toThrow(/live descendant.*wait.*stop/i);
    await expect(owner.command("remote-connect", "fixture.invalid")).rejects.toThrow(/live descendant.*wait.*stop/i);
    expect((await owner.status()).mode).toBe("local");
    registry.detachSession(grandchild);
    await owner.execute("remote_connect", { target: "fixture.invalid" });
    expect((await owner.status()).mode).toBe("remote");
  } finally { for (const id of [grandchild, child, ownerId]) registry.unregister(id); }
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
