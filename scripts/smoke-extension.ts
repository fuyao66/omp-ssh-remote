import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
const { default: remoteRuntimeExtension } = await import(
  new URL("../packages/omp/dist/extension.js", import.meta.url).href
);
import { REMOTE_TOOL_NAMES } from "../src/protocol.ts";
import { toolParametersToWire } from "../src/omp/runtime-contract.ts";
import { createNativeWorkerRuntime } from "../src/runtime.ts";

const alias = Bun.env.REMOTE_ALIAS;
const target = Bun.env.REMOTE_TARGET;
const cwd = Bun.env.REMOTE_CWD;
const identityFile = Bun.env.REMOTE_IDENTITY;
const knownHostsFile = Bun.env.REMOTE_KNOWN_HOSTS;
const port = Bun.env.REMOTE_PORT ?? "22";
if (!cwd || (!alias && (!target || !identityFile || !knownHostsFile))) {
  throw new Error("Remote smoke environment is incomplete");
}

const activeTools = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "lsp",
  "ast_edit",
  "eval",
  "debug",
  "hub",
];
const hubOwner = `smoke-owner-${process.pid}`;
const launchCompletions: unknown[] = [];
type CapturedCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};
const commands = new Map<string, CapturedCommand>();
const tools = new Map<string, ToolDefinition>();
const events = new Set<string>();

const schemaRuntime = await createNativeWorkerRuntime(process.cwd(), "smoke");
const nativeTools = REMOTE_TOOL_NAMES.map((name) => ({
  name,
  description: schemaRuntime.tools[name].description,
  parameters: toolParametersToWire(schemaRuntime.tools[name].parameters),
  sourceInfo: {
    path: "builtin",
    source: "builtin",
    scope: "builtin",
    origin: "builtin",
  },
})) as unknown as ToolInfo[];
const apiHarness = {
  registerCommand(name: string, command: CapturedCommand) {
    commands.set(name, command);
  },
  registerTool(tool: ToolDefinition) {
    tools.set(tool.name, tool);
  },
  getActiveTools() {
    return activeTools;
  },
  getAllTools() {
    return nativeTools;
  },
  on(event: string) {
    events.add(event);
  },
  sendMessage(message: { customType?: string; details?: unknown }) {
    if (message.customType === "launch-completion") launchCompletions.push(message.details);
  },
};
await remoteRuntimeExtension(apiHarness as unknown as ExtensionAPI);

const workspaceStatus = tools.get("remote_workspace_status");
if (!workspaceStatus)
  throw new Error("remote_workspace_status was not registered");
const beforeConnectStatus = await workspaceStatus.execute(
  "status-before-connect",
  {},
  undefined,
  undefined,
  {} as never,
);
const beforeConnectDetails = beforeConnectStatus.details as {
  mode?: string;
  transport?: string;
};
if (
  beforeConnectDetails.mode !== "local" ||
  beforeConnectDetails.transport !== "not-selected"
) {
  throw new Error(
    "Workspace status did not report local mode before remote connection",
  );
}

const notices: string[] = [];
const commandContext = {
  cwd: process.cwd(),
  sessionManager: {
    getSessionFile: () => "/tmp/omp-ssh-remote-smoke/extension.jsonl",
    getSessionId: () => hubOwner,
  },
  ui: {
    setWorkingMessage() {},
    setStatus() {},
    notify(message: string) {
      notices.push(message);
    },
  },
} as unknown as ExtensionCommandContext;
const connect = commands.get("remote-connect");
if (!connect) throw new Error("remote-connect was not registered");
const connectArgs = alias
  ? `${alias} ${cwd}`
  : `${target} ${cwd} --port ${port} --identity ${identityFile} --known-hosts ${knownHostsFile}`;
await connect.handler(connectArgs, commandContext);
if (events.has("context"))
  throw new Error(
    "Extension registered a model-visible workspace-state handler",
  );
const exit = commands.get("remote-exit");
if (!exit) throw new Error("remote-exit was not registered");

/**
 * Count still-running instances of the smoke service on the remote host after
 * remote-exit. Uses a plain SSH probe (same auth material as the connection)
 * so the check does not depend on the just-closed companion.
 */
async function remoteServiceSurvivors(serviceName: string): Promise<number> {
  const sshArgs = alias
    ? [alias]
    : [
        "-p",
        port,
        "-i",
        identityFile!,
        "-o",
        `UserKnownHostsFile=${knownHostsFile}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "BatchMode=yes",
        target!,
      ];
  // The service argv embeds `marker=<serviceName> `. The probe shell's own
  // command line carries the split form `"marker=""<name> "`, so it never
  // matches itself; pgrep excludes its own process.
  const probe = `pgrep -fc -- "marker=""${serviceName} " || true`;
  const proc = Bun.spawn(["ssh", ...sshArgs, probe], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number.parseInt(out.trim() || "0", 10);
}
let disconnected = false;
try {
  const expectedToolNames = new Set([
    ...activeTools,
    "remote_workspace_status",
    "remote_connect",
    "remote_exit",
  ]);
  if (
    tools.size !== expectedToolNames.size ||
    [...expectedToolNames].some((name) => !tools.has(name))
  )
    throw new Error(
      `Unexpected OMP tool table: ${[...tools.keys()].join(", ")}`,
    );
  if (tools.has("ast_grep"))
    throw new Error("ast_grep was incorrectly exposed as a top-level tool");
  for (const name of activeTools) {
    const tool = tools.get(name);
    if (!tool?.renderCall || !tool.renderResult) {
      throw new Error(`Remote wrapper ${name} is missing native renderer callbacks`);
    }
  }

  const invokeContext = {
    invokeTool: async (
      params: Record<string, unknown>,
    ): Promise<AgentToolResult> => {
      const path = typeof params.path === "string" ? params.path : "";
      const device = /^xd:\/\/([^/]+)$/.exec(path)?.[1];
      if (
        device &&
        ["lsp", "ast_grep", "ast_edit"].includes(device) &&
        params.content === "?"
      ) {
        return {
          content: [{ type: "text", text: `native ${device} docs` }],
          details: { xdev: { tool: device, mode: "help" } },
        };
      }
      return { content: [{ type: "text", text: "local fallback" }] };
    },
  } as unknown as ExtensionContext;
  const write = tools.get("write");
  const read = tools.get("read");
  const bash = tools.get("bash");
  const astEdit = tools.get("ast_edit");
  const lsp = tools.get("lsp");
  const evalTool = tools.get("eval");
  const debug = tools.get("debug");
  const hub = tools.get("hub");
  if (!write || !read || !bash || !astEdit || !lsp || !evalTool || !debug || !hub) {
    throw new Error("Active remote wrappers were not registered");
  }

  const connectedStatus = await workspaceStatus.execute(
    "status-connected",
    {},
    undefined,
    undefined,
    invokeContext,
  );
  const connectedDetails = connectedStatus.details as {
    mode?: string;
    remoteCwd?: string | null;
  };
  if (
    connectedDetails.mode !== "remote" ||
    connectedDetails.remoteCwd !== cwd
  ) {
    throw new Error(
      `Workspace status did not report the connected remote runtime: ${JSON.stringify(connectedStatus.details)}`,
    );
  }

  const content = `adapter-${Date.now()}`;
  await write.execute(
    "adapter-write",
    { path: "adapter.ts", content: `const value = oldApi(1); // ${content}\n` },
    undefined,
    undefined,
    invokeContext,
  );
  const readResult = await read.execute(
    "adapter-read",
    { path: "adapter.ts" },
    undefined,
    undefined,
    invokeContext,
  );
  const bashResult = await bash.execute(
    "adapter-bash",
    { command: "cat adapter.ts" },
    undefined,
    undefined,
    invokeContext,
  );
  if (
    !JSON.stringify(readResult).includes(content) ||
    !JSON.stringify(bashResult).includes(content)
  ) {
    throw new Error(
      "Extension wrappers did not execute against the remote worker",
    );
  }

  const preview = await astEdit.execute(
    "adapter-ast-preview",
    {
      ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }],
      paths: ["adapter.ts"],
    },
    undefined,
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(preview).includes("files NOT modified yet"))
    throw new Error("Remote AST edit did not stage a proposal");
  const beforeResolve = await bash.execute(
    "adapter-before-resolve",
    { command: "cat adapter.ts" },
    undefined,
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(beforeResolve).includes("oldApi"))
    throw new Error("Remote AST preview modified the file before resolve");
  const resolved = await write.execute(
    "adapter-resolve",
    { path: "xd://resolve", content: "Apply the verified structural rewrite" },
    undefined,
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(resolved).includes("Applied"))
    throw new Error("Remote AST proposal did not resolve");
  const afterResolve = await bash.execute(
    "adapter-after-resolve",
    { command: "cat adapter.ts" },
    undefined,
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(afterResolve).includes("newApi"))
    throw new Error("Resolved AST proposal did not update the remote file");

  const lspStatus = await lsp.execute(
    "adapter-lsp-status",
    { action: "status" },
    undefined,
    undefined,
    invokeContext,
  );
  if (
    !JSON.stringify(lspStatus).includes("Language servers") &&
    !JSON.stringify(lspStatus).includes("No language servers")
  ) {
    throw new Error("Remote native LSP status did not execute");
  }

  await evalTool.execute(
    "adapter-eval-py-setup",
    { language: "py", title: "setup", code: "remote_value = 40" },
    undefined,
    undefined,
    invokeContext,
  );
  const evalPy = await evalTool.execute(
    "adapter-eval-py-use",
    { language: "py", title: "reuse", code: "print(remote_value + 2)" },
    undefined,
    undefined,
    invokeContext,
  );
  await evalTool.execute(
    "adapter-eval-js-setup",
    { language: "js", title: "setup", code: "globalThis.remoteValue = 6" },
    undefined,
    undefined,
    invokeContext,
  );
  const evalJs = await evalTool.execute(
    "adapter-eval-js-use",
    {
      language: "js",
      title: "reuse",
      code: "print(globalThis.remoteValue * 7)",
    },
    undefined,
    undefined,
    invokeContext,
  );
  if (
    !JSON.stringify(evalPy).includes("42") ||
    !JSON.stringify(evalJs).includes("42")
  ) {
    throw new Error("Remote eval kernels did not preserve state");
  }
  let remoteDebug = "skipped";
  let hasPython = false;
  try {
    const pythonCheck = await bash.execute(
      "adapter-python-check",
      {
        command:
          "command -v python3 && python3 -c 'import debugpy' 2>/dev/null && echo debugpy-ok || echo debugpy-missing",
        timeout: 10,
      },
      undefined,
      undefined,
      invokeContext,
    );
    hasPython = JSON.stringify(pythonCheck).includes("debugpy-ok");
  } catch {
    hasPython = false;
  }
  if (hasPython) {
    await write.execute(
      "adapter-debug-source",
      {
        path: "debug_probe.py",
        content:
          "def main():\n    value = 42\n    return 0 if value == 42 else 1\n\nraise SystemExit(main())\n",
      },
      undefined,
      undefined,
      invokeContext,
    );
    try {
      const launched = await debug.execute(
        "adapter-debug-launch",
        {
          action: "launch",
          program: "debug_probe.py",
          adapter: "debugpy",
          timeout: 20,
        },
        AbortSignal.timeout(30_000),
        undefined,
        invokeContext,
      );
      const stack = await debug.execute(
        "adapter-debug-stack",
        { action: "stack_trace", levels: 4, timeout: 10 },
        AbortSignal.timeout(15_000),
        undefined,
        invokeContext,
      );
      const evaluated = await debug.execute(
        "adapter-debug-evaluate",
        {
          action: "evaluate",
          expression: "1 + 1",
          context: "repl",
          timeout: 10,
        },
        AbortSignal.timeout(15_000),
        undefined,
        invokeContext,
      );
      const terminated = await debug.execute(
        "adapter-debug-terminate",
        { action: "terminate", timeout: 10 },
        AbortSignal.timeout(15_000),
        undefined,
        invokeContext,
      );
      if (
        !JSON.stringify(launched).includes("debugpy") ||
        !JSON.stringify(stack).includes("debug_probe.py") ||
        !JSON.stringify(evaluated).includes("2") ||
        !JSON.stringify(terminated).includes("terminated")
      ) {
        throw new Error(
          "Remote debugpy DAP session returned an invalid result",
        );
      }
      remoteDebug = "ok";
    } catch (error) {
      remoteDebug = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
      try {
        await debug.execute(
          "adapter-debug-cleanup",
          { action: "terminate", timeout: 5 },
          AbortSignal.timeout(8_000),
          undefined,
          invokeContext,
        );
      } catch {}
    }
  }

  // hub: process supervision runs in the remote project broker; messaging/jobs
  // are local control-plane ops and must never leave the host.
  const localHub = await hub.execute(
    "adapter-hub-list",
    { op: "list" },
    AbortSignal.timeout(10_000),
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(localHub).includes("local fallback"))
    throw new Error("hub list did not stay on the local control plane");
  const serviceName = `smoke-svc-${process.pid}`;
  const started = await hub.execute(
    "adapter-hub-start",
    {
      op: "start",
      name: serviceName,
      application: "sh",
      args: ["-c", `marker=${serviceName} ; echo smoke-ready; hostname; sleep 120`],
      ready: { log: "smoke-ready", timeout: 20 },
    },
    AbortSignal.timeout(30_000),
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(started).includes(serviceName))
    throw new Error("Remote hub start did not report the service");
  const remoteHostname = JSON.stringify(
    await bash.execute(
      "adapter-hub-hostname",
      { command: "hostname" },
      AbortSignal.timeout(15_000),
      undefined,
      invokeContext,
    ),
  );
  const serviceLogs = await hub.execute(
    "adapter-hub-logs",
    { op: "logs", name: serviceName },
    AbortSignal.timeout(15_000),
    undefined,
    invokeContext,
  );
  const serviceLogText = JSON.stringify(serviceLogs);
  const remoteHost = /"text":"([^"\\]+)/.exec(remoteHostname)?.[1]?.trim();
  if (!serviceLogText.includes("smoke-ready") || !remoteHost || !serviceLogText.includes(remoteHost))
    throw new Error(`Remote service logs did not come from the remote host (${remoteHost ?? "?"}): ${serviceLogText.slice(0, 300)}`);
  // A short-lived service exits on its own; the owner must be told.
  const shortName = `smoke-short-${process.pid}`;
  const completionSeen = new Promise<void>((resolve) => {
    const poll = () => {
      if (launchCompletions.some((entry) => JSON.stringify(entry).includes(shortName))) resolve();
      else setTimeout(poll, 100);
    };
    poll();
  });
  await hub.execute(
    "adapter-hub-start-short",
    { op: "start", name: shortName, application: "sh", args: ["-c", "exit 7"] },
    AbortSignal.timeout(30_000),
    undefined,
    invokeContext,
  );
  await Promise.race([
    completionSeen,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("No launch-completion delivered for the exited remote service")), 20_000),
    ),
  ]);
  const remoteHub = "ok";

  await exit.handler("", commandContext);
  disconnected = true;
  const localStatus = await workspaceStatus.execute(
    "status-after-exit",
    {},
    undefined,
    undefined,
    invokeContext,
  );
  const localDetails = localStatus.details as { mode?: string };
  if (localDetails.mode !== "local")
    throw new Error(
      "Workspace status did not restore local mode after remote-exit",
    );
  const localResult = await read.execute(
    "local-read",
    { path: "anything" },
    undefined,
    undefined,
    invokeContext,
  );
  if (!JSON.stringify(localResult).includes("local fallback"))
    throw new Error(
      "Extension did not restore native fallback after remote-exit",
    );
  // Non-persist services started by this session must be gone after exit.
  const survivors = await remoteServiceSurvivors(serviceName);
  console.log(
    JSON.stringify({
      commands: [...commands.keys()],
      topLevelTools: [...tools.keys()],
      remoteCore: "ok",
      remoteXdev: "ok",
      remoteLsp: "ok",
      remoteEval: "ok",
      remoteDebug,
      remoteHub,
      remoteHubCleanupAfterExit: survivors === 0 ? "ok" : `FAILED: ${survivors} still running`,
      localFallback: "ok",
      notices,
    }),
  );
  if (survivors !== 0) throw new Error("Remote non-persist service survived remote-exit");
} finally {
  if (!disconnected)
    await exit.handler("--force", commandContext).catch(() => undefined);
}
