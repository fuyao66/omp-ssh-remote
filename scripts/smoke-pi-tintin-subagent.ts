import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import aftExtension from "@cortexkit/aft-pi";
import { PI_CORE_TOOL_NAMES } from "../src/pi/assembly.ts";
import { AFT_PLUGIN_ID, AFT_PLUGIN_TOOLS } from "../src/pi/plugins/aft.ts";

const tintinEntry = process.env.PI_TINTIN_SUBAGENTS_ENTRY;
if (!tintinEntry) {
  throw new Error("PI_TINTIN_SUBAGENTS_ENTRY is required");
}
const tintinExtension = (await import(tintinEntry)).default;
const target = process.env.REMOTE_TARGET;
const remoteCwd = process.env.REMOTE_CWD;
const expectedHostname = process.env.REMOTE_EXPECTED_HOSTNAME;
if (!target || !remoteCwd) {
  throw new Error("REMOTE_TARGET and REMOTE_CWD are required");
}

const root = await mkdtemp("/tmp/pi-ssh-remote-tintin-subagent-");
const originalCwd = process.cwd();
const agentDir = join(root, "agent");
const localCwd = join(root, "project");
const rootExtensionPath = new URL(
  "../packages/pi/dist/pi-extension.js",
  import.meta.url,
).pathname;
const tintinChildExtensionPath = new URL(
  "../packages/pi/dist/pi-tintin-extension.js",
  import.meta.url,
).pathname;
const childVerifierPath = new URL(
  "./fixtures/tintin-remote-verifier.ts",
  import.meta.url,
).pathname;
delete process.env.PI_TINTIN_SMOKE_CHILD_STATE;
await Promise.all([
  mkdir(agentDir, { recursive: true }),
  mkdir(join(localCwd, ".pi", "agents"), { recursive: true }),
]);
await writeFile(
  join(localCwd, ".pi", "agents", "remote-worker.md"),
  `---
description: Verify a remote workspace
extensions:
  - ${JSON.stringify(tintinChildExtensionPath)}
  - ${JSON.stringify(childVerifierPath)}
tools: bash
run_in_background: false
max_turns: 3
---
Use bash exactly twice: run \`hostname\` and \`pwd\`. Return the two raw outputs, one per line. Do not use any other tool.\n`,
);

const settingsManager = SettingsManager.create(localCwd, agentDir);
const modelRuntime = await ModelRuntime.create({
  modelsPath: null,
  refreshOnCreate: false,
});
const faux = fauxProvider({
  provider: "tintin-smoke",
  models: [{ id: "worker" }],
});
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("bash", { command: "hostname" })),
  fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" })),
  fauxAssistantMessage("child tool calls complete"),
  fauxAssistantMessage("child tool calls complete"),
]);
process.chdir(localCwd);
const resourceLoader = new DefaultResourceLoader({
  cwd: localCwd,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [rootExtensionPath],
  extensionFactories: [
    { name: AFT_PLUGIN_ID, factory: aftExtension, hidden: true },
    { name: "tintin-pi-subagents", factory: tintinExtension, hidden: true },
  ],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd: localCwd,
  agentDir,
  settingsManager,
  resourceLoader,
  modelRuntime,
  model: faux.getModel(),
  sessionManager: SessionManager.inMemory(localCwd),
  tools: [
    ...new Set([
      ...PI_CORE_TOOL_NAMES,
      ...AFT_PLUGIN_TOOLS,
      "remote_connect",
      "remote_exit",
      "remote_workspace_status",
      "Agent",
      "get_subagent_result",
    ]),
  ],
});
await session.bindExtensions({
  mode: "print",
  commandContextActions: {
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => session.reload(),
  },
});

const textOf = (result: unknown): string => {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.map((part) => part.text ?? "").join("\n") ?? "";
};
const execute = async (name: string, args: Record<string, unknown>) => {
  const tool = session.getToolDefinition(name) as ToolDefinition | undefined;
  if (!tool) throw new Error(`Missing tool definition ${name}`);
  return tool.execute(
    `tintin-subagent-smoke-${name}-${Date.now()}`,
    args,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
};

let remoteConnected = false;
try {
  await execute("remote_connect", { target, cwd: remoteCwd });
  remoteConnected = true;

  if (!process.env.PI_REMOTE_CONNECTION_SPEC) {
    throw new Error("Parent connection did not publish an inherited assembly");
  }

  const result = await execute("Agent", {
    subagent_type: "remote-worker",
    prompt:
      "Use bash exactly twice: run `hostname` and `pwd`. Return the two raw outputs, one per line, and do not use any other tool.",
    description: "Verify remote child",
    run_in_background: false,
    max_turns: 3,
  });
  const output = textOf(result);
  const childStateText = process.env.PI_TINTIN_SMOKE_CHILD_STATE;
  if (!childStateText) {
    throw new Error("Tintin child did not load the remote verifier extension");
  }
  const childState = JSON.parse(childStateText) as {
    bashResults: unknown[];
    bashSource?: unknown;
  };
  const bashResults = JSON.stringify(childState.bashResults);
  if (!JSON.stringify(childState.bashSource).includes(tintinChildExtensionPath)) {
    throw new Error(
      `Tintin child bash is not owned by Pi SSH Remote: ${childStateText}`,
    );
  }
  if (!output.includes("child tool calls complete")) {
    throw new Error(`Tintin child did not complete both bash calls: ${output}`);
  }
  if (!bashResults.includes(remoteCwd)) {
    throw new Error(
      `Tintin child did not execute in remote cwd ${remoteCwd}: ${childStateText}`,
    );
  }
  if (expectedHostname && !bashResults.includes(expectedHostname)) {
    throw new Error(
      `Tintin child did not execute on ${expectedHostname}: ${childStateText}`,
    );
  }
  if (!expectedHostname && bashResults.includes(hostname())) {
    throw new Error(`Tintin child used the local host: ${childStateText}`);
  }
  console.log(
    JSON.stringify({ remoteCwd, expectedHostname, childState, output }),
  );
} finally {
  if (remoteConnected) {
    try {
      await execute("remote_exit", { force: false });
    } catch {}
  }
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}
