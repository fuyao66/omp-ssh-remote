import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProxyMessageEventStream } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RemoteRuntimeClient } from "../../src/client.ts";
import * as configuration from "../../src/connect-options.ts";
import * as deployment from "../../src/deploy.ts";
import * as identity from "../../src/omp/host-identity.ts";
import * as ssh from "../../src/ssh.ts";

const RUN = "OMP_REAL_SESSION_FIXTURE";
const SCENARIO = "OMP_REAL_SESSION_SCENARIO";
const workerEntry = resolve(import.meta.dir, "../../src/worker.ts");
export const fixtureFile = "same-name.txt";
export const localText = "local-only sentinel";
export const remoteText = "remote-only sentinel";

// Linux /proc sees even a descendant that creates a fresh process group (e.g. a
// daemon). Match the unique per-run environment entry before signalling a PID.
function ownedProcesses(root: string): Map<number, string> {
  const found = new Map<number, string>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`${RUN}=${root}`)) {
        found.set(Number(entry), readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ").trim());
      }
    } catch {
      // Other users' processes are unreadable; exited processes race the scan.
    }
  }
  return found;
}

export function realSessionTest(file: string, name: string, scenario: (root: string) => Promise<void>) {
  if (process.env[SCENARIO] !== undefined) {
    if (process.env[SCENARIO] === name) test(name, () => scenario(process.env[RUN]!), 35_000);
    return;
  }
  test(name, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-real-"));
    try {
      for (const dir of ["home", "agent", "local", "remote", "worker-home", "worker-agent", "sessions", "tmp"]) {
        await mkdir(join(root, dir));
      }
      await writeFile(join(root, "local", fixtureFile), localText);
      await writeFile(join(root, "remote", fixtureFile), remoteText);
      // Record Bun descendants at startup, even if they exit between process
      // tree samples. The ownership scan also catches non-Bun children.
      const audit = join(root, "pid-audit.ts");
      const pidLog = join(root, "pids.jsonl");
      await writeFile(audit, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(pidLog)}, JSON.stringify([process.pid, process.argv.join(" ")]) + "\\n");\n`);
      // Intentionally do not inherit profile, credential, proxy or extension env.
      const child = spawn(process.execPath, ["test", resolve(file), "--timeout", "35000"], {
        cwd: join(root, "local"),
        env: {
          PATH: process.env.PATH, LANG: "C.UTF-8", HOME: join(root, "home"),
          PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: join(root, "tmp"),
          OMP_DAEMON_DIR: join(root, "daemon"), [RUN]: root, [SCENARIO]: name,
          BUN_OPTIONS: `--preload=${audit}`,
        },
        detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", timedOut = false;
      const seen = new Map<number, string>();
      if (child.pid) seen.set(child.pid, "SDK host");
      const sample = () => {
        for (const [pid, command] of ownedProcesses(root)) if (!seen.has(pid)) seen.set(pid, command);
      };
      const sampler = setInterval(sample, 100);
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => { output += data; });
      const deadline = setTimeout(() => {
        timedOut = true;
        sample();
        for (const pid of ownedProcesses(root).keys()) signal(pid, "SIGKILL");
        if (child.pid && child.exitCode === null && child.signalCode === null) signal(-child.pid, "SIGKILL");
      }, 42_000);
      const exited = Promise.withResolvers<number | null>();
      child.once("close", exited.resolve);
      child.once("error", exited.reject);
      const code = await exited.promise.finally(() => { clearInterval(sampler); clearTimeout(deadline); });
      const leaked = ownedProcesses(root);
      if (leaked.size) {
        for (const pid of leaked.keys()) signal(pid, "SIGTERM");
        for (let attempt = 0; attempt < 20 && ownedProcesses(root).size; attempt++) await Bun.sleep(25);
        for (const pid of ownedProcesses(root).keys()) signal(pid, "SIGKILL");
        for (let attempt = 0; attempt < 20 && ownedProcesses(root).size; attempt++) await Bun.sleep(25);
      }
      for (const line of (await Bun.file(pidLog).exists() ? await Bun.file(pidLog).text() : "").trim().split("\n")) {
        if (!line) continue;
        const [pid, command]: [number, string] = JSON.parse(line);
        seen.set(pid, command);
      }
      const evidence = `${name}\n${output}\nFixture PIDs: ${JSON.stringify([...seen])}`;
      expect([...ownedProcesses(root)], evidence).toEqual([]);
      expect([...leaked], evidence).toEqual([]);
      expect(timedOut, evidence).toBe(false);
      expect(code, evidence).toBe(0);
      expect(output, evidence).toMatch(/\b1 pass\b/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 48_000);
}

function signal(pid: number, sig: NodeJS.Signals) {
  try { process.kill(pid, sig); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export function hold() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { entered: entered.promise, release: () => released.resolve(), async pause() {
    entered.resolve();
    await released.promise;
  } };
}

type ToolCall = { name: string; arguments: Record<string, unknown> };
function scriptedProvider(auth: AuthStorage, settings: Settings) {
  const registry = new ModelRegistry(auth, undefined, { settings, ignoreLocalModelConfig: true,
    fetch: async () => { throw new Error("Unexpected registry network request"); } });
  const id = "real-session-fixture";
  const dispatches: { model: string; messages: unknown[]; tools: { name: string; [key: string]: unknown }[] }[] = [];
  const replies: (ToolCall | null)[] = [];
  const unexpected: string[] = [];
  registry.registerProvider(id, {
    api: id, apiKey: "fixture", baseUrl: "https://fixture.invalid",
    models: [{ id, name: id, reasoning: false, input: ["text"], supportsTools: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024 }],
    streamSimple: (model, context) => {
      dispatches.push({ model: `${model.provider}/${model.id}`, messages: structuredClone(context.messages),
        tools: (context.tools ?? []).map(({ name, description, parameters, customFormat, customWireName }) =>
          structuredClone({ name, description, parameters, customFormat, customWireName })) });
      if (!replies.length) unexpected.push(`Unscripted provider request ${dispatches.length}`);
      const call = replies.shift();
      const stream = new ProxyMessageEventStream();
      const reason: "toolUse" | "stop" = call ? "toolUse" : "stop";
      const toolCall = call ? { type: "toolCall" as const, id: `fixture-call-${dispatches.length}`, ...call } : undefined;
      const message = {
        role: "assistant" as const, content: toolCall ? [toolCall] : [{ type: "text" as const, text: "Fixture turn complete." }],
        api: id, provider: id, model: id, stopReason: reason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      // The native loop drops calls that never completed a streamed block.
      if (toolCall) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      }
      stream.push({ type: "done", reason, message });
      stream.end();
      return stream;
    },
  });
  const model = registry.find(id, id);
  if (!model) throw new Error("Scripted provider failed to register its model");
  return { registry, model, dispatches, replies, unexpected, dispose: () => registry.unregisterProvider(id) };
}

type FixtureOptions = {
  beforeRemote?: ExtensionFactory[];
  afterRemote?: ExtensionFactory[];
  // Runs after native construction but before session_start schedules wrappers.
  beforeStart?: (session: AgentSession) => void;
  settings?: Parameters<typeof Settings.isolated>[0];
  approve?: NonNullable<Parameters<typeof initializeExtensions>[1]["uiContext"]>["approve"];
  afterExecute?: (tool: string, result: unknown) => Promise<void>;
};

export async function createRealSession(root: string, options: FixtureOptions = {}) {
  const cwd = join(root, "local"), remoteCwd = join(root, "remote"), agentDir = join(root, "agent");
  const settings = Settings.isolated({ "task.workerThreads": 0, ...options.settings });
  const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
  const provider = scriptedProvider(auth, settings);
  const clients: { client: RemoteRuntimeClient; initialize: Parameters<RemoteRuntimeClient["initialize"]> }[] = [];
  const calls: Parameters<RemoteRuntimeClient["execute"]>[] = [];
  const dispatchModels: string[] = [];
  const runtimeErrors: unknown[] = [];
  const initialize = RemoteRuntimeClient.prototype.initialize;
  const execute = RemoteRuntimeClient.prototype.execute;
  const cacheAudit = { available: false as const, observedAt: "fixture", warning: "fixture cache" };
  // Only deployment and process selection are replaced. The real client owns
  // framing, invocation callbacks, worker initialization, and shutdown.
  const spies = [
    spyOn(identity, "resolveOmpHostVersion").mockImplementation(() => identity.resolveOmpBuildVersion()),
    spyOn(configuration, "loadConfiguredSshHosts").mockResolvedValue([]),
    spyOn(deployment, "prepareRemoteWorker").mockImplementation(async ({ signal }) => ({
      workerPath: workerEntry, home: join(root, "worker-home"), signal: signal!, cacheAudit,
      async commitUsage() { return cacheAudit; }, async dispose() {},
    })),
    spyOn(ssh, "buildSshWorkerCommand").mockReturnValue([
      "env", `HOME=${join(root, "worker-home")}`, `PI_CODING_AGENT_DIR=${join(root, "worker-agent")}`,
      process.execPath, workerEntry,
    ]),
    spyOn(RemoteRuntimeClient.prototype, "initialize").mockImplementation(function (this: RemoteRuntimeClient, ...args) {
      clients.push({ client: this, initialize: args });
      return initialize.apply(this, args);
    }),
    spyOn(RemoteRuntimeClient.prototype, "execute").mockImplementation(async function (this: RemoteRuntimeClient, ...args) {
      calls.push(args);
      const result = await execute.apply(this, args);
      await options.afterExecute?.(args[0], result);
      return result;
    }),
  ];
  let session: AgentSession | undefined;
  async function dispose() {
    try { await session?.dispose(); }
    finally {
      try {
        await Promise.all(clients.map(async ({ client }) => {
          await client.close();
          await client.waitForExit();
        }));
      } finally {
        for (const spy of spies.reverse()) spy.mockRestore();
        provider.dispose();
        auth.close();
      }
    }
  }
  try {
    // Import the plugin only after overriding the external launch boundaries.
    const { default: remote } = await import("../../src/extension.ts");
    const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
    ({ session } = await createAgentSession({
      cwd, agentDir, settings, sessionManager, authStorage: auth, modelRegistry: provider.registry, model: provider.model,
      enableLsp: false, enableMCP: false, skipPythonPreflight: true, noContextFiles: true,
      skills: [], rules: [], promptTemplates: [], slashCommands: [], preloadedCustomToolPaths: [], preloadedExtensionPaths: [],
      extensions: [...(options.beforeRemote ?? []), remote, ...(options.afterRemote ?? [])],
      cacheWarming: "off", suppressAutoPrewalk: true, disableModelFallback: true,
      jobWidgetAuthor: async () => undefined, jobCaptionWriter: async () => undefined,
      hasUI: options.approve !== undefined,
      getApiKey: async () => "fixture",
      assertDispatchModel(model) {
        dispatchModels.push(`${model.provider}/${model.id}`);
        if (model.provider !== provider.model.provider) throw new Error(`Unexpected dispatch to ${model.provider}`);
      },
    }));
    const live = session;
    options.beforeStart?.(live);
    await initializeExtensions(live, {
      reportSendError: (_action, error) => runtimeErrors.push(error),
      reportRuntimeError: error => runtimeErrors.push(error),
      uiContext: options.approve ? { ...live.extensionRunner!.getUIContext(), approve: options.approve } : undefined,
    });
    const runner = live.extensionRunner!;
    const command = async (name: string, args = "") => {
      const command = runner.getCommand(name);
      if (!command) throw new Error(`No native registered command /${name}`);
      await command.handler(args, runner.createCommandContext());
    };
    return { root, cwd, remoteCwd, session: live, runner, provider, dispatchModels, calls, clients, command,
      connect: () => command("remote-connect", `fixture.invalid ${remoteCwd}`),
      disconnect: () => command("remote-exit"),
      async turn(prompt: string, call?: ToolCall) {
        const start = provider.dispatches.length;
        provider.replies.push(...(call ? [call, null] : [null]));
        await live.prompt(prompt);
        expect(provider.dispatches.length - start, JSON.stringify(live.messages.slice(-3))).toBe(call ? 2 : 1);
        expect(provider.replies).toEqual([]);
        expect(provider.unexpected).toEqual([]);
        expect(runtimeErrors).toEqual([]);
        return provider.dispatches.slice(start);
      }, dispose, runtimeErrors,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
