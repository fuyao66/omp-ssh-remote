import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, type ToolInfo } from "@earendil-works/pi-coding-agent";
import type {
  ReadyMessage,
  RuntimeAssemblyComponent,
  RuntimeAssemblyRequest,
  ToolManifest,
} from "../protocol.ts";
import type {
  RemoteCompanionArtifact,
  RemoteRuntimeHandshake,
  RemoteWorkerBundle,
} from "../runtime-contract.ts";
import { PI_PLUGIN_ADAPTERS } from "./plugins/index.ts";
import { WORKSPACE_HOOKS } from "./workspace-plugin.ts";

export const PI_REMOTE_RUNTIME_VERSION = "0.3.0" as const;
export const PI_CORE_COMPONENT_ID = "pi-core" as const;
export const PI_CORE_CONTRACT_VERSION = "1" as const;
export const PI_CORE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

const PI_CORE_TOOL_SET = new Set<string>(PI_CORE_TOOL_NAMES);

export type PiToolSnapshot = Pick<
  ToolInfo,
  "name" | "description" | "parameters" | "sourceInfo"
>;

export interface PiPluginAdapter {
  id: string;
  packageName: string;
  displayName: string;
  contractVersion: string;
  remoteTools: ReadonlySet<string>;
  companionArtifacts: readonly RemoteCompanionArtifact[];
  matchesSource(sourceInfo: ToolInfo["sourceInfo"]): boolean;
  resolveConfig?(input: {
    pluginId: string;
    captured?: Record<string, unknown>;
    tools: readonly PiToolSnapshot[];
  }): Record<string, unknown> | undefined;
  validateConfig?(config: Record<string, unknown>): void;
  /** Exact capability names advertised under ready.capabilities.workspaceServices[id]. */
  workspaceServices?: readonly string[];
}

/** Explicitly loaded workspace components, including plugins that only install hooks. */
export interface PiManagedPluginSnapshot {
  id: string;
  sourcePath: string;
  version: string;
  config: Record<string, unknown>;
}

export interface PiAssemblyTool extends ToolManifest {
  owner: string;
  parameters: unknown;
}

export interface PiAssemblyComponent extends RuntimeAssemblyComponent {
  displayName: string;
  tools: readonly string[];
}

export interface PiRuntimeAssembly {
  id: string;
  displayName: string;
  host: PiAssemblyComponent;
  plugins: readonly PiAssemblyComponent[];
  components: readonly PiAssemblyComponent[];
  tools: readonly PiAssemblyTool[];
  request: RuntimeAssemblyRequest;
  handshake: RemoteRuntimeHandshake;
  workerBundle: RemoteWorkerBundle;
  knownWorkspaceTools: ReadonlySet<string>;
  executionRuntime: {
    local: string;
    remote: string;
  };
}

export interface ResolvePiRuntimeAssemblyOptions {
  tools: readonly PiToolSnapshot[];
  hostVersion?: string;
  pluginAdapters?: readonly PiPluginAdapter[];
  /** Host-captured effective plugin configs keyed by plugin id. */
  pluginConfigs?: Readonly<Record<string, Record<string, unknown>>>;
  managedPlugins?: readonly PiManagedPluginSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function isObjectSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "object";
}

function isBuiltinTool(tool: PiToolSnapshot): boolean {
  const source = tool.sourceInfo.source.toLowerCase();
  const path = tool.sourceInfo.path.toLowerCase();
  return source === "builtin" || path.startsWith("<builtin");
}

async function readPackageVersion(
  packageDir: string,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

async function sourceDirectory(path: string): Promise<string | undefined> {
  if (!path || path.startsWith("<")) return undefined;
  const absolute = resolve(path);
  try {
    return (await stat(absolute)).isDirectory() ? absolute : dirname(absolute);
  } catch {
    return dirname(absolute);
  }
}

async function resolvePackageVersionFromSources(
  packageName: string,
  tools: readonly PiToolSnapshot[],
): Promise<string> {
  for (const tool of tools) {
    const version = await packageVersionFromEntry(
      tool.sourceInfo.path,
      packageName,
    );
    if (version) return version;
  }
  try {
    const resolved = import.meta.resolve(packageName);
    const version = await packageVersionFromEntry(
      resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved,
      packageName,
    );
    if (version) return version;
  } catch {}
  throw new Error(
    `Could not resolve the installed version of detected Pi plugin ${packageName}`,
  );
}

export async function resolvePiHostVersion(): Promise<string> {
  const version = await readPackageVersion(getPackageDir());
  if (!version) {
    throw new Error("Could not resolve the current Pi Agent package version");
  }
  return version;
}

function parseReadyAssembly(ready: ReadyMessage): RuntimeAssemblyRequest {
  const value = ready.capabilities?.assembly;
  if (
    !isRecord(value) ||
    !Array.isArray(value.components) ||
    !Array.isArray(value.tools)
  ) {
    throw new Error("Remote Pi runtime did not report its runtime assembly");
  }
  const components: RuntimeAssemblyRequest["components"] = value.components.map(
    (item) => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        (item.kind !== "host" && item.kind !== "plugin") ||
        typeof item.contractVersion !== "string" ||
        typeof item.version !== "string"
      ) {
        throw new Error(
          "Remote Pi runtime reported an invalid assembly component",
        );
      }
      const component: RuntimeAssemblyRequest["components"][number] = {
        id: item.id,
        kind: item.kind,
        contractVersion: item.contractVersion,
        version: item.version,
      };
      if ("config" in item && item.config !== undefined) {
        if (!isRecord(item.config) || Array.isArray(item.config)) {
          throw new Error(
            `Remote Pi runtime reported invalid config for ${item.id}`,
          );
        }
        component.config = item.config;
      }
      return component;
    },
  );
  const tools = value.tools.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.owner !== "string"
    ) {
      throw new Error("Remote Pi runtime reported an invalid tool owner");
    }
    return { name: item.name, owner: item.owner };
  });
  if (typeof value.id !== "string") {
    throw new Error("Remote Pi runtime reported an invalid assembly ID");
  }
  return { id: value.id, components, tools };
}

export function validatePiReadyMessage(
  assembly: Pick<PiRuntimeAssembly, "id" | "request" | "tools">,
  ready: ReadyMessage,
): void {
  if (
    ready.host !== "pi" ||
    typeof ready.hostVersion !== "string" ||
    !ready.hostVersion ||
    ready.toolRuntimeVersion !== PI_REMOTE_RUNTIME_VERSION
  ) {
    throw new Error(
      `Remote Pi runtime identity mismatch: host=${ready.hostVersion}, runtime=${ready.toolRuntimeVersion}`,
    );
  }

  const remoteAssembly = parseReadyAssembly(ready);
  if (remoteAssembly.id !== assembly.id) {
    throw new Error(
      `Remote Pi assembly mismatch: expected ${assembly.id}, got ${remoteAssembly.id}`,
    );
  }
  if (remoteAssembly.components.length !== assembly.request.components.length) {
    throw new Error("Remote Pi assembly component count mismatch");
  }
  for (let index = 0; index < assembly.request.components.length; index++) {
    const expected = assembly.request.components[index];
    const actual = remoteAssembly.components[index];
    if (
      actual.id !== expected.id ||
      actual.kind !== expected.kind ||
      actual.contractVersion !== expected.contractVersion ||
      stableJson(actual.config) !== stableJson(expected.config)
    ) {
      throw new Error(
        `Remote Pi component contract mismatch at ${expected.id}`,
      );
    }
  }
  if (remoteAssembly.components[0]?.version !== ready.hostVersion) {
    throw new Error("Remote Pi host version and assembly manifest disagree");
  }
  if (stableJson(remoteAssembly.tools) !== stableJson(assembly.request.tools)) {
    throw new Error(
      "Remote Pi tool ownership does not match the requested assembly",
    );
  }

  const expectedTools = new Map(
    assembly.tools.map((tool) => [tool.name, tool]),
  );
  const seen = new Set<string>();
  for (const tool of ready.tools) {
    const expected = expectedTools.get(tool.name);
    if (!expected) {
      throw new Error(
        `Remote Pi runtime exposed unsupported tool: ${tool.name}`,
      );
    }
    if (seen.has(tool.name)) {
      throw new Error(`Remote Pi runtime exposed duplicate tool: ${tool.name}`);
    }
    if (!isObjectSchema(tool.parameters)) {
      throw new Error(
        `Remote Pi tool ${tool.name} has an invalid parameter schema`,
      );
    }
    if (stableJson(tool.parameters) !== stableJson(expected.parameters)) {
      throw new Error(
        `Remote Pi tool ${tool.name} schema is incompatible with the local tool`,
      );
    }
    seen.add(tool.name);
  }
  const missing = assembly.tools
    .map((tool) => tool.name)
    .filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Remote Pi runtime is missing tools: ${missing.join(", ")}`,
    );
  }

  if (stableJson(ready.capabilities?.workspaceHooks) !== stableJson(WORKSPACE_HOOKS)) {
    throw new Error("Remote Pi workspace hook lifecycle is incompatible");
  }
  validateReadyWorkspaceServices(assembly.request.components, ready);
}

function validateReadyWorkspaceServices(
  components: readonly RuntimeAssemblyComponent[],
  ready: ReadyMessage,
): void {
  const servicesValue = ready.capabilities?.workspaceServices;
  const services =
    servicesValue === undefined
      ? undefined
      : isRecord(servicesValue)
        ? servicesValue
        : null;
  if (servicesValue !== undefined && services === null) {
    throw new Error(
      "Remote Pi runtime reported invalid workspaceServices capabilities",
    );
  }

  const expected = new Map<string, readonly string[]>();
  for (const component of components) {
    if (component.kind !== "plugin") continue;
    const adapter = PI_PLUGIN_ADAPTERS.find(
      (candidate) => candidate.id === component.id,
    );
    if (adapter?.workspaceServices && adapter.workspaceServices.length > 0) {
      expected.set(adapter.id, adapter.workspaceServices);
    }
  }

  for (const [pluginId, names] of expected) {
    const actual = services?.[pluginId];
    if (!Array.isArray(actual) || !actual.every((item) => typeof item === "string")) {
      throw new Error(
        `Remote Pi runtime is missing workspaceServices for ${pluginId}`,
      );
    }
    if (stableJson([...actual].sort()) !== stableJson([...names].sort())) {
      throw new Error(
        `Remote Pi workspaceServices for ${pluginId} must be exactly ${names.join(", ")}`,
      );
    }
  }

  if (services) {
    for (const pluginId of Object.keys(services)) {
      if (!expected.has(pluginId)) {
        throw new Error(
          `Remote Pi runtime exposed unexpected workspaceServices for ${pluginId}`,
        );
      }
    }
  }
}

export async function resolvePiRuntimeAssembly(
  options: ResolvePiRuntimeAssemblyOptions,
): Promise<PiRuntimeAssembly> {
  const hostVersion = options.hostVersion ?? (await resolvePiHostVersion());
  const adapters = options.pluginAdapters ?? PI_PLUGIN_ADAPTERS;
  const declaredPluginTools = new Set(
    adapters.flatMap((adapter) => [...adapter.remoteTools]),
  );
  const snapshots = options.tools;
  const detected = [] as Array<{
    adapter: PiPluginAdapter;
    version: string;
    tools: PiToolSnapshot[];
    order: number;
    config?: Record<string, unknown>;
  }>;
  const managed = new Map<string, PiManagedPluginSnapshot>();
  for (const plugin of options.managedPlugins ?? []) {
    if (managed.has(plugin.id)) throw new Error(`Duplicate managed Pi plugin: ${plugin.id}`);
    const adapter = adapters.find((candidate) => candidate.id === plugin.id);
    if (!adapter) throw new Error(`Unsupported managed Pi workspace plugin: ${plugin.id}`);
    const version = await packageVersionFromEntry(plugin.sourcePath, adapter.packageName);
    if (!version || version !== plugin.version) {
      throw new Error(`Managed Pi plugin package provenance mismatch: ${plugin.id}`);
    }
    managed.set(plugin.id, plugin);
  }

  for (const adapter of adapters) {
    const owned = snapshots.filter((tool) =>
      adapter.matchesSource(tool.sourceInfo),
    );
    const declaration = managed.get(adapter.id);
    if (owned.length === 0 && !declaration) continue;
    const unsupported = owned
      .map((tool) => tool.name)
      .filter((name) => !adapter.remoteTools.has(name));
    if (unsupported.length > 0) {
      throw new Error(
        `Pi plugin ${adapter.id} exposes tools not admitted by its remote adapter: ${unsupported.join(", ")}`,
      );
    }
    const captured = declaration?.config ?? options.pluginConfigs?.[adapter.id];
    const config = adapter.resolveConfig?.({
      pluginId: adapter.id,
      captured,
      tools: owned,
    });
    if (config !== undefined) {
      adapter.validateConfig?.(config);
    }
    detected.push({
      adapter,
      version: declaration?.version ?? await resolvePackageVersionFromSources(
        adapter.packageName,
        owned,
      ),
      tools: owned,
      order: owned.length > 0
        ? Math.min(...owned.map((tool) => snapshots.indexOf(tool)))
        : snapshots.length + [...managed.keys()].indexOf(adapter.id),
      ...(config === undefined ? {} : { config }),
    });
  }
  detected.sort((left, right) => left.order - right.order);

  const assemblyTools: PiAssemblyTool[] = [];
  for (const tool of snapshots) {
    const pluginOwners = detected.filter(({ adapter }) =>
      adapter.matchesSource(tool.sourceInfo),
    );
    if (pluginOwners.length > 1) {
      throw new Error(
        `Multiple Pi plugin adapters claim tool ${tool.name}: ${pluginOwners.map(({ adapter }) => adapter.id).join(", ")}`,
      );
    }
    const pluginOwner = pluginOwners[0];
    let owner: string | undefined;
    if (pluginOwner) {
      if (pluginOwner.adapter.remoteTools.has(tool.name)) {
        owner = pluginOwner.adapter.id;
      }
    } else if (PI_CORE_TOOL_SET.has(tool.name)) {
      if (!isBuiltinTool(tool)) {
        throw new Error(
          `Pi workspace tool ${tool.name} is owned by an unsupported extension`,
        );
      }
      owner = PI_CORE_COMPONENT_ID;
    } else if (declaredPluginTools.has(tool.name)) {
      throw new Error(
        `Pi plugin tool ${tool.name} has unsupported source provenance`,
      );
    }
    if (!owner) continue;
    if (!isObjectSchema(tool.parameters)) {
      throw new Error(
        `Local Pi tool ${tool.name} has an invalid parameter schema`,
      );
    }
    assemblyTools.push({
      name: tool.name,
      owner,
      description: tool.description,
      parameters: tool.parameters,
    });
  }

  if (assemblyTools.length === 0) {
    throw new Error(
      "The current Pi runtime exposes no supported workspace tools",
    );
  }
  assemblyTools.sort((left, right) => left.name.localeCompare(right.name));

  const host: PiAssemblyComponent = {
    id: PI_CORE_COMPONENT_ID,
    kind: "host",
    contractVersion: PI_CORE_CONTRACT_VERSION,
    version: hostVersion,
    displayName: "Pi Agent",
    tools: assemblyTools
      .filter((tool) => tool.owner === PI_CORE_COMPONENT_ID)
      .map((tool) => tool.name),
  };
  const plugins: PiAssemblyComponent[] = detected.map(
    ({ adapter, version, config }) => ({
      id: adapter.id,
      kind: "plugin" as const,
      contractVersion: adapter.contractVersion,
      version,
      displayName: adapter.displayName,
      tools: assemblyTools
        .filter((tool) => tool.owner === adapter.id)
        .map((tool) => tool.name),
      ...(config === undefined ? {} : { config }),
    }),
  );
  const components = [host, ...plugins];
  const id = computePiAssemblyId(components, assemblyTools);
  const request: RuntimeAssemblyRequest = {
    id,
    components: components.map(
      ({ id, kind, contractVersion, version, config }) => ({
        id,
        kind,
        contractVersion,
        version,
        ...(config === undefined ? {} : { config }),
      }),
    ),
    tools: assemblyTools.map(({ name, owner }) => ({ name, owner })),
  };
  const displayName = assemblyDisplayName(plugins);
  const assembly: PiRuntimeAssembly = {
    id,
    displayName,
    host,
    plugins,
    components,
    tools: assemblyTools,
    request,
    handshake: {
      host: "pi",
      hostVersion,
      runtimeVersion: PI_REMOTE_RUNTIME_VERSION,
      requestedTools: assemblyTools.map((tool) => tool.name),
      assembly: request,
      validateReady: (ready) => validatePiReadyMessage(assembly, ready),
    },
    workerBundle: {
      cacheNamespace: "pi",
      companionArtifacts: detected.flatMap(
        ({ adapter }) => adapter.companionArtifacts,
      ),
    },
    knownWorkspaceTools: new Set(assemblyTools.map((tool) => tool.name)),
    executionRuntime: {
      local: `local ${displayName} runtime`,
      remote: `model-free remote ${displayName} runtime`,
    },
  };
  return assembly;
}

function assemblyDisplayName(
  plugins: readonly Pick<PiAssemblyComponent, "displayName">[],
): string {
  const names = plugins.map((plugin) => plugin.displayName);
  return names.length === 0
    ? "Pi core"
    : `Pi core with plugin adapters: ${names.join(", ")}`;
}

export function restorePiRuntimeAssembly(
  request: RuntimeAssemblyRequest,
  tools: readonly PiAssemblyTool[],
): PiRuntimeAssembly {
  const host = request.components[0];
  if (
    !host ||
    host.id !== PI_CORE_COMPONENT_ID ||
    host.kind !== "host" ||
    host.contractVersion !== PI_CORE_CONTRACT_VERSION
  ) {
    throw new Error(
      "Inherited Pi assembly is missing the supported Pi host contract",
    );
  }
  const seenComponents = new Set<string>();
  const adapters = new Map<string, PiPluginAdapter>();
  const plugins: PiAssemblyComponent[] = [];
  for (const [index, component] of request.components.entries()) {
    if (seenComponents.has(component.id)) {
      throw new Error(
        `Duplicate inherited Pi assembly component: ${component.id}`,
      );
    }
    seenComponents.add(component.id);
    if (index === 0) continue;
    if (component.kind !== "plugin") {
      throw new Error(
        `Unsupported inherited Pi assembly component: ${component.id}`,
      );
    }
    const adapter = PI_PLUGIN_ADAPTERS.find(
      (candidate) => candidate.id === component.id,
    );
    if (!adapter || adapter.contractVersion !== component.contractVersion) {
      throw new Error(
        `Unsupported inherited Pi plugin contract: ${component.id}`,
      );
    }
    adapters.set(component.id, adapter);
    if (component.config !== undefined) {
      if (!adapter.validateConfig) {
        throw new Error(
          `Inherited Pi plugin ${component.id} does not admit configuration`,
        );
      }
      adapter.validateConfig(component.config);
    }
    plugins.push({
      id: component.id,
      kind: component.kind,
      contractVersion: component.contractVersion,
      version: component.version,
      displayName: adapter.displayName,
      tools: request.tools
        .filter((tool) => tool.owner === component.id)
        .map((tool) => tool.name),
      ...(component.config === undefined ? {} : { config: component.config }),
    });
  }
  const expectedOwners = new Map(
    request.tools.map((tool) => [tool.name, tool.owner]),
  );
  for (const [name, owner] of expectedOwners) {
    if (owner !== PI_CORE_COMPONENT_ID && !adapters.has(owner)) {
      throw new Error(`Inherited Pi tool has unsupported owner: ${name}`);
    }
    if (owner === PI_CORE_COMPONENT_ID && !PI_CORE_TOOL_SET.has(name)) {
      throw new Error(
        `Inherited Pi tool is not a supported Pi core tool: ${name}`,
      );
    }
    if (
      owner !== PI_CORE_COMPONENT_ID &&
      !adapters.get(owner)?.remoteTools.has(name)
    ) {
      throw new Error(
        `Inherited Pi tool is not admitted by its plugin adapter: ${name}`,
      );
    }
  }
  const restoredTools = tools.map((tool) => {
    const expectedOwner = expectedOwners.get(tool.name);
    if (!expectedOwner || expectedOwner !== tool.owner) {
      throw new Error(`Inherited Pi tool owner mismatch: ${tool.name}`);
    }
    if (!isObjectSchema(tool.parameters)) {
      throw new Error(
        `Inherited Pi tool ${tool.name} has an invalid parameter schema`,
      );
    }
    return { ...tool, parameters: tool.parameters };
  });
  if (
    restoredTools.length !== request.tools.length ||
    expectedOwners.size !== restoredTools.length
  ) {
    throw new Error("Inherited Pi assembly tools are incomplete or duplicated");
  }
  const restoredId = computePiAssemblyId(request.components, restoredTools);
  if (restoredId !== request.id) {
    throw new Error(
      `Inherited Pi assembly contract does not match its ID: expected ${request.id}, got ${restoredId}`,
    );
  }
  const components: PiAssemblyComponent[] = [
    {
      id: host.id,
      kind: host.kind,
      contractVersion: host.contractVersion,
      version: host.version,
      displayName: "Pi Agent",
      tools: request.tools
        .filter((tool) => tool.owner === PI_CORE_COMPONENT_ID)
        .map((tool) => tool.name),
      ...(host.config === undefined ? {} : { config: host.config }),
    },
    ...plugins,
  ];
  const displayName = assemblyDisplayName(plugins);
  const restoredRequest: RuntimeAssemblyRequest = {
    id: request.id,
    components: request.components.map((component) => ({ ...component })),
    tools: request.tools.map((tool) => ({ ...tool })),
  };
  const assembly: PiRuntimeAssembly = {
    id: request.id,
    displayName,
    host: components[0]!,
    plugins,
    components,
    tools: restoredTools,
    request: restoredRequest,
    handshake: {
      host: "pi",
      hostVersion: host.version,
      runtimeVersion: PI_REMOTE_RUNTIME_VERSION,
      requestedTools: restoredTools.map((tool) => tool.name),
      assembly: restoredRequest,
      validateReady: (ready) => validatePiReadyMessage(assembly, ready),
    },
    workerBundle: {
      cacheNamespace: "pi",
      companionArtifacts: plugins.flatMap(
        (plugin) => adapters.get(plugin.id)?.companionArtifacts ?? [],
      ),
    },
    knownWorkspaceTools: new Set(restoredTools.map((tool) => tool.name)),
    executionRuntime: {
      local: `local ${displayName} runtime`,
      remote: `model-free remote ${displayName} runtime`,
    },
  };
  return assembly;
}

export function computePiAssemblyId(
  components: readonly Pick<
    RuntimeAssemblyComponent,
    "id" | "kind" | "contractVersion" | "config"
  >[],
  tools: readonly Pick<PiAssemblyTool, "name" | "owner" | "parameters">[],
): string {
  return createHash("sha256")
    .update(
      stableJson({
        components: components.map(({ id, kind, contractVersion, config }) => ({
          id,
          kind,
          contractVersion,
          ...(config === undefined ? {} : { config }),
        })),
        tools: tools.map(({ name, owner, parameters }) => ({
          name,
          owner,
          parameters,
        })),
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

async function packageVersionFromEntry(
  entry: string,
  packageName: string,
): Promise<string | undefined> {
  let current = await sourceDirectory(entry);
  while (current) {
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
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}
