import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import remoteRuntimeExtension from "../src/extension.ts";
import { REMOTE_TOOL_NAMES } from "../src/protocol.ts";

const alias = Bun.env.REMOTE_ALIAS;
const target = Bun.env.REMOTE_TARGET;
const cwd = Bun.env.REMOTE_CWD;
const identityFile = Bun.env.REMOTE_IDENTITY;
const knownHostsFile = Bun.env.REMOTE_KNOWN_HOSTS;
const port = Bun.env.REMOTE_PORT ?? "22";
if (!cwd || (!alias && (!target || !identityFile || !knownHostsFile))) {
  throw new Error(
    "REMOTE_CWD plus either REMOTE_ALIAS or explicit remote connection variables are required",
  );
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
];
type CapturedCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};
const commands = new Map<string, CapturedCommand>();
const tools = new Map<string, ToolDefinition>();
const events = new Set<string>();

const nativeTools = REMOTE_TOOL_NAMES.map((name) => ({
  name,
  description: `native ${name}`,
  parameters: { type: "object", additionalProperties: true },
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
const connectArgs =
  alias ??
  `${target} ${cwd} --port ${port} --identity ${identityFile} --known-hosts ${knownHostsFile}`;
await connect.handler(connectArgs, commandContext);
if (events.has("context"))
  throw new Error(
    "Extension registered a model-visible workspace-state handler",
  );
const exit = commands.get("remote-exit");
if (!exit) throw new Error("remote-exit was not registered");
let disconnected = false;
try {
  if (tools.size !== activeTools.length + 1)
    throw new Error(
      `Expected ${activeTools.length} remote wrappers plus workspace status, got ${tools.size}`,
    );
  if (tools.has("ast_grep"))
    throw new Error("ast_grep was incorrectly exposed as a top-level tool");

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
  if (!write || !read || !bash || !astEdit || !lsp || !evalTool || !debug) {
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
      "Workspace status did not report the connected remote runtime",
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
    const launched = await debug.execute(
      "adapter-debug-launch",
      {
        action: "launch",
        program: "debug_probe.py",
        adapter: "debugpy",
        timeout: 60,
      },
      undefined,
      undefined,
      invokeContext,
    );
    const stack = await debug.execute(
      "adapter-debug-stack",
      { action: "stack_trace", levels: 4, timeout: 20 },
      undefined,
      undefined,
      invokeContext,
    );
    const evaluated = await debug.execute(
      "adapter-debug-evaluate",
      { action: "evaluate", expression: "1 + 1", context: "repl", timeout: 20 },
      undefined,
      undefined,
      invokeContext,
    );
    const terminated = await debug.execute(
      "adapter-debug-terminate",
      { action: "terminate", timeout: 20 },
      undefined,
      undefined,
      invokeContext,
    );
    if (
      !JSON.stringify(launched).includes("debugpy") ||
      !JSON.stringify(stack).includes("debug_probe.py")
    ) {
      throw new Error(
        "Remote debugpy DAP session did not preserve stack state",
      );
    }
    if (
      !JSON.stringify(evaluated).includes("2") ||
      !JSON.stringify(terminated).includes("terminated")
    ) {
      throw new Error("Remote GDB DAP evaluate/terminate failed");
    }
    remoteDebug = "ok";
  }

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
  console.log(
    JSON.stringify({
      commands: [...commands.keys()],
      topLevelTools: [...tools.keys()],
      remoteCore: "ok",
      remoteXdev: "ok",
      remoteLsp: "ok",
      remoteEval: "ok",
      remoteDebug,
      localFallback: "ok",
      notices,
    }),
  );
} finally {
  if (!disconnected)
    await exit.handler("--force", commandContext).catch(() => undefined);
}
