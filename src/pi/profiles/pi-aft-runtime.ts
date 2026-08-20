import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_AFT_PLUGIN_ID,
  PI_AFT_PROFILE,
  PI_AFT_NATIVE_TOOLS,
  PI_AFT_REMOTE_TOOLS,
} from "./pi-aft.ts";
import {
  PROTOCOL_VERSION,
  type ExecuteRequest,
  type ReadyMessage,
  type ToolManifest,
} from "../../protocol.ts";
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
export { PI_AFT_EXTENDED_TOOLS } from "./pi-aft.ts";

export interface PiAftWorkerRuntime {
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

export async function createPiAftWorkerRuntime(
  cwd: string,
  _settings: Record<string, unknown> = {},
): Promise<PiAftWorkerRuntime> {
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
      tools: [...PI_AFT_REMOTE_TOOLS],
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
  for (const name of PI_AFT_NATIVE_TOOLS) {
    const tool =
      initializedSession.getToolDefinition(name) ?? nativeTools.get(name);
    if (tool) tools.set(name, tool);
  }
  for (const name of PI_AFT_REMOTE_TOOLS) {
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
    toolRuntimeVersion: PI_AFT_PROFILE.handshake.runtimeVersion,
    host: "pi",
    hostVersion: PI_AFT_PROFILE.handshake.hostVersion,
    cwd,
    tools: manifestTools,
    capabilities: {
      profileId: PI_AFT_PROFILE.id,
      profileVersion: PI_AFT_PROFILE.version,
      artifacts: false,
      lsp: false,
      ast: true,
      eval: false,
      debug: false,
      sessionSpawns: "disabled",
      asyncBash: tools.has("bash_status"),
      remoteWorktrees: "disabled",
      aftHostRuntime: PI_AFT_PLUGIN_ID,
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
