import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { isRecord, REMOTE_PREVIEWS_KEY, type RemotePreview } from "../protocol.ts";

/** One worker preview standing in the host's native queue, where `resolve`/`reject` look. */
export type RemotePreviewMirror = { readonly id: string; readonly queue: ToolChoiceQueue };
export type PreviewResolution = { action: "apply" | "discard"; reason: string };

/** Removes the worker's staged-preview list from a remote result before anything renders it. */
export function takeRemotePreviews(result: unknown): RemotePreview[] {
  if (!isRecord(result) || !Object.hasOwn(result, REMOTE_PREVIEWS_KEY)) return [];
  const staged = result[REMOTE_PREVIEWS_KEY];
  delete result[REMOTE_PREVIEWS_KEY];
  return Array.isArray(staged)
    ? staged.filter((entry): entry is RemotePreview =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.sourceToolName === "string")
    : [];
}

/**
 * Registers `preview` the way native queueResolveHandler registers a local one: newest first,
 * consumed once on success, back at the head after a failed resolution. Unlike the native
 * handler, a mirror is claimed before it awaits the worker, so an overlapping `resolve`/`reject`
 * cannot reach the same preview. The worker that staged it applies it; `connection` yields that
 * worker's resolver only while it is still current.
 */
export function mirrorRemotePreview(
  mirrors: RemotePreviewMirror[],
  queue: ToolChoiceQueue,
  preview: RemotePreview,
  connection: () => ((resolution: PreviewResolution) => Promise<unknown>) | undefined,
): void {
  const mirror: RemotePreviewMirror = { id: `remote-preview:${randomUUID()}`, queue };
  const register = () => queue.registerPendingInvoker(mirror.id, preview.sourceToolName, onInvoked);
  // A mirror withdrawn while its resolution was in flight (reconnect, exit) stays withdrawn.
  const restore = () => { if (mirrors.includes(mirror)) register(); };
  const consume = () => {
    const index = mirrors.indexOf(mirror);
    if (index >= 0) mirrors.splice(index, 1);
  };
  const onInvoked = async (input: unknown): Promise<unknown> => {
    const { action, reason } = isRecord(input) ? input : {};
    if ((action !== "apply" && action !== "discard") || typeof reason !== "string")
      throw new Error("Invalid resolution: expected an action and a reason.");
    queue.removePendingInvoker(mirror.id);
    const resolve = connection();
    if (!resolve) {
      if (action === "apply") {
        restore();
        throw new Error("The staged preview was lost with its remote runtime. Reject it, then stage the change again.");
      }
      consume();
      const discarded: AgentToolResult = {
        content: [{ type: "text", text: `Discarded: the staged preview was lost with its remote runtime. Reason: ${reason}` }],
        details: { action, reason, sourceToolName: preview.sourceToolName },
      };
      return discarded;
    }
    try {
      const result = await resolve({ action, reason });
      consume();
      return result;
    } catch (error) {
      restore();
      throw error;
    }
  };
  register();
  mirrors.push(mirror);
}

/** Withdraws every mirror in place, including any whose resolution is still in flight; returns the count. */
export function dropRemotePreviews(mirrors: RemotePreviewMirror[]): number {
  const dropped = mirrors.splice(0);
  for (const { id, queue } of dropped) queue.removePendingInvoker(id);
  return dropped.length;
}
