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
  emit(name: string): Promise<unknown>;
  command(name: string): Promise<unknown>;
  execute(name: string, args?: Record<string, unknown>): Promise<{ details?: unknown }>;
  state(family: Family): State;
  status(): Promise<{ mode: string }>;
};
const harnesses: Harness[] = [];
const settle = (promise: Promise<unknown>): Promise<Error | null> => promise.then(() => null, (error: Error) => error);
async function harness(sessionFile = join(directory, "owner.jsonl")): Promise<Harness> {
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, { handler: Function }>();
  const nativeReads: string[] = [];
  const ctx = { cwd: directory, sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [] },
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
    getActiveTools: () => ["read", "bash"], getAllTools: () => REMOTE_TOOL_NAMES.map(name => ({
      name, description: name, parameters: { type: "object" }, sourceInfo: { source: "builtin" },
    })),
  } as unknown as ExtensionAPI);
  const h: Harness = { sessionFile, nativeReads,
    emit: async (name: string) => await hooks.get(name)!({}, ctx),
    command: async (name: string) => await commands.get(name)!.handler("", ctx),
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
