import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  clearPiSubagentConnectionSpec,
  publishPiSubagentConnectionSpec,
  readPiSubagentConnectionSpec,
} from "../src/pi/integrations/pi-subagents.ts";
import {
  DEFAULT_PI_PROFILE,
  getPiRuntimeProfile,
  listPiRuntimeProfiles,
} from "../src/pi/profiles/index.ts";
import { PI_AFT_PROFILE } from "../src/pi/profiles/pi-aft.ts";
import { PiRemoteWorkspaceScope } from "../src/pi/scope.ts";
import piRemoteExtension, {
  getPiRemoteState,
} from "../src/pi/host-extension.ts";

const ENV_KEY = "PI_REMOTE_CONNECTION_SPEC";

const inheritedSpec = {
  profileId: PI_AFT_PROFILE.id,
  connectOptions: {
    target: "gpu-box",
    displayTarget: "gpu-box",
    identityFile: "/tmp/id",
    port: 22,
  },
  workerPath: "/remote/worker",
  cwd: "/remote/project",
};

afterEach(() => clearPiSubagentConnectionSpec());

describe("Pi runtime profiles", () => {
  test("registers the version-locked Pi+AFT profile as the default", () => {
    expect(listPiRuntimeProfiles()).toEqual([PI_AFT_PROFILE]);
    expect(DEFAULT_PI_PROFILE).toBe(PI_AFT_PROFILE);
    expect(getPiRuntimeProfile("pi-aft")).toBe(PI_AFT_PROFILE);
    expect(() => getPiRuntimeProfile("unknown-profile")).toThrow(
      "Unknown Pi remote runtime profile",
    );
  });

  test("rejects tools outside the active profile before transport", async () => {
    let invoked = false;
    const scope = Object.create(PiRemoteWorkspaceScope.prototype) as {
      profile: typeof PI_AFT_PROFILE;
      client: { execute(): Promise<never> };
      execute: PiRemoteWorkspaceScope["execute"];
    };
    Object.assign(scope, {
      profile: PI_AFT_PROFILE,
      client: {
        async execute(): Promise<never> {
          invoked = true;
          throw new Error("transport must not run");
        },
      },
    });

    expect(() => scope.execute("workflow_control", "call", {})).toThrow(
      "not admitted by Pi profile pi-aft",
    );
    expect(invoked).toBe(false);
  });
});

describe("pi-subagents integration", () => {
  test("round-trips an inherited profile and connection scope", () => {
    publishPiSubagentConnectionSpec(inheritedSpec);
    expect(readPiSubagentConnectionSpec()).toEqual(inheritedSpec);
  });

  test("rejects malformed and unknown-profile inheritance", () => {
    process.env[ENV_KEY] = JSON.stringify({
      ...inheritedSpec,
      profileId: "bad",
    });
    expect(() => readPiSubagentConnectionSpec()).toThrow(
      "Unknown Pi remote runtime profile",
    );

    process.env[ENV_KEY] = JSON.stringify({ profileId: "pi-aft" });
    expect(() => readPiSubagentConnectionSpec()).toThrow(
      "Invalid inherited Pi remote connection specification",
    );
  });

  test("closes an inherited scope when remote ownership verification fails", async () => {
    publishPiSubagentConnectionSpec(inheritedSpec);
    const state = getPiRemoteState();
    state.selected = false;
    state.scope = undefined;
    state.ready = undefined;
    state.profile = undefined;
    state.connectionError = undefined;
    state.ownershipVerified = undefined;

    let closed = false;
    const ready = {
      type: "ready",
      protocolVersion: 1,
      host: "pi",
      hostVersion: "0.84.2",
      toolRuntimeVersion: "0.1.0",
      cwd: inheritedSpec.cwd,
      tools: [
        {
          name: "read",
          description: "remote read",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as const;
    const open = spyOn(PiRemoteWorkspaceScope, "open").mockResolvedValue({
      ready,
      isClosed: false,
      async close(force: boolean) {
        expect(force).toBe(true);
        closed = true;
      },
    } as never);

    const tools = new Map<string, Record<string, unknown>>();
    const handlers = new Map<string, Array<() => Promise<void>>>();
    const pi = {
      registerTool(tool: Record<string, unknown>) {
        tools.set(tool.name as string, tool);
      },
      registerCommand() {},
      on(name: string, handler: () => Promise<void>) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      getAllTools() {
        return [...tools.keys()].map((name) => ({
          name,
          sourceInfo: {
            source: "extension",
            path: name === "read" ? "aft" : "pi-ssh-remote",
          },
        }));
      },
      getActiveTools() {
        return [...tools.keys()];
      },
      setActiveTools() {},
      sendUserMessage() {},
    };

    try {
      await piRemoteExtension(pi as never);
      await handlers.get("session_start")?.[0]?.();
      expect(closed).toBe(true);
      expect(state.selected).toBe(true);
      expect(state.scope).toBeUndefined();
      expect(state.ready).toBeUndefined();
      expect(state.ownershipVerified).toBe(false as never);
      expect(state.connectionError ?? "").toContain("ownership check failed");
    } finally {
      open.mockRestore();
      state.selected = false;
      state.scope = undefined;
      state.ready = undefined;
      state.profile = undefined;
      state.connectionError = undefined;
      state.ownershipVerified = undefined;
    }
  });
});
