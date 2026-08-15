import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeBranchEvent,
  SessionBeforeBranchResult,
  SessionBeforeSwitchEvent,
  SessionBeforeSwitchResult,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { REMOTE_TOOL_NAMES } from "../src/protocol.ts";

const target = Bun.env.REMOTE_TARGET;
const cwd = Bun.env.REMOTE_CWD;
const identityFile = Bun.env.REMOTE_IDENTITY;
const knownHostsFile = Bun.env.REMOTE_KNOWN_HOSTS;
const port = Bun.env.REMOTE_PORT ?? "22";
if (!target || !cwd || !identityFile || !knownHostsFile)
  throw new Error("Remote smoke environment is incomplete");

const localCwd = process.cwd();
const ownerSession = "/tmp/omp-ssh-remote-smoke/session.jsonl";
const childSession = "/tmp/omp-ssh-remote-smoke/session/Child.jsonl";
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

type Command = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};
type HandlerMap = {
  session_start?: Array<
    (
      event: SessionStartEvent,
      ctx: ExtensionContext,
    ) => Promise<unknown> | unknown
  >;
  session_before_switch?: Array<
    (
      event: SessionBeforeSwitchEvent,
      ctx: ExtensionContext,
    ) =>
      | Promise<SessionBeforeSwitchResult | undefined>
      | SessionBeforeSwitchResult
      | undefined
  >;
  session_before_branch?: Array<
    (
      event: SessionBeforeBranchEvent,
      ctx: ExtensionContext,
    ) =>
      | Promise<SessionBeforeBranchResult | undefined>
      | SessionBeforeBranchResult
      | undefined
  >;
  session_shutdown?: Array<
    (
      event: SessionShutdownEvent,
      ctx: ExtensionContext,
    ) => Promise<unknown> | unknown
  >;
  tool_call?: Array<
    (
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ) =>
      Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined
  >;
};

function harness(sessionFile: string) {
  const commands = new Map<string, Command>();
  const tools = new Map<string, ToolDefinition>();
  const handlers: HandlerMap = {};
  const api = {
    registerCommand(name: string, command: Command) {
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
    on(event: keyof HandlerMap, handler: never) {
      (handlers[event] ??= []).push(handler);
    },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: localCwd,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setWorkingMessage() {}, setStatus() {}, notify() {} },
    invokeTool: async (): Promise<AgentToolResult> => ({
      content: [{ type: "text", text: "local fallback" }],
    }),
  } as unknown as ExtensionCommandContext & ExtensionContext;
  return { api, commands, tools, handlers, context };
}

async function within<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  console.error(`[subagent-smoke] ${label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// OMP cache-busts each session's extension entry. Dynamic imports here intentionally verify that process-global broker state survives distinct module instances.
const ownerExtensionUrl = "../src/extension.ts?session=owner";
const childExtensionUrl = "../src/extension.ts?session=child";
const ownerExtension = (
  (await import(ownerExtensionUrl)) as typeof import("../src/extension.ts")
).default;
const childExtension = (
  (await import(childExtensionUrl)) as typeof import("../src/extension.ts")
).default;

const owner = harness(ownerSession);
const child = harness(childSession);
await ownerExtension(owner.api);
await childExtension(child.api);
const connect = owner.commands.get("remote-connect");
const exit = owner.commands.get("remote-exit");
if (!connect || !exit)
  throw new Error("Owner remote commands were not registered");
let ownerConnected = false;
let childConnected = false;
try {
  await within(
    "connecting owner",
    connect.handler(
      `${target} ${cwd} --port ${port} --identity ${identityFile} --known-hosts ${knownHostsFile}`,
      owner.context,
    ),
  );
  ownerConnected = true;
  for (const handler of child.handlers.session_start ?? []) {
    await within(
      "auto-connecting child",
      Promise.resolve(handler({ type: "session_start" }, child.context)),
    );
  }
  childConnected = true;

  const switchGuard = owner.handlers.session_before_switch?.[0];
  const branchGuard = owner.handlers.session_before_branch?.[0];
  if (!switchGuard || !branchGuard)
    throw new Error("Remote session transition guards were not registered");
  const switchResult = await within(
    "checking session switch guard",
    Promise.resolve(
      switchGuard(
        { type: "session_before_switch", reason: "new" },
        owner.context,
      ),
    ),
  );
  const branchResult = await within(
    "checking session branch guard",
    Promise.resolve(
      branchGuard(
        { type: "session_before_branch", entryId: "probe" },
        owner.context,
      ),
    ),
  );
  if (switchResult?.cancel !== true || branchResult?.cancel !== true)
    throw new Error("Remote session transition guards did not cancel");

  const ownerEval = owner.tools.get("eval");
  const childEval = child.tools.get("eval");
  if (!ownerEval || !childEval)
    throw new Error("Parent or child eval wrapper is missing");
  await within(
    "setting owner eval state",
    ownerEval.execute(
      "owner-eval-set",
      { language: "py", title: "owner", code: "shared_value = 11" },
      undefined,
      undefined,
      owner.context,
    ),
  );
  await within(
    "setting child eval state",
    childEval.execute(
      "child-eval-set",
      { language: "py", title: "child", code: "shared_value = 31" },
      undefined,
      undefined,
      child.context,
    ),
  );
  const ownerResult = await within(
    "reading owner eval state",
    ownerEval.execute(
      "owner-eval-get",
      { language: "py", title: "owner", code: "print(shared_value)" },
      undefined,
      undefined,
      owner.context,
    ),
  );
  const childResult = await within(
    "reading child eval state",
    childEval.execute(
      "child-eval-get",
      { language: "py", title: "child", code: "print(shared_value)" },
      undefined,
      undefined,
      child.context,
    ),
  );
  if (
    !JSON.stringify(ownerResult).includes("11") ||
    !JSON.stringify(childResult).includes("31")
  ) {
    throw new Error("Parent and child eval state was not isolated");
  }

  let activeChildRejected = false;
  try {
    await within(
      "checking active-child disconnect guard",
      exit.handler("", owner.context),
    );
  } catch (error) {
    activeChildRejected = String(error).includes(
      "subagent sessions are still active",
    );
  }
  if (!activeChildRejected)
    throw new Error("Owner disconnect did not reject an active child session");

  for (const handler of child.handlers.session_shutdown ?? []) {
    await within(
      "shutting down child",
      Promise.resolve(handler({ type: "session_shutdown" }, child.context)),
    );
  }
  childConnected = false;
  await within("disconnecting owner", exit.handler("", owner.context));
  ownerConnected = false;
  console.log(
    JSON.stringify({
      inherited: "ok",
      separateWorkers: "ok",
      evalIsolation: "ok",
      activeChildGuard: "ok",
      sessionTransitionGuard: "ok",
      cleanup: "ok",
    }),
  );
} finally {
  if (childConnected) {
    for (const handler of child.handlers.session_shutdown ?? []) {
      await Promise.resolve(
        handler({ type: "session_shutdown" }, child.context),
      ).catch(() => undefined);
    }
  }
  if (ownerConnected)
    await exit.handler("--force", owner.context).catch(() => undefined);
}
