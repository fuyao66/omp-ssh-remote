import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  getPackageDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  type ExecuteRequest,
  type ReadyMessage,
  type RuntimeAssemblyComponent,
  type RuntimeAssemblyRequest,
  type ToolManifest,
} from "../protocol.ts";
import {
  computePiAssemblyId,
  PI_CORE_COMPONENT_ID,
  PI_CORE_CONTRACT_VERSION,
  PI_CORE_TOOL_NAMES,
  PI_REMOTE_RUNTIME_VERSION,
} from "./assembly.ts";
import {
  PI_WORKER_PLUGIN_ADAPTERS,
  type PiWorkerPluginAdapter,
} from "./worker-plugins.ts";

export interface PiWorkerRuntime {
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
> & {
  prepareArguments?(input: unknown): unknown;
};

const require = createRequire(import.meta.url);
const CORE_TOOL_SET = new Set<string>(PI_CORE_TOOL_NAMES);

function nativeToolMap(cwd: string): Map<string, ExecutableTool> {
  return new Map<string, ExecutableTool>([
    ["read", createReadTool(cwd) as unknown as ExecutableTool],
    ["write", createWriteTool(cwd) as unknown as ExecutableTool],
    ["edit", createEditTool(cwd) as unknown as ExecutableTool],
    ["bash", createBashTool(cwd) as unknown as ExecutableTool],
    ["grep", createGrepTool(cwd) as unknown as ExecutableTool],
    ["find", createFindTool(cwd) as unknown as ExecutableTool],
    ["ls", createLsTool(cwd) as unknown as ExecutableTool],
  ]);
}

async function packageVersionFromDirectory(
  start: string,
  packageName: string,
): Promise<string | undefined> {
  let current = start;
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(join(current, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      if (
        manifest.name === packageName &&
        typeof manifest.version === "string" &&
        manifest.version
      ) {
        return manifest.version;
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolvePackageVersion(
  packageName: string,
  bundledVersion: string | undefined,
): Promise<string> {
  if (bundledVersion) return bundledVersion;
  if (packageName === "@earendil-works/pi-coding-agent") {
    const version = await packageVersionFromDirectory(
      getPackageDir(),
      packageName,
    );
    if (version) return version;
  }
  try {
    const entryUrl = import.meta.resolve(packageName);
    const entry = entryUrl.startsWith("file:")
      ? fileURLToPath(entryUrl)
      : entryUrl;
    const version = await packageVersionFromDirectory(
      dirname(entry),
      packageName,
    );
    if (version) return version;
  } catch {}
  try {
    const entry = require.resolve(packageName);
    const version = await packageVersionFromDirectory(
      dirname(entry),
      packageName,
    );
    if (version) return version;
  } catch {}
  throw new Error(
    `Could not resolve worker package version for ${packageName}`,
  );
}

function resolveWorkerAssembly(request: RuntimeAssemblyRequest): {
  host: RuntimeAssemblyComponent;
  plugins: PiWorkerPluginAdapter[];
} {
  const [host, ...pluginComponents] = request.components;
  if (
    !host ||
    host.id !== PI_CORE_COMPONENT_ID ||
    host.kind !== "host" ||
    host.contractVersion !== PI_CORE_CONTRACT_VERSION
  ) {
    throw new Error(
      "Pi worker assembly is missing the supported Pi host contract",
    );
  }
  const componentIds = new Set<string>();
  const plugins: PiWorkerPluginAdapter[] = [];
  for (const component of request.components) {
    if (componentIds.has(component.id)) {
      throw new Error(`Duplicate Pi assembly component: ${component.id}`);
    }
    componentIds.add(component.id);
  }
  for (const component of pluginComponents) {
    const adapter = PI_WORKER_PLUGIN_ADAPTERS.find(
      (candidate) => candidate.id === component.id,
    );
    if (
      component.kind !== "plugin" ||
      !adapter ||
      adapter.contractVersion !== component.contractVersion
    ) {
      throw new Error(`Unsupported Pi plugin contract: ${component.id}`);
    }
    plugins.push(adapter);
  }

  const toolNames = new Set<string>();
  for (const tool of request.tools) {
    if (toolNames.has(tool.name)) {
      throw new Error(`Duplicate Pi assembly tool: ${tool.name}`);
    }
    toolNames.add(tool.name);
    if (tool.owner === PI_CORE_COMPONENT_ID) {
      if (!CORE_TOOL_SET.has(tool.name)) {
        throw new Error(`Unsupported Pi core tool: ${tool.name}`);
      }
      continue;
    }
    const plugin = plugins.find((candidate) => candidate.id === tool.owner);
    if (!plugin || !plugin.remoteTools.has(tool.name)) {
      throw new Error(
        `Pi assembly tool ${tool.name} has unsupported owner ${tool.owner}`,
      );
    }
  }
  return { host, plugins };
}

export async function createPiWorkerRuntime(
  cwd: string,
  assembly: RuntimeAssemblyRequest,
): Promise<PiWorkerRuntime> {
  const selected = resolveWorkerAssembly(assembly);
  const previousCwd = process.cwd();
  let agentDir: string | undefined;
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  let closed = false;

  const dispose = async (): Promise<void> => {
    try {
      if (session) {
        await session.extensionRunner
          .emit({ type: "session_shutdown", reason: "quit" })
          .catch(() => {});
        session.dispose();
        session = undefined;
      }
    } finally {
      process.chdir(previousCwd);
      if (agentDir) {
        await rm(agentDir, { recursive: true, force: true });
        agentDir = undefined;
      }
    }
  };

  try {
    process.chdir(cwd);
    if (selected.plugins.length > 0) {
      agentDir = await mkdtemp(join(tmpdir(), "pi-ssh-remote-worker-"));
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: selected.plugins.map((plugin) => ({
          name: plugin.id,
          factory: plugin.factory,
          hidden: true,
        })),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: assembly.tools.map((tool) => tool.name),
      }));
      await session.bindExtensions({ mode: "print" });
    }

    const nativeTools = nativeToolMap(cwd);
    const tools = new Map<string, ExecutableTool>();
    for (const requested of assembly.tools) {
      const tool =
        requested.owner === PI_CORE_COMPONENT_ID
          ? nativeTools.get(requested.name)
          : session?.getToolDefinition(requested.name);
      if (!tool) {
        throw new Error(
          `Pi component ${requested.owner} did not provide tool ${requested.name}`,
        );
      }
      tools.set(requested.name, tool as ExecutableTool);
    }

    const coreVersion = await resolvePackageVersion(
      "@earendil-works/pi-coding-agent",
      process.env.PI_BUNDLED_HOST_VERSION,
    );
    const remoteComponents: RuntimeAssemblyComponent[] = [
      { ...selected.host, version: coreVersion },
    ];
    for (const plugin of selected.plugins) {
      remoteComponents.push({
        id: plugin.id,
        kind: "plugin",
        contractVersion: plugin.contractVersion,
        version: await resolvePackageVersion(
          plugin.packageName,
          plugin.bundledVersion,
        ),
      });
    }

    const manifestTools: ToolManifest[] = [...tools].map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const owners = new Map(
      assembly.tools.map((tool) => [tool.name, tool.owner]),
    );
    const remoteAssemblyId = computePiAssemblyId(
      remoteComponents,
      manifestTools.map((tool) => ({
        name: tool.name,
        owner: owners.get(tool.name)!,
        parameters: tool.parameters,
      })),
    );
    const manifest: ReadyMessage = {
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      toolRuntimeVersion: PI_REMOTE_RUNTIME_VERSION,
      host: "pi",
      hostVersion: coreVersion,
      cwd,
      tools: manifestTools,
      capabilities: {
        assembly: {
          id: remoteAssemblyId,
          components: remoteComponents,
          tools: assembly.tools,
        },
        artifacts: false,
        lsp: false,
        ast: tools.has("ast_grep_search"),
        eval: false,
        debug: false,
        sessionSpawns: "disabled",
        asyncBash: tools.has("bash_status"),
        remoteWorktrees: "disabled",
      },
    };

    async function execute(
      request: ExecuteRequest,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
    ): Promise<unknown> {
      const tool = tools.get(request.tool);
      if (!tool) throw new Error(`Unknown Pi tool: ${request.tool}`);
      const prepared = tool.prepareArguments
        ? tool.prepareArguments(request.args)
        : request.args;
      return tool.execute(
        request.toolCallId,
        prepared as never,
        signal,
        onUpdate as never,
        session?.extensionRunner.createContext() as never,
      );
    }

    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      await dispose();
    }

    return { manifest, execute, close };
  } catch (error) {
    await dispose();
    throw error;
  }
}
