import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../protocol.ts";
import type { PiPluginAdapter, PiToolSnapshot } from "../assembly.ts";

export const FFF_PLUGIN_ID = "@ff-labs/pi-fff" as const;
export const FFF_PLUGIN_CONTRACT_VERSION = "1" as const;

export const FFF_DEFAULT_TOOLS = ["fffind", "ffgrep"] as const;
export const FFF_OPTIONAL_TOOLS = ["fff-multi-grep", "multi_grep"] as const;
export const FFF_OVERRIDE_TOOLS = ["find", "grep"] as const;
export const FFF_WORKSPACE_SERVICES = [
  "completion",
  "health",
  "rescan",
] as const;

export const FFF_PLUGIN_TOOLS = [
  ...FFF_DEFAULT_TOOLS,
  ...FFF_OPTIONAL_TOOLS,
  ...FFF_OVERRIDE_TOOLS,
] as const;

export const FFF_ASSEMBLY_MODES = [
  "tools-and-ui",
  "tools-only",
  "override",
] as const;

export type FffAssemblyMode = (typeof FFF_ASSEMBLY_MODES)[number];

export type FffAssemblyConfig = {
  mode: FffAssemblyMode;
  enableFsRootScanning?: boolean;
  enableHomeDirScanning?: boolean;
  warnOnHomeDirScan?: boolean;
  followSymlinks?: boolean;
  multiGrep?: boolean;
};

const FFF_TOOL_SET = new Set<string>(FFF_PLUGIN_TOOLS);
const FFF_MODE_LOOKUP: Record<string, true> = {
  "tools-and-ui": true,
  "tools-only": true,
  override: true,
};
const FFF_CONFIG_KEYS: Record<string, true> = {
  mode: true,
  enableFsRootScanning: true,
  enableHomeDirScanning: true,
  warnOnHomeDirScan: true,
  followSymlinks: true,
  multiGrep: true,
};

function matchesFffSource(sourceInfo: ToolInfo["sourceInfo"]): boolean {
  const values = [sourceInfo.path, sourceInfo.source, sourceInfo.baseDir]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replaceAll("\\", "/"));
  return values.some(
    (value) =>
      value === FFF_PLUGIN_ID ||
      value === `npm:${FFF_PLUGIN_ID}` ||
      value === `<inline:${FFF_PLUGIN_ID}>` ||
      value.includes(`/node_modules/${FFF_PLUGIN_ID}/`) ||
      value.includes(`/${FFF_PLUGIN_ID}@`) ||
      value.endsWith(`/${FFF_PLUGIN_ID}`),
  );
}

function readOptionalBoolean(
  config: Record<string, unknown>,
  key:
    | "enableFsRootScanning"
    | "enableHomeDirScanning"
    | "warnOnHomeDirScan"
    | "followSymlinks"
    | "multiGrep",
): boolean | undefined {
  if (!(key in config) || config[key] === undefined) return undefined;
  if (typeof config[key] !== "boolean") {
    throw new Error(`FFF assembly config "${key}" must be a boolean`);
  }
  return config[key] as boolean;
}

export function validateFffAssemblyConfig(
  config: Record<string, unknown>,
): asserts config is FffAssemblyConfig {
  for (const key of Object.keys(config)) {
    if (!FFF_CONFIG_KEYS[key]) {
      throw new Error(`FFF assembly config contains unsupported key: ${key}`);
    }
  }
  if (typeof config.mode !== "string" || !FFF_MODE_LOOKUP[config.mode]) {
    throw new Error(
      `FFF assembly config "mode" must be one of ${FFF_ASSEMBLY_MODES.join(", ")}`,
    );
  }
  readOptionalBoolean(config, "enableFsRootScanning");
  readOptionalBoolean(config, "enableHomeDirScanning");
  readOptionalBoolean(config, "warnOnHomeDirScan");
  readOptionalBoolean(config, "followSymlinks");
  readOptionalBoolean(config, "multiGrep");
}

export function resolveFffAssemblyConfig(input: {
  captured?: Record<string, unknown>;
  tools: readonly PiToolSnapshot[];
}): FffAssemblyConfig {
  if (input.captured === undefined) {
    throw new Error(
      "FFF assembly requires host-captured effective configuration",
    );
  }
  if (!isRecord(input.captured)) {
    throw new Error("FFF captured config must be a plain object");
  }

  // Validate the captured payload before any normalization or inference.
  validateFffAssemblyConfig(input.captured);

  const mode = input.captured.mode;
  const names = [...new Set(input.tools.map((tool) => tool.name))].sort();
  const defaultNames = names.filter(
    (name) => name === "fffind" || name === "ffgrep" || name === "fff-multi-grep",
  );
  const overrideNames = names.filter(
    (name) => name === "find" || name === "grep" || name === "multi_grep",
  );

  if (defaultNames.length > 0 && overrideNames.length > 0) {
    throw new Error(
      "FFF assembly tools mix default and override names in one runtime",
    );
  }

  if (mode === "override") {
    if (defaultNames.length > 0) {
      throw new Error(
        'FFF override mode cannot expose default tools fffind/ffgrep/fff-multi-grep',
      );
    }
    if (!overrideNames.includes("find") || !overrideNames.includes("grep")) {
      throw new Error(
        "FFF override mode requires source-verified find and grep tools",
      );
    }
    for (const name of overrideNames) {
      if (name !== "find" && name !== "grep" && name !== "multi_grep") {
        throw new Error(`FFF override mode does not admit tool ${name}`);
      }
    }
  } else {
    if (overrideNames.length > 0) {
      throw new Error(
        `FFF ${mode} mode cannot expose override tools find/grep/multi_grep`,
      );
    }
    if (!defaultNames.includes("fffind") || !defaultNames.includes("ffgrep")) {
      throw new Error(
        `FFF ${mode} mode requires source-verified fffind and ffgrep tools`,
      );
    }
    for (const name of defaultNames) {
      if (
        name !== "fffind" &&
        name !== "ffgrep" &&
        name !== "fff-multi-grep"
      ) {
        throw new Error(`FFF ${mode} mode does not admit tool ${name}`);
      }
    }
  }

  const multiGrepTool =
    mode === "override" ? "multi_grep" : "fff-multi-grep";
  const hasMultiGrep = names.includes(multiGrepTool);
  const multiGrep = readOptionalBoolean(input.captured, "multiGrep");
  if (multiGrep === true && !hasMultiGrep) {
    throw new Error(
      `FFF assembly config multiGrep=true requires tool ${multiGrepTool}`,
    );
  }
  if (multiGrep === false && hasMultiGrep) {
    throw new Error(
      `FFF assembly config multiGrep=false cannot include tool ${multiGrepTool}`,
    );
  }
  if (multiGrep === undefined && hasMultiGrep) {
    throw new Error(
      `FFF assembly config must set multiGrep=true when ${multiGrepTool} is present`,
    );
  }

  const resolved: FffAssemblyConfig = { mode };
  const enableFsRootScanning = readOptionalBoolean(
    input.captured,
    "enableFsRootScanning",
  );
  if (enableFsRootScanning !== undefined) {
    resolved.enableFsRootScanning = enableFsRootScanning;
  }
  const enableHomeDirScanning = readOptionalBoolean(
    input.captured,
    "enableHomeDirScanning",
  );
  if (enableHomeDirScanning !== undefined) {
    resolved.enableHomeDirScanning = enableHomeDirScanning;
  }
  const warnOnHomeDirScan = readOptionalBoolean(
    input.captured,
    "warnOnHomeDirScan",
  );
  if (warnOnHomeDirScan !== undefined) {
    resolved.warnOnHomeDirScan = warnOnHomeDirScan;
  }
  const followSymlinks = readOptionalBoolean(input.captured, "followSymlinks");
  if (followSymlinks !== undefined) {
    resolved.followSymlinks = followSymlinks;
  }
  if (multiGrep !== undefined) {
    resolved.multiGrep = multiGrep;
  }

  validateFffAssemblyConfig(resolved);
  return resolved;
}

export const FFF_PLUGIN_ADAPTER: PiPluginAdapter = {
  id: FFF_PLUGIN_ID,
  packageName: FFF_PLUGIN_ID,
  displayName: "FFF",
  contractVersion: FFF_PLUGIN_CONTRACT_VERSION,
  remoteTools: FFF_TOOL_SET,
  companionArtifacts: [],
  workspaceServices: FFF_WORKSPACE_SERVICES,
  matchesSource: matchesFffSource,
  resolveConfig: ({ captured, tools }) =>
    resolveFffAssemblyConfig({ captured, tools }),
  validateConfig: validateFffAssemblyConfig,
};
