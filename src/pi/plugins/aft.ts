import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PiPluginAdapter } from "../assembly.ts";

export const AFT_PLUGIN_ID = "@cortexkit/aft-pi" as const;
export const AFT_PLUGIN_CONTRACT_VERSION = "1" as const;

export const AFT_PLUGIN_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "bash_status",
  "bash_watch",
  "bash_write",
  "bash_kill",
  "aft_outline",
  "aft_zoom",
  "aft_inspect",
  "aft_conflicts",
  "aft_import",
  "aft_safety",
  "ast_grep_search",
  "ast_grep_replace",
] as const;

const AFT_TOOL_SET = new Set<string>(AFT_PLUGIN_TOOLS);

function matchesAftSource(sourceInfo: ToolInfo["sourceInfo"]): boolean {
  const values = [sourceInfo.path, sourceInfo.source, sourceInfo.baseDir]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replaceAll("\\", "/"));
  return values.some(
    (value) =>
      value === AFT_PLUGIN_ID ||
      value === `npm:${AFT_PLUGIN_ID}` ||
      value === `<inline:${AFT_PLUGIN_ID}>` ||
      value.includes(`/node_modules/${AFT_PLUGIN_ID}/`) ||
      value.includes(`/${AFT_PLUGIN_ID}@`) ||
      value.endsWith(`/${AFT_PLUGIN_ID}`),
  );
}

export const AFT_PLUGIN_ADAPTER: PiPluginAdapter = {
  id: AFT_PLUGIN_ID,
  packageName: AFT_PLUGIN_ID,
  displayName: "AFT",
  contractVersion: AFT_PLUGIN_CONTRACT_VERSION,
  remoteTools: AFT_TOOL_SET,
  companionArtifacts: [
    {
      id: "aft",
      filePrefix: "aft-linux",
      executableName: "aft",
    },
  ],
  matchesSource: matchesAftSource,
};
