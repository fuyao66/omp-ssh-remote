import { describe, expect, test } from "bun:test";
import { agentLoopContinue, type AgentTool, type AgentToolResult, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import remoteRuntimeExtension from "../src/extension.ts";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { normalizePathArgument, pathShouldStayLocal } from "../src/path-domain.ts";
import { remoteWrapperApproval } from "../src/omp/approval-targets.ts";
import { workspaceAnnouncement } from "../src/omp/workspace-context.ts";
import { createRemoteArtifacts, mountRemoteArtifactScheme, resolveRemoteArtifacts } from "../src/omp/artifacts.ts";
import { startRemoteAsyncBashJob } from "../src/omp/async-bash.ts";

type Hook = (event: unknown, ctx: ExtensionContext) => unknown;
async function wrappers(cwd: string, originals: AgentTool<any>[] = []) {
  const definitions = new Map<string, ToolDefinition & Pick<AgentTool, "concurrency">>(), hooks = new Map<string, Hook>();
  const manager = SessionManager.inMemory(cwd);
  const sessionFile = join(cwd, `${crypto.randomUUID()}.jsonl`);
  const ctx = { cwd, sessionManager: { getSessionFile: () => sessionFile, getBranch: () => manager.getBranch() }, ui: { notify() {} } } as unknown as ExtensionContext;
  const registry = AgentRegistry.global();
  const ref = registry.register({ id: `Parity-${crypto.randomUUID()}`, displayName: "parity", kind: "main", sessionFile,
    session: { settings: Settings.isolated(), sessionManager: ctx.sessionManager,
      getToolByName: (name: string) => originals.find(tool => tool.name === name),
      runToolRegistryMutation: async (mutate: () => Promise<void>) => mutate(),
    } as never });
  try {
    await remoteRuntimeExtension({ registerCommand() {}, registerTool: (tool: ToolDefinition) => definitions.set(tool.name, tool),
      on: (name: string, hook: Hook) => hooks.set(name, hook), getActiveTools: () => originals.map(tool => tool.name),
      getAllTools: () => originals.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: { source: "builtin" } })),
    } as unknown as ExtensionAPI);
    await hooks.get("session_start")!({}, ctx);
    return { definitions, hooks, ctx, manager, close: async () => { await hooks.get("session_shutdown")!({}, ctx); registry.unregister(ref.id, ref); } };
  } catch (error) { registry.unregister(ref.id, ref); throw error; }
}

describe("native workspace parity", () => {
  test("native agent batch serializes wrapped write before read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-parity-batch-"));
    const session = { cwd, settings: Settings.isolated({ "lsp.enabled": false }) } as ToolSession;
    const writer = new WriteTool(session), reader = new ReadTool(session);
    let committed = false;
    const order: string[] = [];
    writer.execute = async () => { order.push("write-start"); await Promise.resolve(); committed = true; order.push("write-end"); return { content: [] }; };
    reader.execute = async () => { order.push(committed ? "read-after-write" : "read-too-early"); return { content: [] }; };
    const harness = await wrappers(cwd, [writer, reader]);
    try {
      const tools = [writer, reader].map(original => {
        const definition = harness.definitions.get(original.name)!;
        return wrapRegisteredTool({ definition, extensionPath: "parity" } as never, {
          getNativeDelegationGuidance: () => undefined,
          createContext: () => ({ ...harness.ctx, invokeTool: (params: { path: string; content: string }) => original.execute("delegated", params) }),
        } as never);
      });
      const stream = agentLoopContinue({ systemPrompt: [], tools, messages: [{ role: "assistant", content: [
        { type: "toolCall", id: "w", name: "write", arguments: { path: "file", content: "written" } },
        { type: "toolCall", id: "r", name: "read", arguments: { path: "file" } },
      ], stopReason: "toolUse", timestamp: Date.now() } as never] }, {
        model: { id: "fixture", api: "openai-responses", provider: "openai", contextWindow: 10000 } as never,
        convertToLlm: messages => messages as never, beforeModelCall: () => ({ stop: true }),
      });
      await stream.result();
      expect(order).toEqual(["write-start", "write-end", "read-after-write"]);
      expect(harness.definitions.get("write")!.concurrency).toBe("exclusive");
      expect(harness.definitions.get("write")).not.toHaveProperty("speculation");
    } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("wrapper concurrency resolver stays live and bound to the original", async () => {
    const native = { name: "bash", label: "bash", description: "fixture", parameters: new BashTool({ settings: Settings.isolated() } as ToolSession).parameters,
      concurrency(this: unknown) { expect(this).toBe(native); return "exclusive" as const; }, execute: async () => ({ content: [] }),
    };
    const harness = await wrappers(process.cwd(), [native]);
    try {
      const definition = harness.definitions.get("bash")!;
      expect((definition.concurrency as (args: unknown) => string)({})).toBe("exclusive");
      native.concurrency = function () { expect(this).toBe(native); return "shared" as never; };
      expect((definition.concurrency as (args: unknown) => string)({})).toBe("shared");
    } finally { await harness.close(); }
  });

  test("remote notice labels native environment blocks as local and remains deduplicated", () => {
    const manager = SessionManager.inMemory("/local");
    const current = { binding: "remote", mode: "remote" as const, target: "fixture.invalid", cwd: "/remote" };
    const notice = workspaceAnnouncement(current, manager.getBranch())!;
    expect(notice.content).toContain("Native workstation, repository, project-tree and date/cwd blocks describe the local machine");
    expect(notice.content).toContain("Workspace tools operate on the remote host.");
    manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
    expect(workspaceAnnouncement(current, manager.getBranch())).toBeUndefined();
  });

  test("native single-slash and prefixed local aliases share approval and execution ownership", () => {
    const router = InternalUrlRouter.instance();
    const metadata = remoteWrapperApproval("read", "read", () => ["local-target"], () => ({ selected: true, binding: "remote", proposalSources: [] }));
    for (const path of ["local:/x", "local://x", "/repo/local://x"]) {
      expect(normalizePathArgument(path)).toBe(router.normalize(path));
      expect(pathShouldStayLocal("read", { path })).toBe(true);
      expect(metadata.approvalCacheTargets({ path })).toEqual(["local-target"]);
    }
  });

  test("remote media bytes never retain a local TUI mediaPath", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-parity-media-"));
    const runtime = await createNativeWorkerRuntime(cwd);
    try {
      await writeFile(join(cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=", "base64"));
      const result = await runtime.tools.read.execute("media", { path: "pixel.png" }) as AgentToolResult;
      expect(result.content.some(part => part.type === "image")).toBe(true);
      expect(result.details).not.toHaveProperty("mediaPath");
    } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("native bash preapproval receives the unchanged active-tool context", () => {
    const bash = new BashTool({ cwd: process.cwd(), settings: Settings.isolated({ "bashInterceptor.enabled": true,
      "bashInterceptor.patterns": [{ pattern: "^cat ", tool: "read", message: "Use read instead" }],
    }) } as ToolSession);
    const metadata = remoteWrapperApproval("bash", bash.approval.bind(bash), undefined, () => ({ selected: true, binding: "remote", proposalSources: [] }));
    const context = { toolNames: ["read", "bash"] } as AgentToolContext;
    expect((metadata.approval as typeof bash.approval)({ command: "cat file" }, context)).toEqual(bash.approval({ command: "cat file" }, context));
    expect((metadata.approval as typeof bash.approval)({ command: "cat file" }, context)).toMatchObject({ policy: "deny" });
  });

  test("local correction uses the live context cwd after a move", async () => {
    const harness = await wrappers(process.cwd());
    try {
      harness.manager.appendCustomMessageEntry("remote-workspace-binding", "Previous remote", false, { binding: "old", mode: "remote", target: "old", cwd: "/old" });
      const ctx = { ...harness.ctx, cwd: "/moved/project" };
      const result = await harness.hooks.get("before_agent_start")!({}, ctx);
      expect(result).toMatchObject({ message: { details: { mode: "local", cwd: "/moved/project" } } });
    } finally { await harness.close(); }
  });

  test("native Eval callback validation preserves async Bash and returns a host job", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-parity-eval-"));
    const manager = new AsyncJobManager({ maxRunningJobs: 2 });
    const runtime = await createNativeWorkerRuntime(cwd, { invokeTool: async (name, _id, params) => {
      expect(name).toBe("bash");
      expect(params.async).toBe(true);
      return startRemoteAsyncBashJob({ manager, ownerId: "Main", command: String(params.command), params, remoteCwd: cwd,
        execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
    } });
    try {
      // Native Bash's open schema already preserves the host-owned async flag.
      const result = await callSessionTool("bash", { command: "printf done", async: true }, { session: runtime.session }) as { details: { async: { jobId: string } } };
      const job = manager.getJob(result.details.async.jobId)!;
      expect(job).toBeDefined();
      await job.promise;
      expect(job.status).toBe("completed");
    } finally { await runtime.dispose(); await manager.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("native Eval apply_patch and xd aliases dispatch the canonical edit tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-parity-alias-"));
    const runtime = await createNativeWorkerRuntime(cwd, { editMode: "apply_patch", settings: { "lsp.diagnosticsOnEdit": false },
      invokeTool: async (name, ...args) => { expect(name).toBe("edit"); return runtime.tools.edit.execute(...args); },
    });
    try {
      for (const [index, name] of ["apply_patch", "xd://apply_patch", "XD://edit"].entries()) {
        const result = await callSessionTool(name, { input: `*** Begin Patch\n*** Add File: alias-${index}.txt\n+created\n*** End Patch` }, { session: runtime.session });
        expect(JSON.stringify(result)).not.toContain('"hasError":true');
        expect(await readFile(join(cwd, `alias-${index}.txt`), "utf8")).toBe("created\n");
      }
    } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  test("native artifact reads retain immutable selectors and never register editable conflicts", async () => {
    mountRemoteArtifactScheme();
    const cwd = await mkdtemp(join(tmpdir(), "omp-parity-artifact-"));
    const runtime = await createNativeWorkerRuntime(cwd, { editMode: "hashline" });
    const store = await createRemoteArtifacts({ sweep: false });
    try {
      const file = await store.manager.allocatePath("read");
      await writeFile(file.path, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
      const uri = `remote-artifact://${store.namespace}/${file.id}`;
      const nativePath = await store.manager.getPath(file.id);
      expect(nativePath).not.toBeNull();
      expect(await resolveRemoteArtifacts(uri)).toBe(nativePath!);
      await expect(resolveRemoteArtifacts(`literal ${uri}`)).rejects.toThrow("Invalid remote artifact URL");
      const result = JSON.stringify(await runtime.tools.read.execute("immutable", { path: uri }));
      expect(result).toContain("ours");
      expect(result).not.toMatch(/#[A-F0-9]{4}\]/);
      expect(result).not.toContain("REMOTE CONFLICT REFERENCES");
      const selected = JSON.stringify(await runtime.tools.read.execute("selector", { path: `${uri}:2:raw` }));
      expect(selected).toContain("ours");
      expect(selected).not.toContain("theirs");
    } finally { await store.dispose(); await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
});
