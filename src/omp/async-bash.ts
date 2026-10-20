import { raceJobSettlement, resolveAutoBackgroundWaitMs } from "@oh-my-pi/pi-coding-agent/async";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resolve } from "node:path";
import { clampTimeout } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { RemoteJobCapture } from "./remote-capture.ts";
import type { JobCapturePayload } from "./job-capture.ts";

/**
 * Bridge OMP `bash async:true` onto the remote companion.
 *
 * Ownership model: the LOCAL AsyncJobManager owns the job (id, status, delivery,
 * cancel, `proc://` inspection and native `wait`). The remote companion runs
 * the command as a request-bound native execution. Genuine native capture
 * feeds the local process streams and widget inputs; rendered updates remain
 * progress only. Session teardown propagates the existing cancel frame.
 * Transport loss rejects the pending request, so the job fails closed — there
 * is no detached remote process and nothing to reconnect to.
 */

export interface RemoteAsyncBashExecutor {
  (
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    onCapture: (capture: JobCapturePayload) => void,
    scope?: "job" | "session",
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
  onUpdate?: (update: AgentToolResult) => void;
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

type RemoteJobCompletion =
  | { kind: "completed"; result: AgentToolResult }
  | { kind: "failed"; error: unknown };

function estimatedTimeoutSeconds(options: RemoteAsyncBashJobOptions): number | undefined {
  return options.params.timeout === 0 ? undefined : clampTimeout(
    "bash", typeof options.params.timeout === "number" ? options.params.timeout : undefined, options.maxTimeout,
  );
}

/** Both entry paths keep one remote request and the same native job/capture. */
function registerRemoteBashJob(options: RemoteAsyncBashJobOptions, foreground: boolean) {
  const { manager, ownerId, command, params, remoteCwd, execute } = options;
  const label = command.length > 120 ? `${command.slice(0, 117)}...` : command;
  const remoteParams: Record<string, unknown> = { ...params };
  delete remoteParams.async;
  // This estimate only bounds the local wait and labels the notice. The remote
  // native tool owns timeout enforcement and requested-timeout clamp notices.
  const timeoutSeconds = estimatedTimeoutSeconds(options);
  const completion = Promise.withResolvers<RemoteJobCompletion>();
  const capture = new RemoteJobCapture();
  let backgrounded = !foreground;
  let latestText = "";
  const jobId = manager.register(
    "bash",
    label,
    async ({ jobId, signal, reportProgress }) => {
      let ended = false;
      let latestDetails: Record<string, unknown> = {};
      const report = (
        text: string,
        state: "running" | "completed" | "failed" | "cancelled",
      ): Promise<void> => {
        if (ended || (state === "running" && signal.aborted))
          return Promise.resolve();
        if (state !== "running") ended = true;
        latestText = text;
        const details: Record<string, unknown> = {
          ...latestDetails,
          async: { state, jobId, type: "bash" },
          remoteCwd,
        };
        const reported = reportProgress(text, details);
        // Job listings retain output; the live card already renders the text.
        const { output: _output, ...frame } = details;
        const { async: _async, ...plain } = frame;
        options.onUpdate?.({
          content: [{ type: "text", text }],
          details: backgrounded ? frame : plain,
        });
        return reported;
      };
      try {
        const result = await execute(remoteParams, signal, (update) => {
          if (ended || signal.aborted) return;
          latestDetails = asRecord(asRecord(update).details);
          void report(textOf(update), "running");
        }, payload => {
          if (!ended && !signal.aborted) capture.apply(payload);
        }, foreground ? "session" : "job");
        const images = result.content.filter(block => block.type === "image");
        latestDetails = {
          ...asRecord(result.details),
          ...(images.length > 0 ? { images } : {}),
        };
        const text = textOf(result);
        if (signal.aborted)
          throw new ToolAbortError(text || `Remote bash job ${jobId} cancelled`);
        // Resolve, never reject: explicit-async callers do not consume this
        // handle. A native isError result still returns intact when foreground.
        completion.resolve({ kind: "completed", result });
        if (result.isError === true)
          throw new Error(text || `Remote bash job ${jobId} failed`);
        await report(text, "completed");
        return text;
      } catch (error) {
        completion.resolve({ kind: "failed", error });
        const message = error instanceof Error ? error.message : String(error);
        await report(message, signal.aborted ? "cancelled" : "failed");
        throw error;
      } finally {
        capture.close();
      }
    },
    {
      ownerId,
      foreground,
      process: { command, cwd: remoteCwd, pids: () => [], streams: capture.streams },
      widgetInputs: {
        sources: () => capture.sources(),
        brief: () => ({ kind: "bash", command, ...(typeof params.i === "string" ? { intent: params.i } : {}) }),
      },
    },
  );
  return {
    jobId,
    timeoutSeconds,
    completion: completion.promise,
    getLatestText: () => latestText,
    background: () => { backgrounded = true; },
  };
}

function backgroundNotice(
  options: RemoteAsyncBashJobOptions,
  job: ReturnType<typeof registerRemoteBashJob>,
  steering = false,
  previewText = "",
): AgentToolResult {
  const details: Record<string, unknown> = {
    async: { state: "running", jobId: job.jobId, type: "bash" },
    remoteCwd: options.remoteCwd,
  };
  if (job.timeoutSeconds === undefined) details.timeoutDisabled = true;
  else details.timeoutSeconds = job.timeoutSeconds;
  const lines: string[] = [];
  const preview = previewText.trimEnd();
  if (preview) lines.push(preview, "");
  if (steering) lines.push("Backgrounded early to handle an incoming message; the command keeps running.", "");
  lines.push(`Remote (${options.remoteCwd}): ${formatBackgroundNotice(job.jobId, job.timeoutSeconds)}`);
  return { content: [{ type: "text", text: lines.join("\n") }], details };
}

/** Explicit async work starts visible and never links to the caller's abort. */
export function startRemoteAsyncBashJob(options: RemoteAsyncBashJobOptions): AgentToolResult {
  const job = registerRemoteBashJob(options, false);
  return backgroundNotice(options, job);
}

/** Foreground wait over a request that can be promoted without restarting it. */
export async function runRemoteForegroundBashJob(
  options: RemoteAsyncBashJobOptions & {
    signal?: AbortSignal;
    steeringSignal?: AbortSignal;
    thresholdMs: number;
  },
): Promise<AgentToolResult> {
  const timeoutSeconds = estimatedTimeoutSeconds(options);
  const waitMs = resolveAutoBackgroundWaitMs(
    options.thresholdMs,
    timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
  );
  const job = registerRemoteBashJob(options, waitMs !== 0);
  if (waitMs === 0) return backgroundNotice(options, job);
  const outcome = await raceJobSettlement(job.completion, waitMs, options.signal, options.steeringSignal);
  if (outcome.kind === "completed") {
    options.manager.releaseForegroundJob(job.jobId);
    return outcome.result;
  }
  if (outcome.kind === "failed") {
    options.manager.releaseForegroundJob(job.jobId);
    throw outcome.error;
  }
  if (outcome.kind === "aborted") {
    options.manager.cancel(job.jobId);
    options.manager.releaseForegroundJob(job.jobId);
    throw new ToolAbortError(job.getLatestText() || "Command aborted");
  }
  // raceJobSettlement removes caller abort/steering listeners before resolving.
  // Only the manager's own signal can cancel the remote request after this point.
  job.background();
  options.manager.backgroundJob(job.jobId);
  return backgroundNotice(options, job, outcome.kind === "steer", job.getLatestText());
}
