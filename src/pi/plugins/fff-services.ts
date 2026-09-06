import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkspacePluginHandle } from "../workspace-plugin.ts";
import { FFF_PLUGIN_ID } from "./fff.ts";

export type FffServiceName = "completion" | "health" | "rescan";

export const FFF_SERVICE_NAMES = [
  "completion",
  "health",
  "rescan",
] as const satisfies readonly FffServiceName[];

export const FFF_SERVICE_TOOL_PREFIX = `${FFF_PLUGIN_ID}/service/` as const;

/** Minimal handle surface shared by worker runtime and managed capture. */
export interface ManagedFffHandle extends WorkspacePluginHandle {
  getRegisteredTools(): ReadonlyArray<ToolDefinition>;
  getConfigSnapshot(): Record<string, unknown>;
  service(
    name: FffServiceName,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  suspend(): Promise<void>;
  shutdown(): Promise<void>;
}


export function parseFffServiceTool(tool: string): FffServiceName | undefined {
  if (!tool.startsWith(FFF_SERVICE_TOOL_PREFIX)) return undefined;
  const name = tool.slice(FFF_SERVICE_TOOL_PREFIX.length);
  return (FFF_SERVICE_NAMES as readonly string[]).includes(name)
    ? (name as FffServiceName)
    : undefined;
}

