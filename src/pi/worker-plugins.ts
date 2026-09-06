import type {
  ExtensionFactory,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { WorkspacePluginHandle } from "./workspace-plugin.ts";
import { PI_WORKER_PLUGIN_ADAPTERS } from "./worker-plugin-registry.ts";

export interface PiWorkerPluginAdapter {
  id: string;
  packageName: string;
  contractVersion: string;
  remoteTools: ReadonlySet<string>;
  matchesSource(sourceInfo: ToolInfo["sourceInfo"]): boolean;
  validateConfig?(config: Record<string, unknown>): void;
  workspaceServices?: readonly string[];
  createFactory(input: {
    config?: Record<string, unknown>;
    onHandle?: (handle: WorkspacePluginHandle) => void;
  }): ExtensionFactory;
  bundledVersion?: string;
  companionArtifactIds?: readonly string[];
  optional?: boolean;
}

export { PI_WORKER_PLUGIN_ADAPTERS };

export function findWorkerPluginAdapter(
  id: string,
): PiWorkerPluginAdapter | undefined {
  return PI_WORKER_PLUGIN_ADAPTERS.find((adapter) => adapter.id === id);
}
