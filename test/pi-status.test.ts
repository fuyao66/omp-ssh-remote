import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPiWorkspaceStatus,
  getPiRemoteState,
  type PiRemoteExtensionState,
} from "../src/pi/host-extension.ts";
import {
  PI_CORE_COMPONENT_ID,
  type PiRuntimeAssembly,
} from "../src/pi/assembly.ts";
import { AFT_PLUGIN_ID } from "../src/pi/plugins/aft.ts";
import type { ReadyMessage } from "../src/protocol.ts";

const toolOwners = [
  { name: "read", owner: AFT_PLUGIN_ID },
  { name: "find", owner: PI_CORE_COMPONENT_ID },
  { name: "aft_outline", owner: AFT_PLUGIN_ID },
  { name: "bash_status", owner: AFT_PLUGIN_ID },
];
const components = [
  {
    id: PI_CORE_COMPONENT_ID,
    kind: "host" as const,
    contractVersion: "1",
    version: "0.90.0",
    displayName: "Pi Agent",
    tools: ["find"],
  },
  {
    id: AFT_PLUGIN_ID,
    kind: "plugin" as const,
    contractVersion: "1",
    version: "0.60.0",
    displayName: "AFT",
    tools: ["read", "aft_outline", "bash_status"],
  },
];
const assembly = {
  id: "assembly-test",
  displayName: "Pi + AFT",
  host: components[0],
  plugins: [components[1]],
  components,
  tools: toolOwners.map(({ name, owner }) => ({
    name,
    owner,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
  })),
  request: {
    id: "assembly-test",
    components: components.map(({ id, kind, contractVersion, version }) => ({
      id,
      kind,
      contractVersion,
      version,
    })),
    tools: toolOwners,
  },
  handshake: {} as never,
  workerBundle: { cacheNamespace: "pi", companionArtifacts: [] },
  knownWorkspaceTools: new Set(toolOwners.map((tool) => tool.name)),
  executionRuntime: {
    local: "local Pi + AFT runtime",
    remote: "model-free remote Pi + AFT runtime",
  },
} as PiRuntimeAssembly;

function readyWithTools(...names: string[]): ReadyMessage {
  return {
    type: "ready",
    protocolVersion: 1,
    host: "pi",
    hostVersion: "0.91.0",
    toolRuntimeVersion: "0.2.0",
    cwd: "/remote/project",
    tools: names.map((name) => ({
      name,
      description: `${name} description`,
      parameters: { type: "object", properties: {} },
    })),
    capabilities: {
      assembly: {
        id: assembly.id,
        components: [
          { ...assembly.request.components[0], version: "0.91.0" },
          { ...assembly.request.components[1], version: "0.61.0" },
        ],
        tools: toolOwners,
      },
    },
  };
}

afterEach(() => {
  const state = getPiRemoteState();
  state.selected = false;
  state.scope = undefined;
  state.assembly = undefined;
  state.cwd = undefined;
  state.connectOptions = undefined;
  state.connectionError = undefined;
  state.ownershipVerified = undefined;
  state.ready = undefined;
  state.localActiveTools = undefined;
});

describe("Pi remote workspace status", () => {
  test("reports local Pi when disconnected", () => {
    const status = buildPiWorkspaceStatus({ selected: false });
    expect(status.mode).toBe("local");
    expect(status.transport).toBe("not-selected");
    expect(status.assembly).toBeNull();
    expect(status.remoteWorkspaceTools).toEqual([]);
  });

  test("reports local and remote component versions separately", () => {
    const state: PiRemoteExtensionState = {
      selected: true,
      assembly,
      cwd: "/remote/project",
      scope: { isClosed: false } as never,
      ownershipVerified: true,
      ready: readyWithTools("read", "find", "aft_outline", "bash_status"),
    };
    const status = buildPiWorkspaceStatus(state);
    expect(status.mode).toBe("remote");
    expect(status.assembly?.displayName).toBe("Pi + AFT");
    expect(status.remoteWorkspaceTools).toEqual([
      "read",
      "find",
      "aft_outline",
      "bash_status",
    ]);
    expect(status.componentToolGroups).toEqual([
      {
        id: PI_CORE_COMPONENT_ID,
        displayName: "Pi Agent",
        localVersion: "0.90.0",
        remoteVersion: "0.91.0",
        tools: ["find"],
      },
      {
        id: AFT_PLUGIN_ID,
        displayName: "AFT",
        localVersion: "0.60.0",
        remoteVersion: "0.61.0",
        tools: ["read", "aft_outline", "bash_status"],
      },
    ]);
    expect(status.routing.executionRuntime).toContain("remote Pi + AFT");
  });

  test("fails closed until transport and ownership are verified", () => {
    const status = buildPiWorkspaceStatus({
      selected: true,
      assembly,
      cwd: "/remote/project",
      scope: { isClosed: false } as never,
      ownershipVerified: false,
      ready: readyWithTools("read"),
      connectionError: "read is still owned by a local extension",
    });
    expect(status.mode).toBe("unavailable");
    expect(status.connectionError).toContain("local extension");
    expect(status.remoteWorkspaceTools).toEqual([]);
  });

  test("registers only control tools before a connection", async () => {
    const { default: extension } = await import("../src/pi/host-extension.ts");
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const handlers = new Map<string, any[]>();
    const mockPi = {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      on(name: string, handler: any) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      getAllTools() {
        return [...tools.values()].map((tool) => ({
          ...tool,
          sourceInfo: { source: "extension", path: "pi-ssh-remote" },
        }));
      },
      getActiveTools() {
        return [...tools.keys()];
      },
      setActiveTools() {},
      sendUserMessage() {},
    };
    await extension(mockPi as never);
    expect([...tools.keys()].sort()).toEqual([
      "remote_connect",
      "remote_exit",
      "remote_workspace_status",
    ]);
    expect([...commands.keys()].sort()).toEqual([
      "remote-connect",
      "remote-exit",
      "remote-status",
    ]);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
