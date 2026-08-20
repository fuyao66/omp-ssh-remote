import type { ReadyMessage } from "../../protocol.ts";
import type { PiRuntimeProfile } from "../profile.ts";

export const PI_AFT_PROFILE_ID = "pi-aft" as const;
export const PI_AFT_PROFILE_VERSION = "1" as const;
export const PI_AFT_HOST_VERSION = "0.84.2" as const;
export const PI_AFT_RUNTIME_VERSION = "0.1.0" as const;
export const PI_AFT_PLUGIN_VERSION = "0.51.2" as const;
export const PI_AFT_PLUGIN_ID =
  `@cortexkit/aft-pi@${PI_AFT_PLUGIN_VERSION}` as const;

export const PI_AFT_NATIVE_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

const PI_AFT_PLUGIN_BASE_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
] as const;

export const PI_AFT_EXTENDED_TOOLS = [
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

export const PI_AFT_PLUGIN_TOOLS = [
  ...PI_AFT_PLUGIN_BASE_TOOLS,
  ...PI_AFT_EXTENDED_TOOLS,
] as const;

export const PI_AFT_REMOTE_TOOLS = [
  ...PI_AFT_NATIVE_TOOLS,
  ...PI_AFT_EXTENDED_TOOLS,
] as const;

export type PiAftRemoteToolName = (typeof PI_AFT_REMOTE_TOOLS)[number];

const REMOTE_TOOL_SET = new Set<string>(PI_AFT_REMOTE_TOOLS);

export function validatePiAftReadyMessage(ready: ReadyMessage): void {
  if (
    ready.host !== "pi" ||
    ready.hostVersion !== PI_AFT_HOST_VERSION ||
    ready.toolRuntimeVersion !== PI_AFT_RUNTIME_VERSION
  ) {
    throw new Error(
      `Remote Pi runtime version mismatch: host=${ready.hostVersion}, runtime=${ready.toolRuntimeVersion}`,
    );
  }
  if (ready.capabilities?.profileId !== PI_AFT_PROFILE_ID) {
    throw new Error(
      `Remote Pi runtime profile mismatch: expected ${PI_AFT_PROFILE_ID}`,
    );
  }
  if (ready.capabilities?.profileVersion !== PI_AFT_PROFILE_VERSION) {
    throw new Error(
      `Remote Pi runtime profile version mismatch: expected ${PI_AFT_PROFILE_VERSION}`,
    );
  }
  if (ready.capabilities?.aftHostRuntime !== PI_AFT_PLUGIN_ID) {
    throw new Error(
      `Remote Pi runtime did not verify AFT ${PI_AFT_PLUGIN_VERSION}`,
    );
  }

  const names = new Set<string>();
  for (const tool of ready.tools) {
    if (!REMOTE_TOOL_SET.has(tool.name)) {
      throw new Error(
        `Remote Pi runtime exposed unsupported tool: ${tool.name}`,
      );
    }
    if (names.has(tool.name)) {
      throw new Error(`Remote Pi runtime exposed duplicate tool: ${tool.name}`);
    }
    if (
      !tool.parameters ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters) ||
      (tool.parameters as Record<string, unknown>).type !== "object"
    ) {
      throw new Error(
        `Remote Pi tool ${tool.name} has an invalid parameter schema`,
      );
    }
    names.add(tool.name);
  }
  const missing = PI_AFT_REMOTE_TOOLS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Remote Pi runtime is missing tools: ${missing.join(", ")}`,
    );
  }
}

export const PI_AFT_PROFILE: PiRuntimeProfile = {
  id: PI_AFT_PROFILE_ID,
  version: PI_AFT_PROFILE_VERSION,
  displayName: "Pi + AFT",
  handshake: {
    host: "pi",
    hostVersion: PI_AFT_HOST_VERSION,
    runtimeVersion: PI_AFT_RUNTIME_VERSION,
    requestedTools: PI_AFT_REMOTE_TOOLS,
    validateReady: validatePiAftReadyMessage,
  },
  workerBundle: {
    cacheNamespace: "pi",
    companionArtifacts: [
      {
        id: "aft",
        filePrefix: "aft-linux",
        executableName: "aft",
      },
    ],
  },
  knownWorkspaceTools: REMOTE_TOOL_SET,
  toolGroups: [
    {
      id: "aft",
      displayName: "AFT plugin runtime",
      tools: new Set<string>(PI_AFT_PLUGIN_TOOLS),
    },
    {
      id: "pi-native",
      displayName: "Pi native runtime",
      tools: new Set<string>(["find", "ls"]),
    },
  ],
  executionRuntime: {
    local: "local Pi Agent with AFT plugin runtime",
    remote:
      "headless Pi Agent with the matching AFT plugin and native engine on the remote workspace",
  },
};
