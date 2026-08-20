import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPiWorkspaceStatus,
  getPiRemoteState,
  type PiRemoteExtensionState,
} from "../src/pi/host-extension.ts";
import type { ReadyMessage } from "../src/protocol.ts";

function readyWithTools(...names: string[]): ReadyMessage {
  return {
    type: "ready",
    protocolVersion: 1,
    host: "pi",
    hostVersion: "0.84.2",
    toolRuntimeVersion: "0.1.0",
    cwd: "/remote/project",
    tools: names.map((name) => ({
      name,
      description: `${name} description`,
      parameters: { type: "object", properties: {} },
    })),
  };
}

afterEach(() => {
  const state = getPiRemoteState();
  state.selected = false;
  state.scope = undefined;
  state.profile = undefined;
  state.cwd = undefined;
  state.connectOptions = undefined;
  state.connectionError = undefined;
  state.ownershipVerified = undefined;
  state.ready = undefined;
  state.localActiveTools = undefined;
});

describe("Pi remote workspace status", () => {
  test("reports the local profile when disconnected", () => {
    const status = buildPiWorkspaceStatus({ selected: false });
    expect(status.mode).toBe("local");
    expect(status.transport).toBe("not-selected");
    expect(status.remoteWorkspaceTools).toEqual([]);
  });

  test("derives the remote surface from the verified ready manifest", () => {
    const state: PiRemoteExtensionState = {
      selected: true,
      cwd: "/remote/project",
      scope: { isClosed: false } as never,
      ownershipVerified: true,
      ready: readyWithTools("read", "find", "aft_outline", "bash_status"),
    };
    const status = buildPiWorkspaceStatus(state);
    expect(status.mode).toBe("remote");
    expect(status.remoteWorkspaceTools).toEqual([
      "read",
      "find",
      "aft_outline",
      "bash_status",
    ]);
    expect(status.profileToolGroups).toEqual([
      {
        id: "aft",
        displayName: "AFT plugin runtime",
        tools: ["read", "aft_outline", "bash_status"],
      },
      {
        id: "pi-native",
        displayName: "Pi native runtime",
        tools: ["find"],
      },
    ]);
    expect(status.routing.executionRuntime).toContain("headless Pi Agent");
  });

  test("fails closed until both transport and tool ownership are verified", () => {
    const status = buildPiWorkspaceStatus({
      selected: true,
      cwd: "/remote/project",
      scope: { isClosed: false } as never,
      ownershipVerified: false,
      ready: readyWithTools("read"),
      connectionError: "read is owned by AFT before Pi SSH Remote",
    });
    expect(status.mode).toBe("unavailable");
    expect(status.connectionError).toContain("owned by AFT");
    expect(status.remoteWorkspaceTools).toEqual([]);
  });

  test("registers the three control tools and commands without remote wrappers locally", async () => {
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
