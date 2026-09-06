import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PiPluginAdapter } from "../assembly.ts";

export const RTK_PLUGIN_ID = "pi-rtk-optimizer" as const;
export const RTK_PLUGIN_CONTRACT_VERSION = "1" as const;
export const RTK_WORKSPACE_SERVICES = ["config", "status", "verify", "stats", "clear-stats"] as const;
export interface RtkAssemblyConfig extends Record<string, unknown> {
  enabled: boolean;
  mode: "rewrite" | "suggest";
  guardWhenRtkMissing: boolean;
  showRewriteNotifications: boolean;
  outputCompaction: {
    enabled: boolean;
    stripAnsi: boolean;
    readCompaction: { enabled: boolean };
    truncate: { enabled: boolean; maxChars: number };
    sourceCodeFilteringEnabled: boolean;
    preserveExactSkillReads: boolean;
    sourceCodeFiltering: "none" | "minimal" | "aggressive";
    smartTruncate: { enabled: boolean; maxLines: number };
    aggregateTestOutput: boolean;
    filterBuildOutput: boolean;
    compactGitOutput: boolean;
    aggregateLinterOutput: boolean;
    groupSearchOutput: boolean;
    trackSavings: boolean;
  };
}

/** RTK is a hook-only workspace component; its provenance is its installed entry. */
export function matchesRtkSource(sourceInfo: ToolInfo["sourceInfo"]): boolean {
  return sourceInfo.path.replace(/\\/g, "/").includes("/pi-rtk-optimizer/");
}
/** The managed entry captures this complete upstream-normalized configuration before assembly selection. */
export function validateRtkAssemblyConfig(config: Record<string, unknown>): asserts config is RtkAssemblyConfig {
  const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  if (!hasOnly(config, ["enabled", "mode", "guardWhenRtkMissing", "showRewriteNotifications", "outputCompaction"])) {
    throw new Error("RTK assembly config contains unsupported keys");
  }
  const output = config.outputCompaction;
  if (typeof output !== "object" || output === null || Array.isArray(output)) throw new Error("RTK assembly output compaction config is invalid");
  const compaction = output as Record<string, unknown>;
  if (!hasOnly(compaction, ["enabled", "stripAnsi", "readCompaction", "truncate", "sourceCodeFilteringEnabled", "preserveExactSkillReads", "sourceCodeFiltering", "smartTruncate", "aggregateTestOutput", "filterBuildOutput", "compactGitOutput", "aggregateLinterOutput", "groupSearchOutput", "trackSavings"])) throw new Error("RTK assembly output compaction config contains unsupported keys");
  const read = compaction.readCompaction;
  const truncate = compaction.truncate;
  const smart = compaction.smartTruncate;
  if (
    typeof config.enabled !== "boolean" || (config.mode !== "rewrite" && config.mode !== "suggest") || typeof config.guardWhenRtkMissing !== "boolean" || typeof config.showRewriteNotifications !== "boolean" ||
    typeof compaction.enabled !== "boolean" || typeof compaction.stripAnsi !== "boolean" || typeof compaction.sourceCodeFilteringEnabled !== "boolean" || typeof compaction.preserveExactSkillReads !== "boolean" || !["none", "minimal", "aggressive"].includes(compaction.sourceCodeFiltering as string) ||
    typeof compaction.aggregateTestOutput !== "boolean" || typeof compaction.filterBuildOutput !== "boolean" || typeof compaction.compactGitOutput !== "boolean" || typeof compaction.aggregateLinterOutput !== "boolean" || typeof compaction.groupSearchOutput !== "boolean" || typeof compaction.trackSavings !== "boolean" ||
    typeof read !== "object" || read === null || Array.isArray(read) || !hasOnly(read as Record<string, unknown>, ["enabled"]) || typeof (read as Record<string, unknown>).enabled !== "boolean" ||
    typeof truncate !== "object" || truncate === null || Array.isArray(truncate) || !hasOnly(truncate as Record<string, unknown>, ["enabled", "maxChars"]) || typeof (truncate as Record<string, unknown>).enabled !== "boolean" || !Number.isInteger((truncate as Record<string, unknown>).maxChars) || (truncate as Record<string, unknown>).maxChars as number < 1000 || (truncate as Record<string, unknown>).maxChars as number > 2_000_000 ||
    typeof smart !== "object" || smart === null || Array.isArray(smart) || !hasOnly(smart as Record<string, unknown>, ["enabled", "maxLines"]) || typeof (smart as Record<string, unknown>).enabled !== "boolean" || !Number.isInteger((smart as Record<string, unknown>).maxLines) || (smart as Record<string, unknown>).maxLines as number < 10 || (smart as Record<string, unknown>).maxLines as number > 100_000
  ) throw new Error("RTK assembly config is incomplete or invalid");
}

export function resolveRtkAssemblyConfig(input: { captured?: Record<string, unknown> }): RtkAssemblyConfig {
  if (!input.captured) throw new Error("RTK assembly requires host-captured effective configuration");
  validateRtkAssemblyConfig(input.captured);
  return structuredClone(input.captured) as RtkAssemblyConfig;
}

export const RTK_PLUGIN_ADAPTER: PiPluginAdapter = {
  id: RTK_PLUGIN_ID,
  packageName: RTK_PLUGIN_ID,
  displayName: "RTK Optimizer",
  contractVersion: RTK_PLUGIN_CONTRACT_VERSION,
  remoteTools: new Set(),
  companionArtifacts: [],
  workspaceServices: RTK_WORKSPACE_SERVICES,
  matchesSource: matchesRtkSource,
  resolveConfig: ({ captured }) => resolveRtkAssemblyConfig({ captured }),
  validateConfig: validateRtkAssemblyConfig,
};
