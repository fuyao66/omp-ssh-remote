import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  claimPiTintinSubagentConnectionSpec,
  clearPiTintinSubagentConnectionSpec,
  publishPiTintinSubagentConnectionSpec,
  readPiTintinSubagentConnectionSpec,
} from "../src/pi/integrations/tintin-subagents.ts";
import {
  PI_CORE_COMPONENT_ID,
  PI_CORE_TOOL_NAMES,
  resolvePiRuntimeAssembly,
  restorePiRuntimeAssembly,
  type PiRuntimeAssembly,
  type PiToolSnapshot,
} from "../src/pi/assembly.ts";
import { AFT_PLUGIN_ID } from "../src/pi/plugins/aft.ts";
import { PiRemoteWorkspaceScope } from "../src/pi/scope.ts";
import {
  filterStaleRemoteWrappers,
  getPiRemoteOwnershipErrors,
  getPiRemoteStateForSession,
} from "../src/pi/host-extension.ts";
import piTintinExtension from "../src/pi/pi-tintin-extension.ts";

const ENV_KEY = "PI_REMOTE_CONNECTION_SPEC";
const OWNER_KEY = "PI_REMOTE_CONNECTION_OWNER";
const OWNER_TOKEN = "test-root";
const objectSchema = { type: "object", properties: {} };
const aftEntry = join(
  import.meta.dir,
  "../node_modules/@cortexkit/aft-pi/dist/index.js",
);

function tool(
  name: string,
  source: "builtin" | "aft" | "inline" | "unknown" = "builtin",
): PiToolSnapshot {
  const sourceInfo =
    source === "builtin"
      ? { source: "builtin", path: `<builtin:${name}>` }
      : source === "aft"
        ? { source: "local", path: aftEntry, baseDir: join(aftEntry, "..") }
        : source === "inline"
          ? { source: "inline", path: `<inline:${AFT_PLUGIN_ID}>` }
          : { source: "local", path: "/tmp/unknown-extension.ts" };
  return {
    name,
    description: `${name} description`,
    parameters: objectSchema as never,
    sourceInfo: sourceInfo as never,
  };
}

async function coreAssembly(): Promise<PiRuntimeAssembly> {
  const tools = PI_CORE_TOOL_NAMES.map((name) => tool(name));
  return resolvePiRuntimeAssembly({
    tools,
    activeTools: tools.map((item) => item.name),
    hostVersion: "0.99.0",
  });
}

afterEach(() => {
  const owner = process.env[OWNER_KEY];
  if (owner) clearPiTintinSubagentConnectionSpec(owner);
  else clearPiTintinSubagentConnectionSpec(OWNER_TOKEN);
  delete process.env[ENV_KEY];
  delete process.env[OWNER_KEY];
});

describe("Pi runtime assembly resolver", () => {
  test("builds a pure Pi assembly without plugin artifacts", async () => {
    const assembly = await coreAssembly();
    expect(assembly.displayName).toBe("Pi core");
    expect(assembly.host.version).toBe("0.99.0");
    expect(assembly.plugins).toEqual([]);
    expect(assembly.workerBundle.companionArtifacts).toEqual([]);
    expect(assembly.tools.map(({ name, owner }) => [name, owner])).toEqual(
      [...PI_CORE_TOOL_NAMES]
        .sort()
        .map((name) => [name, PI_CORE_COMPONENT_ID]),
    );
  });

  test("composes independently detected plugin adapters with Pi core tools", async () => {
    const tools = [
      tool("read", "aft"),
      tool("aft_outline", "aft"),
      tool("find"),
      tool("ls"),
      tool("bash_status", "aft"),
    ];
    const assembly = await resolvePiRuntimeAssembly({
      tools,
      activeTools: ["read", "aft_outline", "find", "bash_status"],
      hostVersion: "1.2.3",
    });

    expect(assembly.displayName).toBe("Pi core with plugin adapters: AFT");
    expect(assembly.components.map((component) => component.id)).toEqual([
      PI_CORE_COMPONENT_ID,
      AFT_PLUGIN_ID,
    ]);
    expect(assembly.plugins[0]?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(assembly.tools.map(({ name, owner }) => [name, owner])).toEqual([
      ["aft_outline", AFT_PLUGIN_ID],
      ["bash_status", AFT_PLUGIN_ID],
      ["find", PI_CORE_COMPONENT_ID],
      ["read", AFT_PLUGIN_ID],
    ]);
    expect(assembly.workerBundle.companionArtifacts).toEqual([
      {
        id: "aft",
        filePrefix: "aft-linux",
        executableName: "aft",
      },
    ]);
    expect(assembly.request.components[1]?.version).toBe(
      assembly.plugins[0]?.version,
    );
  });

  test("rejects unknown owners and unsupported tools from a known plugin", async () => {
    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("read", "unknown")],
        activeTools: ["read"],
        hostVersion: "1.0.0",
      }),
    ).rejects.toThrow("unsupported extension");

    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("new_aft_tool", "aft")],
        activeTools: ["new_aft_tool"],
        hostVersion: "1.0.0",
      }),
    ).rejects.toThrow("not admitted by its remote adapter");
  });

  test("rejects tools outside the resolved assembly before transport", async () => {
    const assembly = await coreAssembly();
    let invoked = false;
    const scope = Object.create(PiRemoteWorkspaceScope.prototype) as {
      assembly: PiRuntimeAssembly;
      client: { execute(): Promise<never> };
      execute: PiRemoteWorkspaceScope["execute"];
    };
    Object.assign(scope, {
      assembly,
      client: {
        async execute(): Promise<never> {
          invoked = true;
          throw new Error("transport must not run");
        },
      },
    });

    expect(() => scope.execute("workflow_control", "call", {})).toThrow(
      `not admitted by Pi assembly ${assembly.id}`,
    );
    expect(invoked).toBe(false);
  });
});

describe("tintin subagent assembly inheritance", () => {
  test("round-trips the computed assembly and connection scope", async () => {
    const assembly = await coreAssembly();
    const inheritedSpec = {
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: {
        target: "gpu-box",
        displayTarget: "gpu-box",
        identityFile: "/tmp/id",
        port: 22,
      },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    };
    publishPiTintinSubagentConnectionSpec(inheritedSpec);
    expect(readPiTintinSubagentConnectionSpec()).toEqual(inheritedSpec);
  });

  test("does not let a second root overwrite the inherited connection slot", () => {
    claimPiTintinSubagentConnectionSpec("root-a");
    expect(() => claimPiTintinSubagentConnectionSpec("root-b")).toThrow(
      "Another Pi root session already owns",
    );
    expect(process.env[OWNER_KEY]).toBe("root-a");
  });

  test("lets a fresh default entry inherit the active root connection", async () => {
    const assembly = await coreAssembly();
    publishPiTintinSubagentConnectionSpec({
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    const mock = createPiMock();
    await (await import("../src/pi/pi-extension.ts")).default(mock.pi as never);
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    expect(state.isInheritedChild).toBe(true);
    expect(state.inheritanceOwnerToken).toBeUndefined();
    expect(state.selected).toBe(false);
  });

  test("keeps the default entry as root across reloads", async () => {
    const assembly = await coreAssembly();
    publishPiTintinSubagentConnectionSpec({
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    state.inheritanceOwnerToken = OWNER_TOKEN;
    await (await import("../src/pi/pi-extension.ts")).default(mock.pi as never);
    expect(state.isInheritedChild).toBeUndefined();
    expect(state.inheritanceOwnerToken).toBe(OWNER_TOKEN);
    expect(state.selected).toBe(false);
  });

  test("rejects malformed inherited assemblies", async () => {
    const assembly = await coreAssembly();
    process.env[OWNER_KEY] = OWNER_TOKEN;
    process.env[ENV_KEY] = JSON.stringify({
      ownerToken: OWNER_TOKEN,
      assembly: { ...assembly.request, components: [{ id: "broken" }] },
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    expect(() => readPiTintinSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );

    process.env[ENV_KEY] = JSON.stringify({
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
    });
    expect(() => readPiTintinSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );
  });
});

describe("Pi assembly compatibility identity", () => {
  test("does not use package versions as compatibility gates", async () => {
    const tools = PI_CORE_TOOL_NAMES.map((name) => tool(name));
    const first = await resolvePiRuntimeAssembly({
      tools,
      activeTools: tools.map((item) => item.name),
      hostVersion: "0.84.2",
    });
    const second = await resolvePiRuntimeAssembly({
      tools,
      activeTools: tools.map((item) => item.name),
      hostVersion: "9.0.0",
    });
    expect(first.id).toBe(second.id);
    expect(first.host.version).not.toBe(second.host.version);
  });

  test("derives plugin order from the active tool registry", async () => {
    const adapters = [
      {
        id: "example/first",
        packageName: AFT_PLUGIN_ID,
        displayName: "First",
        contractVersion: "1",
        remoteTools: new Set(["first_tool"]),
        companionArtifacts: [],
        matchesSource: (sourceInfo: PiToolSnapshot["sourceInfo"]) =>
          sourceInfo.source === "first",
      },
      {
        id: "example/second",
        packageName: AFT_PLUGIN_ID,
        displayName: "Second",
        contractVersion: "1",
        remoteTools: new Set(["second_tool"]),
        companionArtifacts: [],
        matchesSource: (sourceInfo: PiToolSnapshot["sourceInfo"]) =>
          sourceInfo.source === "second",
      },
    ];
    const tools: PiToolSnapshot[] = [
      {
        name: "second_tool",
        description: "second",
        parameters: objectSchema as never,
        sourceInfo: { source: "second", path: aftEntry } as never,
      },
      {
        name: "first_tool",
        description: "first",
        parameters: objectSchema as never,
        sourceInfo: { source: "first", path: aftEntry } as never,
      },
    ];
    const assembly = await resolvePiRuntimeAssembly({
      tools,
      activeTools: tools.map((item) => item.name),
      hostVersion: "1.0.0",
      pluginAdapters: adapters,
    });
    expect(assembly.components.map((component) => component.id)).toEqual([
      PI_CORE_COMPONENT_ID,
      "example/second",
      "example/first",
    ]);
  });
});

describe("Pi plugin provenance boundary", () => {
  test("fails closed when a declared plugin tool has an unknown owner", async () => {
    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("find"), tool("aft_outline", "unknown")],
        activeTools: ["find", "aft_outline"],
        hostVersion: "1.0.0",
      }),
    ).rejects.toThrow("unsupported source provenance");
  });
});

describe("Pi package provenance", () => {
  test("recognizes the inline source used by loaded Pi packages", async () => {
    const assembly = await resolvePiRuntimeAssembly({
      tools: [tool("aft_outline", "inline")],
      activeTools: ["aft_outline"],
      hostVersion: "1.0.0",
    });
    expect(assembly.plugins.map((plugin) => plugin.id)).toEqual([
      AFT_PLUGIN_ID,
    ]);
    expect(assembly.tools[0]?.owner).toBe(AFT_PLUGIN_ID);
  });
});

describe("stale remote wrapper filtering", () => {
  const extensionSource = {
    source: "local",
    path: "/ext/omp-ssh-remote/index.ts",
  };

  test("drops leftover remote wrappers but keeps native tools before reconnection", () => {
    const tools = [
      {
        name: "remote_workspace_status",
        description: "status",
        parameters: objectSchema,
        sourceInfo: extensionSource,
      },
      {
        name: "read",
        description: "stale remote wrapper",
        parameters: objectSchema,
        sourceInfo: extensionSource,
      },
      {
        name: "read",
        description: "native read",
        parameters: objectSchema,
        sourceInfo: { source: "builtin", path: "<builtin:read>" },
      },
      {
        name: "custom_control_tool",
        description: "extension-owned control tool",
        parameters: objectSchema,
        sourceInfo: extensionSource,
      },
    ];
    const kept = filterStaleRemoteWrappers(tools as never);
    expect(kept.map((item) => `${item.name}:${item.description}`)).toEqual([
      "remote_workspace_status:status",
      "read:native read",
      "custom_control_tool:extension-owned control tool",
    ]);
  });

  test("keeps the registry unchanged when no control tool is present", () => {
    const tools = [
      {
        name: "read",
        description: "stale remote wrapper",
        parameters: objectSchema,
        sourceInfo: extensionSource,
      },
    ];
    expect(filterStaleRemoteWrappers(tools as never)).toBe(tools as never);
  });
});

describe("restored Pi runtime assemblies", () => {
  test("restores a parent assembly when the child has a smaller active tool set", async () => {
    const parent = await resolvePiRuntimeAssembly({
      tools: [tool("read", "aft"), tool("aft_outline", "aft"), tool("find")],
      activeTools: ["read", "aft_outline", "find"],
      hostVersion: "0.99.0",
    });
    const child = restorePiRuntimeAssembly(parent.request, parent.tools);
    expect(child.id).toBe(parent.id);
    expect(child.workerBundle.companionArtifacts).toEqual(
      parent.workerBundle.companionArtifacts,
    );
    expect(child.tools.map((item) => item.name)).toEqual(
      parent.tools.map((item) => item.name),
    );
  });

  test("rejects a changed inherited tool schema", async () => {
    const parent = await coreAssembly();
    const changed = parent.tools.map((item) =>
      item.name === "read"
        ? {
            ...item,
            parameters: { type: "object", properties: { changed: {} } },
          }
        : item,
    );
    expect(() => restorePiRuntimeAssembly(parent.request, changed)).toThrow(
      "contract does not match its ID",
    );
  });

  test("rejects unknown owners and non-plugin components in inherited assemblies", async () => {
    const parent = await coreAssembly();
    expect(() =>
      restorePiRuntimeAssembly(
        {
          ...parent.request,
          components: [
            ...parent.request.components,
            {
              id: "unknown-plugin",
              kind: "plugin",
              contractVersion: "1",
              version: "1.0.0",
            },
          ],
        },
        parent.tools,
      ),
    ).toThrow("Unsupported inherited Pi plugin contract");
    expect(() =>
      restorePiRuntimeAssembly(
        {
          ...parent.request,
          components: [
            ...parent.request.components,
            {
              id: "extra-host",
              kind: "host",
              contractVersion: "1",
              version: "1.0.0",
            },
          ],
        },
        parent.tools,
      ),
    ).toThrow("Unsupported inherited Pi assembly component");
    expect(() =>
      restorePiRuntimeAssembly(
        {
          ...parent.request,
          tools: [
            ...parent.request.tools,
            { name: "unknown_core_tool", owner: PI_CORE_COMPONENT_ID },
          ],
        },
        [...parent.tools, { ...parent.tools[0]!, name: "unknown_core_tool" }],
      ),
    ).toThrow("not a supported Pi core tool");
  });
});

describe("Pi session state isolation", () => {
  test("keeps parent and in-process child remote state separate", async () => {
    const { getPiRemoteStateForSession } =
      await import("../src/pi/host-extension.ts");
    const parentBus = {};
    const childBus = {};
    const parent = getPiRemoteStateForSession(parentBus);
    const child = getPiRemoteStateForSession(childBus);

    parent.selected = true;
    parent.cwd = "/remote/parent";
    child.selected = false;
    child.cwd = "/remote/child";

    expect(getPiRemoteStateForSession(parentBus)).toBe(parent);
    expect(getPiRemoteStateForSession(childBus)).toBe(child);
    expect(child).not.toBe(parent);
    expect(parent.cwd).toBe("/remote/parent");
    expect(child.cwd).toBe("/remote/child");

    parent.selected = false;
    parent.cwd = undefined;
    child.selected = false;
    child.cwd = undefined;
  });
});

type TestPiMock = {
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  handlers: Map<string, (event?: unknown) => unknown>;
  tools: Map<string, Record<string, unknown>>;
  pi: Record<string, unknown>;
};

function createPiMock(
  initialTools: Array<Record<string, unknown>> = [],
): TestPiMock {
  const tools = new Map<string, Record<string, unknown>>(
    initialTools.map((tool) => [String(tool.name), tool]),
  );
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => unknown }
  >();
  const handlers = new Map<string, (event?: unknown) => unknown>();
  const controlSource = { source: "extension", path: "pi-ssh-remote" };
  const pi = {
    events: {},
    registerTool(tool: Record<string, unknown>) {
      tools.set(String(tool.name), tool);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: unknown) => unknown },
    ) {
      commands.set(name, command);
    },
    on(name: string, handler: (event?: unknown) => unknown) {
      handlers.set(name, handler);
    },
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        ...tool,
        sourceInfo: tool.sourceInfo ?? controlSource,
      }));
    },
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendUserMessage() {},
  };
  return { commands, handlers, tools, pi };
}

describe("inherited child ownership", () => {
  test("refuses a child entry without a parent connection spec", async () => {
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    await piTintinExtension(mock.pi as never);

    expect(state.isInheritedChild).toBe(true);
    expect(state.selected).toBe(true);
    expect(state.connectionError).toContain("requires a valid inherited");
    const remoteConnect = mock.tools.get("remote_connect") as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    await expect(
      remoteConnect.execute("child-connect", { target: "gpu-box" }),
    ).rejects.toThrow("can only restore a parent");
  });

  test("checks only workspace tools active in the child allowlist", () => {
    const extensionSource = { source: "extension", path: "pi-ssh-remote" };
    const allTools = [
      { name: "remote_workspace_status", sourceInfo: extensionSource },
      { name: "read", sourceInfo: extensionSource },
      { name: "aft_outline", sourceInfo: { source: "builtin", path: "local" } },
    ];
    const readyTools = [
      { name: "read", description: "read" },
      { name: "aft_outline", description: "outline" },
    ];

    expect(
      getPiRemoteOwnershipErrors(
        allTools as never,
        readyTools,
        new Set(["read"]),
      ),
    ).toEqual([]);
    expect(
      getPiRemoteOwnershipErrors(
        allTools as never,
        readyTools,
        new Set(["read", "aft_outline"]),
      ),
    ).toEqual(["aft_outline"]);
    expect(
      getPiRemoteOwnershipErrors(
        allTools.slice(1) as never,
        readyTools,
        new Set(["read"]),
      ),
    ).toEqual(["read"]);
    expect(
      getPiRemoteOwnershipErrors([], readyTools, new Set(["read"])),
    ).toEqual(["read"]);
  });

  test("a non-owner cannot clear the parent connection spec", async () => {
    const assembly = await coreAssembly();
    const spec = {
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    };
    publishPiTintinSubagentConnectionSpec(spec);
    clearPiTintinSubagentConnectionSpec("other-root");
    expect(readPiTintinSubagentConnectionSpec()).toEqual(spec);
  });

  test("restoration failures leave an inherited child selected and fail-closed", async () => {
    const assembly = await coreAssembly();
    publishPiTintinSubagentConnectionSpec({
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools.map((tool) =>
        tool.name === "read" ? { ...tool, owner: "tampered-owner" } : tool,
      ),
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    await piTintinExtension(mock.pi as never);
    await mock.handlers.get("session_start")?.();

    expect(state.selected).toBe(true);
    expect(state.isInheritedChild).toBe(true);
    expect(state.ownershipVerified).toBe(false);
    expect(state.scope).toBeUndefined();
    expect(state.connectionError).toContain("owner mismatch");
  });

  test("pre-start child shutdown preserves the parent connection spec", async () => {
    const assembly = await coreAssembly();
    const spec = {
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    };
    publishPiTintinSubagentConnectionSpec(spec);
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    await piTintinExtension(mock.pi as never);

    expect(state.isInheritedChild).toBe(true);
    await mock.handlers.get("session_shutdown")?.({ reason: "quit" });

    expect(readPiTintinSubagentConnectionSpec()).toEqual(spec);
  });

  test("does not consume inherited state after child remote-exit disables inheritance", async () => {
    const assembly = await coreAssembly();
    publishPiTintinSubagentConnectionSpec({
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    state.inheritanceDisabled = true;
    await piTintinExtension(mock.pi as never);
    await mock.handlers.get("session_start")?.();

    expect(state.selected).toBe(false);
    expect(state.scope).toBeUndefined();
    expect(state.connectionError).toBeUndefined();
  });

  test("child remote-exit preserves the parent spec and prevents re-inheritance", async () => {
    const assembly = await coreAssembly();
    const spec = {
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    };
    publishPiTintinSubagentConnectionSpec(spec);
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    state.selected = true;
    state.isInheritedChild = true;
    await piTintinExtension(mock.pi as never);

    await mock.commands.get("remote-exit")?.handler("", {
      reload: async () => {},
      ui: { notify: () => {} },
    });

    expect(state.inheritanceDisabled).toBe(true);
    expect(state.isInheritedChild).toBe(true);
    expect(readPiTintinSubagentConnectionSpec()).toEqual(spec);

    await mock.handlers.get("session_shutdown")?.({ reason: "quit" });
    expect(readPiTintinSubagentConnectionSpec()).toEqual(spec);
  });
});

describe("tintin connection spec validation", () => {
  test("rejects empty and invalid JSON instead of treating it as local state", async () => {
    process.env[OWNER_KEY] = OWNER_TOKEN;
    process.env[ENV_KEY] = "";
    expect(() => readPiTintinSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );

    process.env[ENV_KEY] = "{";
    expect(() => readPiTintinSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );

    process.env[ENV_KEY] = JSON.stringify({
      ownerToken: OWNER_TOKEN,
      assembly: { id: "empty", components: [], tools: [] },
      tools: [],
      connectOptions: { target: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    expect(() => readPiTintinSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );
  });

  test("rejects an assembly with no admitted tools", async () => {
    const assembly = await coreAssembly();
    process.env[ENV_KEY] = JSON.stringify({
      ownerToken: OWNER_TOKEN,
      assembly: { ...assembly.request, tools: [] },
      tools: [],
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    expect(() => readPiTintinSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );
  });
});
