import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AFT_REMOTE_TOOLS,
  PI_NATIVE_TOOLS,
  PI_TOOL_RUNTIME_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  type ExecuteRequest,
  type ReadyMessage,
  type ToolManifest,
} from "./protocol.ts";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import aftExtension from "@cortexkit/aft-pi";
export { AFT_EXTENDED_TOOLS } from "./protocol.ts";

export interface PiNativeWorkerRuntime {
  manifest: ReadyMessage;
  execute(
    request: ExecuteRequest,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown>;
  close(): Promise<void>;
}
type ExecutableTool = Pick<
  ToolDefinition,
  "description" | "parameters" | "execute"
>;

function nativeToolMap(cwd: string): Map<string, ExecutableTool> {
  const tools = new Map<string, ExecutableTool>();
  tools.set("read", createReadTool(cwd) as unknown as ExecutableTool);
  tools.set("write", createWriteTool(cwd) as unknown as ExecutableTool);
  tools.set("edit", createEditTool(cwd) as unknown as ExecutableTool);
  tools.set("bash", createBashTool(cwd) as unknown as ExecutableTool);
  tools.set("grep", createGrepTool(cwd) as unknown as ExecutableTool);
  tools.set("find", createFindTool(cwd) as unknown as ExecutableTool);
  tools.set("ls", createLsTool(cwd) as unknown as ExecutableTool);
  return tools;
}

export async function createPiNativeWorkerRuntime(
  cwd: string,
  _settings: Record<string, unknown> = {},
): Promise<PiNativeWorkerRuntime> {
  const previousCwd = process.cwd();
  let agentDir: string | undefined;
  let session:
    Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    process.chdir(cwd);
    agentDir = await mkdtemp(join(tmpdir(), "pi-ssh-remote-worker-"));
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        { name: "aft", factory: aftExtension, hidden: true },
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager,
      tools: [...new Set<string>([...PI_NATIVE_TOOLS, ...AFT_REMOTE_TOOLS])],
    }));
    await session.bindExtensions({ mode: "print" });
  } catch (error) {
    if (session) {
      await session.extensionRunner
        .emit({ type: "session_shutdown", reason: "quit" })
        .catch(() => {});
      session.dispose();
    }
    process.chdir(previousCwd);
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
    throw error;
  }
  const initializedSession = session;
  const initializedAgentDir = agentDir;

  const nativeTools = nativeToolMap(cwd);
  const tools = new Map<string, ExecutableTool>();
  for (const name of PI_NATIVE_TOOLS) {
    const tool =
      initializedSession.getToolDefinition(name) ?? nativeTools.get(name);
    if (tool) tools.set(name, tool);
  }
  for (const name of AFT_REMOTE_TOOLS) {
    const tool = initializedSession.getToolDefinition(name);
    if (tool) tools.set(name, tool);
  }

  const manifestTools: ToolManifest[] = [...tools].map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const manifest: ReadyMessage = {
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    toolRuntimeVersion: PI_TOOL_RUNTIME_VERSION,
    host: "pi",
    hostVersion: PI_VERSION,
    cwd,
    tools: manifestTools,
    capabilities: {
      artifacts: false,
      lsp: false,
      ast: true,
      eval: false,
      debug: false,
      sessionSpawns: "disabled",
      asyncBash: tools.has("bash_status"),
      remoteWorktrees: "disabled",
      aftHostRuntime: "@cortexkit/aft-pi@0.51.2",
    },
  };

  async function execute(
    request: ExecuteRequest,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> {
    const tool = tools.get(request.tool);
    if (!tool) throw new Error(`Unknown Pi tool: ${request.tool}`);
    const prepared =
      "prepareArguments" in tool && typeof tool.prepareArguments === "function"
        ? tool.prepareArguments(request.args)
        : request.args;
    return tool.execute(
      request.toolCallId,
      prepared,
      signal,
      onUpdate as never,
      initializedSession.extensionRunner.createContext(),
    );
  }

  async function close(): Promise<void> {
    try {
      await initializedSession.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      initializedSession.dispose();
      process.chdir(previousCwd);
      await rm(initializedAgentDir, { recursive: true, force: true });
    }
  }

  return { manifest, execute, close };
}
