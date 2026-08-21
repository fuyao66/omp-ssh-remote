import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  clearPiSubagentConnectionSpec,
  publishPiSubagentConnectionSpec,
  readPiSubagentConnectionSpec,
} from "../src/pi/integrations/pi-subagents.ts";
import {
  PI_CORE_COMPONENT_ID,
  PI_CORE_TOOL_NAMES,
  resolvePiRuntimeAssembly,
  type PiRuntimeAssembly,
  type PiToolSnapshot,
} from "../src/pi/assembly.ts";
import { AFT_PLUGIN_ID } from "../src/pi/plugins/aft.ts";
import { PiRemoteWorkspaceScope } from "../src/pi/scope.ts";

const ENV_KEY = "PI_REMOTE_CONNECTION_SPEC";
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

afterEach(() => clearPiSubagentConnectionSpec());

describe("Pi runtime assembly resolver", () => {
  test("builds a pure Pi assembly without plugin artifacts", async () => {
    const assembly = await coreAssembly();
    expect(assembly.displayName).toBe("Pi");
    expect(assembly.host.version).toBe("0.99.0");
    expect(assembly.plugins).toEqual([]);
    expect(assembly.workerBundle.companionArtifacts).toEqual([]);
    expect(assembly.tools.map(({ name, owner }) => [name, owner])).toEqual(
      [...PI_CORE_TOOL_NAMES]
        .sort()
        .map((name) => [name, PI_CORE_COMPONENT_ID]),
    );
  });

  test("composes the detected AFT adapter with Pi-owned tools", async () => {
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

    expect(assembly.displayName).toBe("Pi + AFT");
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

describe("pi-subagents assembly inheritance", () => {
  test("round-trips the computed assembly and connection scope", async () => {
    const assembly = await coreAssembly();
    const inheritedSpec = {
      assembly: assembly.request,
      connectOptions: {
        target: "gpu-box",
        displayTarget: "gpu-box",
        identityFile: "/tmp/id",
        port: 22,
      },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    };
    publishPiSubagentConnectionSpec(inheritedSpec);
    expect(readPiSubagentConnectionSpec()).toEqual(inheritedSpec);
  });

  test("rejects malformed inherited assemblies", async () => {
    const assembly = await coreAssembly();
    process.env[ENV_KEY] = JSON.stringify({
      assembly: { ...assembly.request, components: [{ id: "broken" }] },
      connectOptions: { target: "gpu-box" },
      workerPath: "/remote/worker",
      cwd: "/remote/project",
    });
    expect(() => readPiSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );

    process.env[ENV_KEY] = JSON.stringify({ assembly: assembly.request });
    expect(() => readPiSubagentConnectionSpec()).toThrow(
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
