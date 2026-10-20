import { randomUUID } from "node:crypto";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager, type AsyncJob, type AsyncJobDetails } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { RemoteNativeTool } from "../runtime.ts";
import {
  CAPTURE_PIPE_CHUNK_BYTES,
  CAPTURE_STAGE_LABEL_UNITS,
  CAPTURE_TEXT_CHUNK_UNITS,
  type JobCaptureSender,
  type RemotePipeInfo,
} from "./job-capture.ts";

function cleanDetails(details: AsyncJobDetails = {}): AsyncJobDetails {
  const { async: _async, output: _output, images: _images, ...rest } = details;
  return rest;
}

/** Native async completion text already includes this exact metadata footer. */
function stripCaptureNotice(text: string, details: AsyncJobDetails): string {
  const notice = formatOutputNotice(details.meta);
  return notice && text.endsWith(notice) ? text.slice(0, -notice.length) : text;
}

/** A stalled transport must not keep a cancelled request or native manager alive. */
function abortableCapture(send: JobCaptureSender, signal: AbortSignal): JobCaptureSender {
  return async (capture) => {
    signal.throwIfAborted();
    let abort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        send(capture).then(resolve, reject);
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}

function capturePump(job: AsyncJob, send: JobCaptureSender): (final: boolean) => Promise<void> {
  let outputEnd = 0;
  let outputOpen: boolean | undefined;
  let membership: string | undefined;
  const pipes = new Map<number, { end: number; info: RemotePipeInfo }>();

  return async (final) => {
    const source = job.widgetInputs?.sources().find((source) => source.id === "out");
    if (source) {
      const chunk = source.read(outputEnd);
      const open = chunk.open && !final;
      for (let offset = 0; offset < chunk.text.length; offset += CAPTURE_TEXT_CHUNK_UNITS) {
        const text = chunk.text.slice(offset, offset + CAPTURE_TEXT_CHUNK_UNITS);
        const start = chunk.start + offset;
        const end = start + text.length;
        const pieceOpen = open || end < chunk.end;
        await send({ kind: "output", start, end, text, open: pieceOpen });
        outputEnd = end;
        outputOpen = pieceOpen;
      }
      if (chunk.text.length === 0 && (outputEnd !== chunk.end || outputOpen !== open)) {
        await send({ kind: "output", start: chunk.start, end: chunk.end, text: "", open });
        outputEnd = chunk.end;
        outputOpen = open;
      }
    }

    const streams = job.process?.streams;
    const infos = streams?.list() ?? [];
    const ids = infos.map((info) => info.id);
    const nextMembership = ids.join(",");
    if (nextMembership !== membership) {
      await send({ kind: "pipes", ids });
      membership = nextMembership;
      for (const id of pipes.keys()) if (!ids.includes(id)) pipes.delete(id);
    }
    for (const nativeInfo of infos) {
      const previous = pipes.get(nativeInfo.id);
      const chunk = streams!.read(nativeInfo.id, previous?.end ?? 0);
      if (!chunk) continue; // Native retention may remove a finished pipe between list and read.
      const info: RemotePipeInfo = {
        id: nativeInfo.id,
        producer: nativeInfo.producer.slice(0, CAPTURE_STAGE_LABEL_UNITS),
        consumer: nativeInfo.consumer.slice(0, CAPTURE_STAGE_LABEL_UNITS),
        total: Math.max(nativeInfo.total, chunk.end, previous?.info.total ?? 0),
        open: chunk.open && !final,
      };
      for (let offset = 0; offset < chunk.data.length; offset += CAPTURE_PIPE_CHUNK_BYTES) {
        const data = chunk.data.subarray(offset, offset + CAPTURE_PIPE_CHUNK_BYTES);
        const start = chunk.start + offset;
        const end = start + data.length;
        const pieceInfo = { ...info, open: info.open || end < chunk.end };
        await send({ kind: "pipe", info: pieceInfo, start, end, dataBase64: data.toString("base64") });
        pipes.set(info.id, { end, info: pieceInfo });
      }
      if (chunk.data.length === 0 && (
        !previous || previous.end !== chunk.end || previous.info.total !== info.total || previous.info.open !== info.open
      )) {
        await send({ kind: "pipe", info, start: chunk.start, end: chunk.end, dataBase64: "" });
        pipes.set(info.id, { end: chunk.end, info });
      }
    }
  };
}

function completedResult(job: AsyncJob, terminal?: AgentToolResult): AgentToolResult<AsyncJobDetails> {
  const nativeDetails: AsyncJobDetails = job.latestDetails ?? (terminal?.details as AsyncJobDetails | undefined) ?? {};
  const details = cleanDetails(nativeDetails);
  const content: AgentToolResult["content"] = terminal?.content.map((block) => block.type === "text"
    ? { ...block, text: stripCaptureNotice(block.text, nativeDetails) }
    : block) ?? [{
    type: "text",
    text: stripCaptureNotice(job.errorText ?? job.resultText ?? job.progressText ?? "(no output)", nativeDetails),
  }];
  for (const image of nativeDetails.images ?? []) {
    if (!content.some((block) => block.type === "image" && block.data === image.data && block.mimeType === image.mimeType)) {
      content.push(image);
    }
  }
  return {
    content,
    details,
    ...(job.status === "failed" || job.status === "cancelled" || terminal?.isError ? { isError: true } : {}),
  };
}

/** Observe native registration without replacing its run body or shell implementation. */
class CaptureJobManager extends AsyncJobManager {
  constructor(private readonly onRegistered: (job: AsyncJob) => void) {
    super({ maxRunningJobs: 1, onJobComplete: () => {} });
  }

  override register(...args: Parameters<AsyncJobManager["register"]>): string {
    const [type, label, run, options] = args;
    const id = super.register(type, label, run, { ...options, id: `remote_capture_${randomUUID()}` });
    this.onRegistered(this.getJob(id)!);
    return id;
  }
}

type NativeOutcome = { kind: "result"; result: AgentToolResult } | { kind: "error"; error: unknown };

/** Private native job machinery only: the host's AsyncJobManager owns the public job. */
export function createCapturedBashTool(
  session: ToolSession,
  onCapture: JobCaptureSender,
  foreground = false,
): RemoteNativeTool {
  const descriptor = new BashTool(session);
  return {
    name: descriptor.name,
    get description() { return descriptor.description; },
    get parameters() { return descriptor.parameters; },
    async execute(toolCallId, params, signal, onUpdate, context) {
      let job: AsyncJob | undefined;
      let terminal: AgentToolResult | undefined;
      let active = true;
      let execution: Promise<NativeOutcome> | undefined;
      const registered = Promise.withResolvers<AsyncJob>();
      const controller = new AbortController();
      const manager = new CaptureJobManager((nativeJob) => {
        job = nativeJob;
        manager.watchJobs([nativeJob.id]);
        if (signal?.aborted) manager.cancel(nativeJob.id);
        registered.resolve(nativeJob);
      });
      const bash = new BashTool({
        ...session,
        settings: foreground ? session.settings.overlay({
          "bash.autoBackground.enabled": true,
          "bash.autoBackground.thresholdMs": 86_400_000,
        }) : session.settings,
        asyncJobManager: manager,
        getAgentId: () => null,
      });
      const cancel = () => {
        if (job) manager.cancel(job.id);
        controller.abort(signal?.reason);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        execution = bash.execute(toolCallId, { ...params, async: !foreground } as unknown as BashToolInput,
          controller.signal, (update) => {
            if (!active) return;
            const state = update.details?.async?.state
              ?? (job?.latestDetails?.async as { state?: string } | undefined)?.state;
            const isTerminal = Boolean(state && state !== "running");
            if (isTerminal) terminal = update;
            const nativeDetails = job?.latestDetails ?? update.details as AsyncJobDetails;
            onUpdate?.({
              ...update,
              content: isTerminal ? update.content.map((block) => block.type === "text"
                ? { ...block, text: stripCaptureNotice(block.text, nativeDetails) } : block) : update.content,
              details: cleanDetails(update.details as AsyncJobDetails),
            });
          }, context as AgentToolContext | undefined).then(
          (result): NativeOutcome => ({ kind: "result", result }),
          (error: unknown): NativeOutcome => ({ kind: "error", error }),
        );
        // Validation can fail before native registration: never await registration alone.
        const first = await Promise.race([
          registered.promise.then((nativeJob) => ({ kind: "registered" as const, job: nativeJob })),
          execution,
        ]);
        if (first.kind === "error" && !job) throw first.error;
        if (first.kind === "result" && !job) return first.result;
        if (!job) throw new Error("Native managed bash job is unavailable");
        let settled = false;
        const completion = job.promise.then(() => { settled = true; });
        const pump = capturePump(job, abortableCapture(onCapture, controller.signal));
        while (!settled) {
          await pump(false);
          if (!settled) {
            const tick = Promise.withResolvers<void>();
            const timer = setTimeout(tick.resolve, 100);
            try {
              await Promise.race([completion, tick.promise]);
            } finally {
              clearTimeout(timer);
            }
          }
        }
        await completion;
        await pump(true);
        // Allocation is outside BashTool's managed-body try/catch. On that path
        // job.promise settles but its foreground completion waiter never does.
        if (foreground && job.errorText !== undefined && !terminal) controller.abort();
        const outcome = await execution;
        if (outcome.kind === "result" && !outcome.result.details?.async) {
          return { ...outcome.result, details: cleanDetails(outcome.result.details as AsyncJobDetails) };
        }
        return completedResult(job, terminal);
      } finally {
        active = false;
        signal?.removeEventListener("abort", cancel);
        // Transport failures cancel both the native run and any foreground waiter.
        cancel();
        if (job) await job.promise;
        if (execution) await execution;
        await manager.dispose();
      }
    },
  };
}
