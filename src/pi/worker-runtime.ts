import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
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
  type ToolInfo,
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
  executeWorkspaceTool,
  type WorkspaceExecutableTool,
  type WorkspacePluginHandle,
  type WorkspaceToolRunner,
  WORKSPACE_HOOKS,
} from "./workspace-plugin.ts";
import {
  findWorkerPluginAdapter,
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

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
type ExecutableTool = Pick<
  ToolDefinition,
  "description" | "parameters" | "execute"
> & WorkspaceExecutableTool;

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
    } catch {
      // keep walking
    }
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
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const version = await packageVersionFromDirectory(dirname(manifestPath), packageName);
    if (version) return version;
  } catch {}
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
  } catch {
    // fall through
  }
  try {
    const entry = require.resolve(packageName);
    const version = await packageVersionFromDirectory(
      dirname(entry),
      packageName,
    );
    if (version) return version;
  } catch {
    // fall through
  }
  throw new Error(
    `Could not resolve worker package version for ${packageName}`,
  );
}

type ResolvedWorkerAssembly = {
  host: RuntimeAssemblyComponent;
  plugins: Array<{
    component: RuntimeAssemblyComponent;
    adapter: PiWorkerPluginAdapter;
  }>;
};

function resolveWorkerAssembly(
  request: RuntimeAssemblyRequest,
): ResolvedWorkerAssembly {
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
  for (const component of request.components) {
    if (componentIds.has(component.id)) {
      throw new Error(`Duplicate Pi assembly component: ${component.id}`);
    }
    componentIds.add(component.id);
  }

  const plugins: ResolvedWorkerAssembly["plugins"] = [];
  for (const component of pluginComponents) {
    const adapter = findWorkerPluginAdapter(component.id);
    if (
      component.kind !== "plugin" ||
      !adapter ||
      adapter.contractVersion !== component.contractVersion
    ) {
      throw new Error(`Unsupported Pi plugin contract: ${component.id}`);
    }
    if (component.config !== undefined) {
      if (!adapter.validateConfig) {
        throw new Error(`Pi worker plugin ${component.id} does not admit configuration`);
      }
      adapter.validateConfig(component.config);
    }
    plugins.push({ component, adapter });
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
    const plugin = plugins.find(
      (candidate) => candidate.adapter.id === tool.owner,
    );
    if (!plugin || !plugin.adapter.remoteTools.has(tool.name)) {
      throw new Error(
        `Pi assembly tool ${tool.name} has unsupported owner ${tool.owner}`,
      );
    }
  }

  return { host, plugins };
}

function resolveActualOwner(
  toolName: string,
  requestedOwner: string,
  toolInfos: ReadonlyMap<string, ToolInfo>,
  plugins: ResolvedWorkerAssembly["plugins"],
): string {
  if (requestedOwner === PI_CORE_COMPONENT_ID) {
    const info = toolInfos.get(toolName);
    if (info) {
      const pluginOwners = plugins.filter(({ adapter }) =>
        adapter.matchesSource(info.sourceInfo),
      );
      if (pluginOwners.length > 0) {
        throw new Error(
          `Pi tool ${toolName} was requested as core-owned but source matches plugin ${pluginOwners.map((item) => item.adapter.id).join(", ")}`,
        );
      }
    }
    return PI_CORE_COMPONENT_ID;
  }

  const plugin = plugins.find(
    (candidate) => candidate.adapter.id === requestedOwner,
  );
  if (!plugin) {
    throw new Error(`Pi tool ${toolName} requested unknown owner ${requestedOwner}`);
  }

  const info = toolInfos.get(toolName);
  if (!info) {
    throw new Error(`Pi plugin tool ${toolName} has no verified runtime source`);
  }

  if (!plugin.adapter.matchesSource(info.sourceInfo)) {
    const actual = plugins.find(({ adapter }) =>
      adapter.matchesSource(info.sourceInfo),
    );
    throw new Error(
      `Pi tool ${toolName} requested owner ${requestedOwner} but actual source owner is ${actual?.adapter.id ?? "unknown"} (${JSON.stringify(info.sourceInfo)})`,
    );
  }

  const conflicts = plugins.filter(
    ({ adapter }) =>
      adapter.id !== plugin.adapter.id &&
      adapter.matchesSource(info.sourceInfo),
  );
  if (conflicts.length > 0) {
    throw new Error(
      `Pi tool ${toolName} has ambiguous plugin provenance: ${[plugin.adapter.id, ...conflicts.map((item) => item.adapter.id)].join(", ")}`,
    );
  }

  return plugin.adapter.id;
}

export async function createPiWorkerRuntime(
  cwd: string,
  assembly: RuntimeAssemblyRequest,
): Promise<PiWorkerRuntime> {
  const selected = resolveWorkerAssembly(assembly);
  const previousCwd = process.cwd();
  const previousAgentDir = process.env[PI_AGENT_DIR_ENV];
  let agentDir: string | undefined;
  let session: AgentSession | undefined;
  let closed = false;
  const handles = new Map<string, WorkspacePluginHandle>();

  const dispose = async (): Promise<void> => {
    try {
      if (session) {
        await session.extensionRunner
          .emit({ type: "session_shutdown", reason: "quit" })
          .catch(() => {});
      }
      await Promise.allSettled(
        [...handles.values()].map(async (handle) => {
          try {
            await handle.suspend?.();
          } finally {
            await handle.shutdown();
          }
        }),
      );
      handles.clear();
      if (session) {
        session.dispose();
        session = undefined;
      }
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
      else process.env[PI_AGENT_DIR_ENV] = previousAgentDir;
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
      process.env[PI_AGENT_DIR_ENV] = agentDir;
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const extensionFactories = selected.plugins.map(
        ({ component, adapter }) => ({
          name: adapter.id,
          factory: adapter.createFactory({
            config: component.config,
            onHandle: (handle) => {
              if (handles.has(adapter.id)) {
                throw new Error(`Pi worker plugin ${adapter.id} registered multiple handles`);
              }
              handles.set(adapter.id, handle);
            },
          }),
          hidden: true,
        }),
      );
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories,
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
    const toolInfos = new Map<string, ToolInfo>(
      (session?.getAllTools() ?? []).map((tool) => [tool.name, tool]),
    );
    const tools = new Map<string, ExecutableTool>();
    const actualOwners = new Map<string, string>();

    for (const requested of assembly.tools) {
      const owner = resolveActualOwner(
        requested.name,
        requested.owner,
        toolInfos,
        selected.plugins,
      );
      actualOwners.set(requested.name, owner);

      const tool =
        owner === PI_CORE_COMPONENT_ID
          ? nativeTools.get(requested.name)
          : session?.getToolDefinition(requested.name);
      if (!tool) {
        throw new Error(
          `Pi component ${owner} did not provide tool ${requested.name}`,
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
    for (const { component, adapter } of selected.plugins) {
      const handle = handles.get(adapter.id);
      remoteComponents.push({
        id: adapter.id,
        kind: "plugin",
        contractVersion: adapter.contractVersion,
        version: await resolvePackageVersion(
          adapter.packageName,
          adapter.bundledVersion,
        ),
        ...(handle?.getConfigSnapshot
          ? { config: handle.getConfigSnapshot() }
          : component.config ? { config: component.config } : {}),
      });
    }

    const manifestTools: ToolManifest[] = [...tools].map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const ownershipTools = manifestTools.map((tool) => ({
      name: tool.name,
      owner: actualOwners.get(tool.name)!,
      parameters: tool.parameters,
    }));
    const remoteAssemblyId = computePiAssemblyId(
      remoteComponents,
      ownershipTools,
    );

    const workspaceServices: Record<string, string[]> = {};
    for (const { adapter } of selected.plugins) {
      if (!adapter.workspaceServices?.length) continue;
      if (!handles.has(adapter.id)) {
        throw new Error(`Pi worker plugin ${adapter.id} declared workspace services without registering a handle`);
      }
      workspaceServices[adapter.id] = [...adapter.workspaceServices];
    }

    const workspaceHooks = [...WORKSPACE_HOOKS];
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
          tools: ownershipTools.map(({ name, owner }) => ({ name, owner })),
        },
        ...(Object.keys(workspaceServices).length > 0
          ? { workspaceServices }
          : {}),
        artifacts: false,
        lsp: false,
        workspaceHooks,
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
      const servicePrefix = "/service/";
      const serviceIndex = request.tool.indexOf(servicePrefix);
      if (serviceIndex > 0) {
        const pluginId = request.tool.slice(0, serviceIndex);
        const serviceName = request.tool.slice(serviceIndex + servicePrefix.length);
        const adapter = selected.plugins.find(({ adapter }) => adapter.id === pluginId)?.adapter;
        const handle = handles.get(pluginId);
        if (!adapter?.workspaceServices?.includes(serviceName) || !handle) {
          throw new Error(`Unadmitted Pi workspace service: ${request.tool}`);
        }
        return handle.service(serviceName, request.args, signal);
      }

      const tool = tools.get(request.tool);
      if (!tool) throw new Error(`Unknown Pi tool: ${request.tool}`);
      return executeWorkspaceTool({
        runner: session?.extensionRunner as unknown as WorkspaceToolRunner,
        tool,
        toolName: request.tool,
        toolCallId: request.toolCallId,
        args: request.args,
        signal,
        onUpdate,
      });
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
