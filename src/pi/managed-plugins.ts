import type { ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";

export interface ManagedWorkspacePlugin {
  id: string;
  sourcePath: string;
  version: string;
  tools(): readonly ToolDefinition[];
  config(): Record<string, unknown>;
}

const KEY = Symbol.for("pi-ssh-remote/managed-plugins");
const registryHost = globalThis as typeof globalThis & {
  [KEY]?: WeakMap<object, Map<string, ManagedWorkspacePlugin>>;
};
const registry = registryHost[KEY] ??= new WeakMap<object, Map<string, ManagedWorkspacePlugin>>();

export function managedPlugins(session: object): Map<string, ManagedWorkspacePlugin> {
  let plugins = registry.get(session);
  if (!plugins) {
    plugins = new Map();
    registry.set(session, plugins);
  }
  return plugins;
}

/** Provenance comes from the explicitly loaded managed component, not guessed tool names. */
export function managedToolSnapshots(session: object): ToolInfo[] {
  return [...managedPlugins(session).values()].flatMap((plugin) => plugin.tools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines,
    sourceInfo: {
      path: plugin.sourcePath,
      source: `npm:${plugin.id}`,
      scope: "user",
      origin: "top-level",
    } as ToolInfo["sourceInfo"],
  })));
}
