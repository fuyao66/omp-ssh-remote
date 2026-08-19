import { describe, expect, test } from "bun:test";
import {
  buildPiWorkspaceStatus,
  ALL_PI_REMOTE_TOOLS,
  type PiRemoteExtensionState,
} from "../src/pi-extension.ts";
import { AFT_EXTENDED_TOOLS } from "../src/pi-runtime.ts";

describe("Pi Remote Workspace Status & AFT Remote Forwarding", () => {
  test("builds local workspace status when disconnected", () => {
    const state: PiRemoteExtensionState = {
      selected: false,
    };
    const status = buildPiWorkspaceStatus(state);
    expect(status.mode).toBe("local");
    expect(status.transport).toBe("not-selected");
    expect(status.remoteCwd).toBeNull();
    expect(status.remoteWorkspaceTools).toEqual([]);
    expect(status.aftTools).toEqual([]);
    expect(status.routing.ordinaryFilesystemPaths).toContain("local native tools");
  });

  test("builds remote workspace status with ALL Pi and AFT tools when connected", () => {
    const mockClient = {
      isClosed: false,
    } as any;
    const state: PiRemoteExtensionState = {
      selected: true,
      cwd: "/root/work/project",
      client: mockClient,
      connectOptions: {
        target: "root@trialsfinder",
        displayTarget: "trialsfinder",
      },
    };
    const status = buildPiWorkspaceStatus(state);
    expect(status.mode).toBe("remote");
    expect(status.transport).toBe("connected");
    expect(status.remoteCwd).toBe("/root/work/project");
    expect(status.remoteWorkspaceTools).toEqual([...ALL_PI_REMOTE_TOOLS]);
    expect(status.aftTools).toEqual([...AFT_EXTENDED_TOOLS]);
    expect(status.routing.aftEngine).toContain("remote AFT daemon bridge");
    expect(status.routing.ordinaryFilesystemPaths).toContain("remote native runtime");
    expect(status.routing.subagents).toContain("automatic remote connection inheritance");
  });

  test("builds unavailable status on transport failure", () => {
    const state: PiRemoteExtensionState = {
      selected: true,
      cwd: "/root/work/project",
      client: undefined,
      connectionError: "SSH connection timed out",
    };
    const status = buildPiWorkspaceStatus(state);
    expect(status.mode).toBe("unavailable");
    expect(status.transport).toBe("unavailable");
    expect(status.connectionError).toBe("SSH connection timed out");
    expect(status.routing.ordinaryFilesystemPaths).toContain("fail-closed");
  });

  test("Pi extension registers remote_connect, remote_exit, and remote_workspace_status tools", async () => {
    const { default: piRemoteExtension } = await import("../src/pi-extension.ts");
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const mockPi = {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, cmd: any) {
        commands.set(name, cmd);
      },
    };
    await piRemoteExtension(mockPi as any);
    expect(tools.has("remote_workspace_status")).toBe(true);
    expect(tools.has("remote_connect")).toBe(true);
    expect(tools.has("remote_exit")).toBe(true);
    expect(commands.has("remote-connect")).toBe(true);
    expect(commands.has("remote-exit")).toBe(true);
    expect(commands.has("remote-status")).toBe(true);

    const exitRes = await tools.get("remote_exit").execute("id-1", {}, undefined, undefined, {});
    expect(exitRes.details).toEqual({ success: true, mode: "local" });
  });
});
