import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { describe, expect, test } from "bun:test";
import remoteRuntimeExtension, {
  remoteWrapperRenderer,
} from "../src/extension.ts";

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
      "remote-reconnect",
      "remote-status",
    ]);
    const status = tools.get("remote_workspace_status");
    const connect = tools.get("remote_connect");
    const exit = tools.get("remote_exit");
    const reconnect = tools.get("remote_reconnect");

    expect(status?.approval).toBe("read");
    expect(status?.loadMode).toBe("essential");
    expect(connect?.approval).toBe("exec");
    expect(connect?.loadMode).toBe("essential");
    expect(reconnect?.approval).toBe("exec");
    expect(reconnect?.loadMode).toBe("essential");
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
        cacheAudit: null,
        remoteWorkspaceTools: [],
        pendingRemoteAstProposals: 0,
        hostCompatibility: {
          installedHostVersion: null,
          compiledHostVersion: null,
          compatible: false,
          advice: expect.stringContaining("Could not determine the running OMP version"),
        },
        routing: {
          ordinaryFilesystemPaths: "local native tools",
          internalUris: "local control plane",
          controlPlane: "local control plane",
          asyncBash: "local OMP policy",
          hubProcesses: "local OMP policy",
          isolatedTasks: "local OMP policy",
        },
        note: "Current in-process SSH transport state only; this tool does not send an SSH health probe.",
      },
      useless: true,
    });
  });

  test("preserves native renderer metadata for workspace wrappers", async () => {
    const { toolRenderers } = await import(
      "@oh-my-pi/pi-tui/tools"
    );
    for (const name of [
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "glob",
      "lsp",
      "ast_grep",
      "ast_edit",
      "eval",
      "debug",
    ]) {
      expect(toolRenderers[name]).toBeDefined();
      expect(toolRenderers[name]?.renderCall).toBeFunction();
      expect(toolRenderers[name]?.renderResult).toBeFunction();
    }
    expect(remoteWrapperRenderer("bash")).toMatchObject({
      mergeCallAndResult: true,
      inline: true,
    });
  });

  test("preserves native approval decisions and bound cache-target callbacks", async () => {
    const tools = new Map<string, ToolDefinition>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const decision = { tier: "write", policy: "deny", reason: "native policy" } as const;
    const targets = ["/native/workspace/file"];
    const native = {
      name: "read",
      label: "Native read",
      loadMode: "discoverable",
      readsSkillUris: true,
      deferrable: false,
      strict: false,
      customWireName: "native_read",
      approval(args: unknown) {
        expect(this).toBe(native);
        expect(args).toEqual({ path: "file" });
        return decision;
      },
      approvalCacheTargets(args: unknown) {
        expect(this).toBe(native);
        expect(args).toEqual({ path: "file" });
        return targets;
      },
    };
    const sessionFile = `/tmp/approval-metadata-${crypto.randomUUID()}.jsonl`;
    const sessionManager = { getSessionFile: () => sessionFile };
    const registry = AgentRegistry.global();
    const ref = registry.register({
      id: `ApprovalMetadata-${crypto.randomUUID()}`,
      displayName: "approval metadata test",
      kind: "main",
      sessionFile,
      session: {
        sessionManager,
        getToolByName: () => native,
        async runToolRegistryMutation(mutate: () => Promise<void>) { await mutate(); },
      } as unknown as Parameters<AgentRegistry["register"]>[0]["session"],
    });
    const api = {
      registerCommand() {},
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { handlers.set(event, handler); },
      getActiveTools: () => ["read"],
      getAllTools: () => [{ name: "read", description: "Native description", parameters: {}, sourceInfo: { source: "builtin" } }],
    };
    try {
      await remoteRuntimeExtension(api as unknown as ExtensionAPI);
      await handlers.get("session_start")!({}, {
        cwd: "/native/workspace",
        sessionManager,
        ui: { notify() {} },
      });
      const wrapper = tools.get("read")!;
      expect(wrapper).toMatchObject({
        label: native.label,
        description: "Native description",
        loadMode: "discoverable",
        readsSkillUris: true,
        deferrable: false,
        strict: false,
        customWireName: "native_read",
      });
      expect(typeof wrapper.approval).toBe("function");
      expect((wrapper.approval as (args: unknown) => unknown)({ path: "file" })).toBe(decision);
      expect(wrapper.approvalCacheTargets?.({ path: "file" })).toBe(targets);
    } finally {
      registry.unregister(ref.id, ref);
    }
  });

  test("remote_reconnect fails closed when nothing is selected", async () => {
    const tools = new Map<string, ToolDefinition>();
    const api = {
      registerCommand() {},
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      on() {},
    };
    await remoteRuntimeExtension(api as unknown as ExtensionAPI);
    const reconnect = tools.get("remote_reconnect");
    expect(reconnect).toBeDefined();
    await expect(
      reconnect!.execute("call-1", {}, undefined as never, undefined, {
        ui: { notify() {}, setStatus() {} },
      } as never),
    ).rejects.toThrow("No remote runtime is selected");
  });
});
