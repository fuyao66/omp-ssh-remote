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

export const PI_REMOTE_RUNTIME_VERSION = "0.2.0" as const;
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
  activeTools: readonly string[];
  hostVersion?: string;
  pluginAdapters?: readonly PiPluginAdapter[];
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
      return {
        id: item.id,
        kind: item.kind,
        contractVersion: item.contractVersion,
        version: item.version,
      };
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
      actual.contractVersion !== expected.contractVersion
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
}

export async function resolvePiRuntimeAssembly(
  options: ResolvePiRuntimeAssemblyOptions,
): Promise<PiRuntimeAssembly> {
  const hostVersion = options.hostVersion ?? (await resolvePiHostVersion());
  const adapters = options.pluginAdapters ?? PI_PLUGIN_ADAPTERS;
  const active = new Set(options.activeTools);
  const declaredPluginTools = new Set(
    adapters.flatMap((adapter) => [...adapter.remoteTools]),
  );
  const activeSnapshots = options.tools.filter((tool) => active.has(tool.name));
  const detected = [] as Array<{
    adapter: PiPluginAdapter;
    version: string;
    tools: PiToolSnapshot[];
    order: number;
  }>;

  for (const adapter of adapters) {
    const owned = activeSnapshots.filter((tool) =>
      adapter.matchesSource(tool.sourceInfo),
    );
    if (owned.length === 0) continue;
    const unsupported = owned
      .map((tool) => tool.name)
      .filter((name) => !adapter.remoteTools.has(name));
    if (unsupported.length > 0) {
      throw new Error(
        `Pi plugin ${adapter.id} exposes active tools not admitted by its remote adapter: ${unsupported.join(", ")}`,
      );
    }
    detected.push({
      adapter,
      version: await resolvePackageVersionFromSources(
        adapter.packageName,
        owned,
      ),
      tools: owned,
      order: Math.min(...owned.map((tool) => activeSnapshots.indexOf(tool))),
    });
  }
  detected.sort((left, right) => left.order - right.order);

  const assemblyTools: PiAssemblyTool[] = [];
  for (const tool of activeSnapshots) {
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
          `Active Pi workspace tool ${tool.name} is owned by an unsupported extension`,
        );
      }
      owner = PI_CORE_COMPONENT_ID;
    } else if (declaredPluginTools.has(tool.name)) {
      throw new Error(
        `Active Pi plugin tool ${tool.name} has unsupported source provenance`,
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
      "The current Pi runtime exposes no supported active workspace tools",
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
    ({ adapter, version }) => ({
      id: adapter.id,
      kind: "plugin",
      contractVersion: adapter.contractVersion,
      version,
      displayName: adapter.displayName,
      tools: assemblyTools
        .filter((tool) => tool.owner === adapter.id)
        .map((tool) => tool.name),
    }),
  );
  const components = [host, ...plugins];
  const id = computePiAssemblyId(components, assemblyTools);
  const request: RuntimeAssemblyRequest = {
    id,
    components: components.map(({ id, kind, contractVersion, version }) => ({
      id,
      kind,
      contractVersion,
      version,
    })),
    tools: assemblyTools.map(({ name, owner }) => ({ name, owner })),
  };
  const pluginNames = plugins.map((plugin) => plugin.displayName);
  const displayName = ["Pi", ...pluginNames].join(" + ");
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
  return assembly;
}

export function computePiAssemblyId(
  components: readonly Pick<
    RuntimeAssemblyComponent,
    "id" | "kind" | "contractVersion"
  >[],
  tools: readonly Pick<PiAssemblyTool, "name" | "owner" | "parameters">[],
): string {
  return createHash("sha256")
    .update(
      stableJson({
        components: components.map(({ id, kind, contractVersion }) => ({
          id,
          kind,
          contractVersion,
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
