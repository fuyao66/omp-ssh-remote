import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DebugTool } from "@oh-my-pi/pi-coding-agent/tools/debug";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import {
  OMP_VERSION,
  REMOTE_TOOL_NAMES,
  type RemoteToolName,
} from "./protocol.ts";
import { pathShouldStayLocal } from "./path-domain.ts";
export interface RemoteNativeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    context?: unknown,
  ): Promise<unknown>;
}

function asRemoteNativeTool(
  tool:
    | ReadTool
    | WriteTool
    | EditTool
    | BashTool
    | GlobTool
    | GrepTool
    | LspTool
    | AstGrepTool
    | AstEditTool
    | EvalTool
    | DebugTool,
): RemoteNativeTool {
  return tool as unknown as RemoteNativeTool;
}

type PendingInvoker = {
  id: string;
  sourceToolName: string;
  onInvoked: (input: unknown) => Promise<unknown> | unknown;
};

class PendingInvokerQueueAdapter {
  #pending: PendingInvoker[] = [];

  registerPendingInvoker(
    id: string,
    sourceToolName: string,
    onInvoked: PendingInvoker["onInvoked"],
  ): void {
    this.removePendingInvoker(id);
    this.#pending.push({ id, sourceToolName, onInvoked });
  }

  removePendingInvoker(id: string): void {
    this.#pending = this.#pending.filter((entry) => entry.id !== id);
  }

  clearPendingInvokers(): void {
    this.#pending = [];
  }

  peekPendingInvoker(): PendingInvoker["onInvoked"] | undefined {
    return this.#pending.at(-1)?.onInvoked;
  }
}

const WORKER_OVERRIDES = {
  "async.enabled": false,
  "bash.autoBackground.enabled": false,
  "bash.direnv": "auto",
  "lsp.enabled": true,
  "lsp.lazy": true,
  "lsp.shared": false,
  "lsp.formatOnWrite": false,
  "lsp.diagnosticsOnWrite": true,
  "lsp.diagnosticsOnEdit": false,
  "memory.backend": "off",
  "eval.py": true,
  "eval.js": true,
  "eval.rb": false,
  "eval.jl": false,
  "tools.xdev": false,
} as const;

export type NativeWorkerRuntime = {
  cwd: string;
  tools: Readonly<Record<RemoteToolName, RemoteNativeTool>>;
  session: ToolSession;
};

export async function createNativeWorkerRuntime(
  cwd: string,
): Promise<NativeWorkerRuntime> {
  const resolvedCwd = resolve(cwd);
  const cwdStat = await stat(resolvedCwd);
  if (!cwdStat.isDirectory())
    throw new Error(`Remote cwd is not a directory: ${cwd}`);
  const absoluteCwd = await realpath(resolvedCwd);
  const settings = Settings.isolated(WORKER_OVERRIDES);
  const mutationVersions = new Map<string, number>();
  const pendingInvokers = new PendingInvokerQueueAdapter();
  const xdevTools = new Map<string, RemoteNativeTool>();
  const xdevMountedNames = new Set<string>(["lsp", "ast_grep", "ast_edit"]);
  const callableTools = new Map<string, RemoteNativeTool>();
  const session: ToolSession = {
    cwd: absoluteCwd,
    hasUI: false,
    enableLsp: true,
    enableIrc: false,
    enableMCP: false,
    hasEditTool: true,
    restrictToolNames: true,
    settings,
    getSessionFile: () => null,
    getSessionSpawns: () => "",
    getSessionId: () => `omp-ssh-remote:${OMP_VERSION}`,
    getArtifactsDir: () => null,
    xdev: {
      tools: xdevTools,
      mountedNames: xdevMountedNames,
      builtInNames: new Set(xdevMountedNames),
      isActive: (name) => REMOTE_TOOL_NAMES.includes(name as (typeof REMOTE_TOOL_NAMES)[number]),
    } as NonNullable<ToolSession["xdev"]>,
    getFileMutationVersion: (path) => mutationVersions.get(path) ?? 0,
    bumpFileMutationVersion: (path) => {
      const next = (mutationVersions.get(path) ?? 0) + 1;
      mutationVersions.set(path, next);
      return next;
    },
    isToolActive: (name) => REMOTE_TOOL_NAMES.includes(name as (typeof REMOTE_TOOL_NAMES)[number]),
    getToolByName: (name) =>
      callableTools.get(name) as unknown as ReturnType<
        NonNullable<ToolSession["getToolByName"]>
      >,
    getToolChoiceQueue: () =>
      pendingInvokers as unknown as ReturnType<
        NonNullable<ToolSession["getToolChoiceQueue"]>
      >,
    peekPendingInvoker: () => pendingInvokers.peekPendingInvoker(),
    clearPendingInvokers: () => pendingInvokers.clearPendingInvokers(),
  };

  const tools: Record<RemoteToolName, RemoteNativeTool> = {
    read: asRemoteNativeTool(new ReadTool(session)),
    write: asRemoteNativeTool(new WriteTool(session)),
    edit: asRemoteNativeTool(new EditTool(session)),
    bash: asRemoteNativeTool(new BashTool(session)),
    grep: asRemoteNativeTool(new GrepTool(session)),
    glob: asRemoteNativeTool(new GlobTool(session, { rootPathAlias: true })),
    lsp: asRemoteNativeTool(new LspTool(session)),
    ast_grep: asRemoteNativeTool(new AstGrepTool(session)),
    ast_edit: asRemoteNativeTool(new AstEditTool(session)),
    eval: asRemoteNativeTool(new EvalTool(session)),
    debug: asRemoteNativeTool(new DebugTool(session)),
  };
  const evalCallableNames = REMOTE_TOOL_NAMES.filter(
    (name) => name !== "eval" && name !== "ast_edit",
  );
  for (const name of evalCallableNames) {
    const tool = tools[name];
    callableTools.set(name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(toolCallId, params, signal, onUpdate, context) {
        if (pathShouldStayLocal(name, params)) {
          throw new Error(
            `Eval tool.${name} cannot access local internal URIs from the remote runtime`,
          );
        }
        return tool.execute(toolCallId, params, signal, onUpdate, context);
      },
    });
  }
  for (const name of xdevMountedNames)
    xdevTools.set(name, tools[name as RemoteToolName]);
  return { cwd: absoluteCwd, tools, session };
}
