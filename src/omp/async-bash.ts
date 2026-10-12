import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resolve } from "node:path";
import { clampTimeout } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

/**
 * Bridge OMP `bash async:true` onto the remote companion.
 *
 * Ownership model: the LOCAL AsyncJobManager owns the job (id, status, delivery,
 * cancel, `proc://` inspection and native `wait`). The remote companion runs
 * the command as an ordinary foreground request; its updates become job
 * progress and its final result becomes the job result. Local cancellation or
 * session teardown aborts the signal and sends the existing `cancel` frame.
 * Transport loss rejects the pending request, so the job fails closed — there
 * is no detached remote process and nothing to reconnect to.
 */

export interface RemoteAsyncBashExecutor {
  (
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
  ): Promise<AgentToolResult>;
}

export interface RemoteAsyncBashJobOptions {
  manager: AsyncJobManager;
  ownerId: string | undefined;
  command: string;
  params: Record<string, unknown>;
  remoteCwd: string;
  maxTimeout?: number;
  execute: RemoteAsyncBashExecutor;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(result: unknown): string {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => asRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Resolve the OMP agent id that owns jobs for the given session file. Both the
 * main session and task children register in AgentRegistry with their session
 * file, so the match is exact. A single-agent process resolves to Main even if
 * the registry has no session file yet (e.g. very early startup).
 */
export function resolveJobOwnerId(
  sessionFile: string | undefined,
  registry: AgentRegistry = AgentRegistry.global(),
): string | undefined {
  const refs = registry.list();
  if (sessionFile) {
    const match = refs.find((ref) => ref.sessionFile === sessionFile);
    if (match) return match.id;
  }
  if (refs.length === 0) return MAIN_AGENT_ID;
  if (refs.length === 1) return refs[0]?.id;
  return undefined;
}

export function resolveLocalAsyncJobManager(
  sessionFile: string | undefined,
  registry: AgentRegistry = AgentRegistry.global(),
): AsyncJobManager | undefined {
  if (!sessionFile) return undefined;
  const normalized = resolve(sessionFile);
  return registry.list().find(
    (ref) => ref.sessionFile && resolve(ref.sessionFile) === normalized,
  )?.session?.asyncJobManager;
}

/**
 * Register a local job that drives one remote foreground bash execution and
 * return the immediate "backgrounded" tool result that OMP's native BashTool
 * would produce for `async:true`.
 */
export function startRemoteAsyncBashJob(
  options: RemoteAsyncBashJobOptions,
): AgentToolResult {
  const { manager, ownerId, command, params, remoteCwd, execute } = options;
  const label =
    command.length > 120 ? `${command.slice(0, 117)}...` : command;
  const remoteParams: Record<string, unknown> = { ...params };
  delete remoteParams.async;
  const timeoutSeconds = params.timeout === 0 ? undefined : clampTimeout(
    "bash", typeof params.timeout === "number" ? params.timeout : undefined, options.maxTimeout,
  );
  remoteParams.timeout = timeoutSeconds ?? 0;

  const jobId = manager.register(
    "bash",
    label,
    async ({ jobId, signal, reportProgress }) => {
      const result = await execute(remoteParams, signal, (update) => {
        const text = textOf(update);
        if (text)
          void reportProgress(text, {
            async: { state: "running", jobId, type: "bash" },
            remoteCwd,
          });
      });
      const text = textOf(result);
      if (asRecord(result).isError === true) {
        await reportProgress(text, {
          async: { state: "failed", jobId, type: "bash" },
          remoteCwd,
        });
        throw new Error(text || `Remote bash job ${jobId} failed`);
      }
      await reportProgress(text, {
        async: { state: "completed", jobId, type: "bash" },
        remoteCwd,
      });
      return text;
    },
    { ownerId },
  );

  const details: Record<string, unknown> = {
    async: { state: "running", jobId, type: "bash" },
    remoteCwd,
  };
  if (timeoutSeconds === undefined) details.timeoutDisabled = true;
  else details.timeoutSeconds = timeoutSeconds;

  return {
    content: [
      {
        type: "text",
        text: `Remote (${remoteCwd}): ${formatBackgroundNotice(jobId, timeoutSeconds)}`,
      },
    ],
    details,
  };
}
