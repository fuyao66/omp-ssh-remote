import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import aftExtension from "@cortexkit/aft-pi";
import { PI_CORE_TOOL_NAMES } from "../src/pi/assembly.ts";
import { AFT_PLUGIN_ID, AFT_PLUGIN_TOOLS } from "../src/pi/plugins/aft.ts";

const target = process.env.REMOTE_TARGET;
const remoteCwd = process.env.REMOTE_CWD;
const expectedHostname = process.env.REMOTE_EXPECTED_HOSTNAME;
const pluginMode = process.env.PI_SMOKE_PLUGINS ?? "aft";
if (!target || !remoteCwd) {
  throw new Error("REMOTE_TARGET and REMOTE_CWD are required");
}
if (pluginMode !== "none" && pluginMode !== "aft") {
  throw new Error("PI_SMOKE_PLUGINS must be none or aft");
}
const withAft = pluginMode === "aft";
const root = await mkdtemp("/tmp/pi-ssh-remote-assembly-");
const agentDir = join(root, "agent");
const localCwd = join(root, "project");
await Promise.all([
  mkdir(agentDir, { recursive: true }),
  mkdir(localCwd, { recursive: true }),
]);

const settingsManager = SettingsManager.create(localCwd, agentDir);
const resourceLoader = new DefaultResourceLoader({
  cwd: localCwd,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [
    new URL("../packages/pi", import.meta.url).pathname,
  ],
  extensionFactories: withAft
    ? [{ name: AFT_PLUGIN_ID, factory: aftExtension, hidden: true }]
    : [],
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
  sessionManager: SessionManager.inMemory(localCwd),
  tools: [
    ...new Set([
      ...PI_CORE_TOOL_NAMES,
      ...(withAft ? AFT_PLUGIN_TOOLS : []),
      "remote_connect",
      "remote_exit",
      "remote_workspace_status",
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

const toolSource = (name: string): string => {
  const tool = session
    .getAllTools()
    .find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Pi tool ${name}`);
  return JSON.stringify(tool.sourceInfo);
};
const execute = async (name: string, args: Record<string, unknown>) => {
  const tool = session.getToolDefinition(name) as ToolDefinition | undefined;
  if (!tool) throw new Error(`Missing tool definition ${name}`);
  return tool.execute(
    `assembly-smoke-${name}-${Date.now()}`,
    args,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
};
const textOf = (result: unknown): string => {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.map((part) => part.text ?? "").join("\n") ?? "";
};

let remoteConnected = false;
try {
  const localReadSource = toolSource("read");
  if (withAft !== localReadSource.includes(AFT_PLUGIN_ID)) {
    throw new Error(`Unexpected local read owner: ${localReadSource}`);
  }

  await execute("remote_connect", { target, cwd: remoteCwd });
  remoteConnected = true;

  const status = JSON.parse(
    textOf(await execute("remote_workspace_status", {})),
  );
  const pluginIds = (status.assembly?.plugins ?? []).map(
    (plugin: { id?: string }) => plugin.id,
  );
  if (
    status.assembly?.host?.id !== "pi-core" ||
    withAft !== pluginIds.includes(AFT_PLUGIN_ID)
  ) {
    throw new Error(
      `Resolved runtime assembly is incorrect: ${JSON.stringify(status)}`,
    );
  }

  const remoteRead = session.getAllTools().find((tool) => tool.name === "read");
  const remoteReadSource = toolSource("read");
  if (
    !remoteReadSource.includes("packages/pi/dist/pi-extension.js") ||
    remoteReadSource.includes(AFT_PLUGIN_ID)
  ) {
    throw new Error(`Remote read owner is incorrect: ${remoteReadSource}`);
  }
  if (
    !remoteRead?.parameters ||
    Object.keys(remoteRead.parameters).length === 0
  ) {
    throw new Error("Remote read schema is missing");
  }

  const remoteHostname = textOf(
    await execute("bash", { command: "hostname" }),
  ).trim();
  if (!remoteHostname || remoteHostname === hostname()) {
    throw new Error(
      `Bash did not execute remotely: ${remoteHostname || "<empty>"}`,
    );
  }
  if (expectedHostname && remoteHostname !== expectedHostname) {
    throw new Error(
      `Unexpected remote hostname ${remoteHostname}; expected ${expectedHostname}`,
    );
  }

  const probePath = ".pi-ssh-remote-assembly-smoke.ts";
  await execute("write", {
    path: probePath,
    content: "export interface RemoteAssemblyProbe { id: string }\n",
  });
  const probe = textOf(
    withAft
      ? await execute("aft_outline", { target: probePath })
      : await execute("read", { path: probePath }),
  );
  if (!probe.includes("RemoteAssemblyProbe")) {
    throw new Error(
      `Remote ${withAft ? "AFT outline" : "Pi read"} failed: ${probe}`,
    );
  }
  await execute("bash", { command: `rm -f ${probePath}` });

  await session.prompt("/remote-exit");
  remoteConnected = false;
  const restoredReadSource = toolSource("read");
  if (withAft !== restoredReadSource.includes(AFT_PLUGIN_ID)) {
    throw new Error(`Local read owner was not restored: ${restoredReadSource}`);
  }

  console.log(
    JSON.stringify({
      pluginMode,
      assembly: status.assembly,
      localReadSource,
      remoteReadSource,
      restoredReadSource,
      remoteHostname,
      probe: probe.trim(),
    }),
  );
} finally {
  if (remoteConnected) {
    try {
      await session.prompt("/remote-exit --force");
    } catch {}
  }
  try {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  } catch {}
  session.dispose();
  await rm(root, { recursive: true, force: true });
}
