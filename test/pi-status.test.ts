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
});
