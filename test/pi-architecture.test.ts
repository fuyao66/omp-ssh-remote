import { afterEach, describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  claimPiTintinSubagentConnectionSpec,
  clearPiTintinSubagentConnectionSpec,
  createTintinPiConnectionInheritance,
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
import {
  FFF_PLUGIN_ID,
  FFF_PLUGIN_ADAPTER,
} from "../src/pi/plugins/fff.ts";
import { PiRemoteWorkspaceScope } from "../src/pi/scope.ts";
import {
  filterStaleRemoteWrappers,
  getPiRemoteOwnershipErrors,
  getPiRemoteStateForSession,
  installPiRemoteExtension,
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
  source: "builtin" | "aft" | "fff" | "inline" | "unknown" = "builtin",
): PiToolSnapshot {
  const sourceInfo =
    source === "builtin"
      ? { source: "builtin", path: `<builtin:${name}>` }
      : source === "aft"
        ? { source: "local", path: aftEntry, baseDir: join(aftEntry, "..") }
        : source === "fff"
          ? {
              source: "inline",
              path: join(import.meta.dir, "../node_modules/@ff-labs/pi-fff/src/index.ts"),
            }
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

  test("admits explicit hook-only components and binds their configuration to identity", async () => {
    const packageVersion = (await Bun.file(join(aftEntry, "../../package.json")).json()).version;
    const adapter = {
      id: "example/workspace-hooks",
      packageName: AFT_PLUGIN_ID,
      displayName: "Workspace hooks",
      contractVersion: "1",
      remoteTools: new Set<string>(),
      companionArtifacts: [],
      matchesSource: () => false,
      resolveConfig: ({ captured }: { captured?: Record<string, unknown> }) => captured,
    };
    const options = {
      tools: [tool("bash")],
      hostVersion: "1.0.0",
      pluginAdapters: [adapter],
    };
    const declaration = { id: adapter.id, sourcePath: aftEntry, version: packageVersion, config: { enabled: true } };
    const selected = await resolvePiRuntimeAssembly({ ...options, managedPlugins: [declaration] });
    const unselected = await resolvePiRuntimeAssembly(options);
    const changed = await resolvePiRuntimeAssembly({ ...options, managedPlugins: [{ ...declaration, config: { enabled: false } }] });
    expect(selected.request.components.map(({ id }) => id)).toEqual([PI_CORE_COMPONENT_ID, adapter.id]);
    expect(selected.tools.map(({ owner }) => owner)).toEqual([PI_CORE_COMPONENT_ID]);
    expect(selected.id).not.toBe(unselected.id);
    expect(selected.id).not.toBe(changed.id);
    await expect(resolvePiRuntimeAssembly({ ...options, managedPlugins: [{ ...declaration, version: "forged" }] })).rejects.toThrow("provenance mismatch");
    await expect(resolvePiRuntimeAssembly({ ...options, managedPlugins: [declaration, declaration] })).rejects.toThrow("Duplicate managed");
    await expect(resolvePiRuntimeAssembly({ ...options, managedPlugins: [{ ...declaration, id: "unknown" }] })).rejects.toThrow("Unsupported managed");
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
      ["ls", PI_CORE_COMPONENT_ID],
      ["read", AFT_PLUGIN_ID],
    ]);
    expect([...assembly.handshake.requestedTools].sort()).toEqual(
      assembly.tools.map((item) => item.name).sort(),
    );
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
        hostVersion: "1.0.0",
      }),
    ).rejects.toThrow("unsupported extension");

    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("new_aft_tool", "aft")],
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
describe("Pi connection inheritance contract", () => {
  test("Tintin factory wraps existing env claim/publish ops", async () => {
    const inheritance = createTintinPiConnectionInheritance();
    const assembly = await coreAssembly();
    const spec = {
      ownerToken: OWNER_TOKEN,
      assembly: assembly.request,
      tools: assembly.tools,
      connectOptions: { target: "gpu-box", displayTarget: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    };

    expect(inheritance.hasSpec()).toBe(false);
    inheritance.publish(spec);
    expect(inheritance.hasSpec()).toBe(true);
    expect(inheritance.hasRootOwner()).toBe(true);
    expect(inheritance.read()).toEqual(spec);
    expect(readPiTintinSubagentConnectionSpec()).toEqual(spec);

    inheritance.clear("other-root");
    expect(inheritance.read()).toEqual(spec);
    inheritance.clear(OWNER_TOKEN);
    expect(inheritance.hasSpec()).toBe(false);
  });

  test("dedicated Tintin entry is root when inheritance env is absent", async () => {
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    await piTintinExtension(mock.pi as never);
    // Until host migrates options.inheritance, entry still passes inheritedChild=false.
    expect(state.isInheritedChild).toBeUndefined();
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

  test("does not let an unrelated default session inherit another root connection", async () => {
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
    expect(state.isInheritedChild).toBeUndefined();
    expect(state.inheritanceOwnerToken).toBeDefined();
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
      hostVersion: "0.84.2",
    });
    const second = await resolvePiRuntimeAssembly({
      tools,
      hostVersion: "9.0.0",
    });
    expect(first.id).toBe(second.id);
    expect(first.host.version).not.toBe(second.host.version);
  });

  test("derives plugin order from first appearance in the tool registry", async () => {
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
        hostVersion: "1.0.0",
      }),
    ).rejects.toThrow("unsupported source provenance");
  });
});

describe("Pi package provenance", () => {
  test("recognizes the inline source used by loaded Pi packages", async () => {
    const assembly = await resolvePiRuntimeAssembly({
      tools: [tool("aft_outline", "inline")],
      hostVersion: "1.0.0",
    });
    expect(assembly.plugins.map((plugin) => plugin.id)).toEqual([
      AFT_PLUGIN_ID,
    ]);
    expect(assembly.tools[0]?.owner).toBe(AFT_PLUGIN_ID);
  });
});

describe("FFF plugin assembly adapter", () => {
  test("admits default fffind/ffgrep tools with serializable config", async () => {
    const assembly = await resolvePiRuntimeAssembly({
      tools: [
        tool("read"),
        tool("fffind", "fff"),
        tool("ffgrep", "fff"),
        tool("find"),
      ],
      hostVersion: "1.0.0",
      pluginConfigs: {
        [FFF_PLUGIN_ID]: {
          mode: "tools-and-ui",
          followSymlinks: false,
        },
      },
    });

    expect(assembly.plugins.map((plugin) => plugin.id)).toEqual([FFF_PLUGIN_ID]);
    expect(assembly.tools.map(({ name, owner }) => [name, owner])).toEqual([
      ["fffind", FFF_PLUGIN_ID],
      ["ffgrep", FFF_PLUGIN_ID],
      ["find", PI_CORE_COMPONENT_ID],
      ["read", PI_CORE_COMPONENT_ID],
    ]);
    expect(assembly.request.components[1]?.config).toEqual({
      mode: "tools-and-ui",
      followSymlinks: false,
    });
    expect(FFF_PLUGIN_ADAPTER.remoteTools.has("multi_grep")).toBe(true);
  });

  test("admits override find/grep and optional multi_grep", async () => {
    const assembly = await resolvePiRuntimeAssembly({
      tools: [
        tool("find", "fff"),
        tool("grep", "fff"),
        tool("multi_grep", "fff"),
        tool("bash"),
      ],
      hostVersion: "1.0.0",
      pluginConfigs: {
        [FFF_PLUGIN_ID]: { mode: "override", multiGrep: true },
      },
    });

    expect(assembly.plugins[0]?.config).toEqual({
      mode: "override",
      multiGrep: true,
    });
    expect(assembly.tools.map(({ name, owner }) => [name, owner])).toEqual([
      ["bash", PI_CORE_COMPONENT_ID],
      ["find", FFF_PLUGIN_ID],
      ["grep", FFF_PLUGIN_ID],
      ["multi_grep", FFF_PLUGIN_ID],
    ]);
  });

  test("rejects missing or invalid captured FFF mode", async () => {
    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("fffind", "fff"), tool("ffgrep", "fff")],
        hostVersion: "1.0.0",
      }),
    ).rejects.toThrow("host-captured effective configuration");

    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("fffind", "fff"), tool("ffgrep", "fff")],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: { followSymlinks: true },
        },
      }),
    ).rejects.toThrow('"mode" must be one of');

    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("fffind", "fff"), tool("ffgrep", "fff")],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: { mode: "nope" },
        },
      }),
    ).rejects.toThrow('"mode" must be one of');

    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("fffind", "fff"), tool("ffgrep", "fff")],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: {
            mode: "tools-and-ui",
            frecencyDbPath: "/tmp/ignored",
          },
        },
      }),
    ).rejects.toThrow("unsupported key");
  });

  test("rejects mixed default/override FFF tools and multiGrep mismatches", async () => {
    await expect(
      resolvePiRuntimeAssembly({
        tools: [
          tool("fffind", "fff"),
          tool("ffgrep", "fff"),
          tool("find", "fff"),
        ],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: { mode: "tools-and-ui" },
        },
      }),
    ).rejects.toThrow("mix default and override");

    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("fffind", "fff"), tool("ffgrep", "fff")],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: { mode: "override" },
        },
      }),
    ).rejects.toThrow("override mode cannot expose default tools");

    await expect(
      resolvePiRuntimeAssembly({
        tools: [
          tool("find", "fff"),
          tool("grep", "fff"),
          tool("multi_grep", "fff"),
        ],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: { mode: "override" },
        },
      }),
    ).rejects.toThrow("must set multiGrep=true");
  });

  test("fails closed on unknown FFF-sourced tools", async () => {
    await expect(
      resolvePiRuntimeAssembly({
        tools: [tool("fff_unknown", "fff")],
        hostVersion: "1.0.0",
        pluginConfigs: {
          [FFF_PLUGIN_ID]: { mode: "tools-and-ui" },
        },
      }),
    ).rejects.toThrow("not admitted by its remote adapter");
  });

  test("hashes and restores component config", async () => {
    const parent = await resolvePiRuntimeAssembly({
      tools: [tool("fffind", "fff"), tool("ffgrep", "fff")],
      hostVersion: "1.0.0",
      pluginConfigs: {
        [FFF_PLUGIN_ID]: {
          mode: "tools-only",
          enableHomeDirScanning: false,
        },
      },
    });
    const withoutConfig = {
      ...parent.request,
      components: parent.request.components.map((component) => {
        const { config: _config, ...rest } = component;
        return rest;
      }),
    };
    expect(() => restorePiRuntimeAssembly(withoutConfig, parent.tools)).toThrow(
      "contract does not match its ID",
    );

    const restored = restorePiRuntimeAssembly(parent.request, parent.tools);
    expect(restored.id).toBe(parent.id);
    expect(restored.plugins[0]?.config).toEqual({
      mode: "tools-only",
      enableHomeDirScanning: false,
    });
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
  test("restores a parent assembly with the full verified tool surface", async () => {
    const parent = await resolvePiRuntimeAssembly({
      tools: [tool("read", "aft"), tool("aft_outline", "aft"), tool("find")],
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
    events: createEventBus(),
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
    getCommands() {
      return [...commands.keys()].map((name) => ({ name, source: "extension", sourceInfo: controlSource }));
    },
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendUserMessage() {},
  };
  return { commands, handlers, tools, pi };
}

test("rejects an unmanaged RTK hook before opening any remote workspace", async () => {
  const mock = createPiMock();
  mock.pi.getCommands = () => [{ name: "rtk:2", source: "extension", sourceInfo: { path: "/plugins/pi-rtk-optimizer/index.ts" } }];
  await installPiRemoteExtension(mock.pi as never);
  const connect = mock.tools.get("remote_connect") as { execute: (id: string, args: unknown) => Promise<unknown> };
  await expect(connect.execute("reject-rtk", { target: "unused-host" })).rejects.toThrow("managed pi-rtk-extension");
  const state = getPiRemoteStateForSession(mock.pi.events as object);
  expect(state.selected).toBe(false);
  expect(state.scope).toBeUndefined();
});

describe("inherited child ownership", () => {
  test("refuses an explicit child entry without a parent connection spec", async () => {
    const mock = createPiMock();
    const state = getPiRemoteStateForSession(mock.pi.events as object);
    await installPiRemoteExtension(mock.pi as never, { inheritedChild: true });

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
