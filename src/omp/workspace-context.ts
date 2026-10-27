import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

// Static rules live in tool metadata. Binding changes enter the native history
// before context transforms, never as a post-MC projection of that history.
export const WORKSPACE_RULES = "Workspace execution follows the current binding, not path spelling or earlier conversation. In local mode workspace tools use native local behavior; in remote mode filesystem, shell and compute tools use the selected remote workspace. Session orchestration and local internal resources remain local. A lost remote connection rejects workspace operations; it never silently falls back locally. After switching workspace, re-read files before editing and do not reuse old path/content assumptions. Reconnecting starts a new runtime: kernels and staged changes do not survive. Remote eval is compute-only: agent/workpool, judge/completion, archive/browser and local tool callbacks are not bridged; use top-level local orchestration tools. Direct user shell/Python shortcuts and unadapted workspace operations are blocked in remote mode. Exit remote mode before disabling the extension. Checkpoint/rewind manage local conversation context only, never undo remote file changes or kernel state. Remote Bash jobs expose bounded native output and pipeline captures via their local proc:// job handles; widgets are authored locally. Retention gaps are explicit: captures are not an unlimited output archive. Query remote_workspace_status when location is unclear or after a transport error, not before every call. Status describes the binding, not an SSH health probe.";

export interface WorkspaceBindingNotice {
  binding: string;
  mode: "local" | "remote" | "unavailable";
  target: string | null;
  cwd: string | null;
}
// Read only for detecting histories written by older versions. Never replay its
// private anchors: persisted native messages are the sole history authority.
export const WORKSPACE_CONTEXT_ENTRY = "remote-workspace-context-v1";
export const WORKSPACE_NOTICE_TYPE = "remote-workspace-binding";

export function workspaceNotice(current: WorkspaceBindingNotice): CustomMessage<WorkspaceBindingNotice> {
  const location = current.mode === "local" ? "local host" : `SSH host ${JSON.stringify(current.target)}`;
  return {
    role: "custom", customType: WORKSPACE_NOTICE_TYPE, display: false, details: current, timestamp: Date.now(),
    content: `Workspace binding: ${current.mode}; ${location}; cwd=${JSON.stringify(current.cwd)}. ` +
      (current.mode === "unavailable"
        ? "Remote execution is unavailable; no local fallback. Reconnect or explicitly exit remote mode."
        : "This is the current execution environment. Do not carry file/edit assumptions across bindings; a new remote binding has no previous runtime's kernel or staged state."),
  };
}

/**
 * Read the active native branch on every attempt. Returning a hook result does
 * not mean OMP accepted it: only appendCustomMessageEntry commits the notice.
 */
export function workspaceAnnouncement(
  current: WorkspaceBindingNotice,
  branch: readonly SessionEntry[],
): CustomMessage<WorkspaceBindingNotice> | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type === "custom_message" && entry.customType === WORKSPACE_NOTICE_TYPE) {
      const previous = entry.details as WorkspaceBindingNotice | undefined;
      if (previous?.binding === current.binding && previous.mode === current.mode &&
          previous.target === current.target && previous.cwd === current.cwd) return;
      return workspaceNotice(current);
    }
    // Older versions persisted a private context marker instead of a native
    // binding message. Correct that history once; do not replay its anchors.
    if (entry.type === "custom" && entry.customType === WORKSPACE_CONTEXT_ENTRY) {
      return workspaceNotice(current);
    }
  }
  if (current.mode !== "local") return workspaceNotice(current);
}
