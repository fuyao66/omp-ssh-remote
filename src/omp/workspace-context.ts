import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

// Rules are constant; connection-specific facts belong at the message tail.
export const WORKSPACE_RULES = "Workspace execution follows the current binding, not path spelling or earlier conversation. In local mode workspace tools use native local behavior; in remote mode filesystem, shell and compute tools use the selected remote workspace. Session orchestration and local internal resources remain local. A lost remote connection rejects workspace operations; it never silently falls back locally. After switching workspace, re-read files before editing and do not reuse old path/content assumptions. Reconnecting starts a new runtime: kernels and staged changes do not survive. Remote eval is compute-only: agent/workpool, judge/completion, archive/browser and local tool callbacks are not bridged; use top-level local orchestration tools. Direct user shell/Python shortcuts and unadapted find/security_scan/ida are blocked in remote mode. Checkpoint/rewind manage local conversation context only, never undo remote file changes or kernel state. Remote Bash jobs expose bounded native output and pipeline captures via their local proc:// job handles; widgets are authored locally. Retention gaps are explicit: captures are not an unlimited output archive. Query remote_workspace_status when location is unclear or after a transport error, not before every call. Status describes the binding, not an SSH health probe.";

export interface WorkspaceBindingNotice {
  binding: string;
  mode: "local" | "remote" | "unavailable";
  target: string | null;
  cwd: string | null;
}
export const WORKSPACE_CONTEXT_ENTRY = "remote-workspace-context-v1";
const TYPE = "remote-workspace-binding";

export function workspaceNotice(messages: readonly AgentMessage[], current: WorkspaceBindingNotice): CustomMessage<WorkspaceBindingNotice> | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "custom" || message.customType !== TYPE) continue;
    if (JSON.stringify(message.details) === JSON.stringify(current)) return;
    break;
  }
  const location = current.mode === "local" ? "local host" : `SSH host ${JSON.stringify(current.target)}`;
  return {
    role: "custom", customType: TYPE, display: false, details: current, timestamp: Date.now(),
    content: `Workspace binding: ${current.mode}; ${location}; cwd=${JSON.stringify(current.cwd)}. ` +
      (current.mode === "unavailable"
        ? "Remote execution is unavailable; no local fallback. Reconnect or explicitly exit remote mode."
        : "This is the current execution environment. Do not carry file/edit assumptions across bindings; a new remote binding has no previous runtime's kernel or staged state."),
  };
}

export interface WorkspaceNoticeAnchor {
  after: string;
  message: CustomMessage<WorkspaceBindingNotice>;
}

/** A context projection, not a transcript rewrite. Persist only notices and
 * their message anchors via appendEntry (which does not enter model context).
 * Never append to Agent.messages from context: a prompt's user message may not
 * yet be committed, which would move the notice before that user on replay. */
export function projectWorkspaceContext(
  messages: readonly AgentMessage[],
  saved: readonly WorkspaceNoticeAnchor[],
  current: WorkspaceBindingNotice,
) {
  const occurrences = new Map<string, number>();
  const byAnchor = new Map<string, WorkspaceNoticeAnchor[]>();
  for (const record of saved) {
    const group = byAnchor.get(record.after);
    if (group) group.push(record);
    else byAnchor.set(record.after, [record]);
  }
  const retained: WorkspaceNoticeAnchor[] = [];
  const projected: AgentMessage[] = [];
  let lastAnchor = "empty";
  const replay = (anchor: string) => {
    for (const record of byAnchor.get(anchor) ?? []) {
      retained.push(record);
      projected.push(record.message);
    }
  };
  replay("empty");
  for (const message of messages) {
    const base = JSON.stringify([message.role, message.timestamp, "toolCallId" in message ? message.toolCallId : null, "customType" in message ? message.customType : null]);
    const ordinal = occurrences.get(base) ?? 0;
    occurrences.set(base, ordinal + 1);
    lastAnchor = `${base}:${ordinal}`;
    projected.push(message);
    replay(lastAnchor);
  }
  const notice = workspaceNotice(projected, current);
  if (notice) {
    projected.push(notice);
    retained.push({ after: lastAnchor, message: notice });
  }
  return { messages: projected, records: retained, changed: !!notice || retained.length !== saved.length };
}
