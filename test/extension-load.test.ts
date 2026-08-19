import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import remoteRuntimeExtension from "../src/extension.ts";

describe("OMP extension loading", () => {
  test("registers commands and a model-visible status tool without a state handler", async () => {
    const commands = new Set<string>();
    const events = new Set<string>();
    const tools = new Map<string, ToolDefinition>();
    const api = {
      registerCommand(name: string) {
        commands.add(name);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      on(event: string) {
        events.add(event);
      },
    };

    await remoteRuntimeExtension(api as unknown as ExtensionAPI);

    expect([...commands].sort()).toEqual([
      "remote-connect",
      "remote-exit",
      "remote-status",
    ]);
    expect(events.has("context")).toBe(false);
    const status = tools.get("remote_workspace_status");
    const connect = tools.get("remote_connect");
    const exit = tools.get("remote_exit");

    expect(status?.approval).toBe("read");
    expect(status?.loadMode).toBe("essential");
    expect(connect?.approval).toBe("exec");
    expect(connect?.loadMode).toBe("essential");
    expect(exit?.approval).toBe("exec");
    expect(exit?.loadMode).toBe("essential");

    expect(
      await status?.execute("status-1", {}, undefined, undefined, {} as never),
    ).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining('"mode": "local"'),
        },
      ],
      details: {
        mode: "local",
        transport: "not-selected",
        remoteCwd: null,
        sessionRole: null,
        connectionError: null,
        remoteWorkspaceTools: [],
        pendingRemoteAstProposals: 0,
        routing: {
          ordinaryFilesystemPaths: "local native tools",
          internalUris: "local control plane",
          controlPlane: "local control plane",
          asyncBash: "local OMP policy",
          isolatedTasks: "local OMP policy",
        },
        note: "Current in-process SSH transport state only; this tool does not send an SSH health probe.",
      },
      useless: true,
    });
  });
});
