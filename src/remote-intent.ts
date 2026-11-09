import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export const REMOTE_INTENT_ENTRY = "remote-workspace-intent-v1";

export interface RemoteIntent {
  version: 1;
  remote: boolean;
}

/** Await native durability barriers before publishing an execution-mode change. */
export async function persistRemoteIntent(append: () => void, manager: SessionManager): Promise<void> {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Remote workspace intent requires a persistent session.");
  const assertSameFile = () => {
    if (manager.getSessionFile() !== sessionFile) {
      throw new Error("Session changed while persisting remote workspace intent; local fallback is disabled.");
    }
  };
  append();
  assertSameFile();
  await manager.ensureOnDisk();
  assertSameFile();
  await manager.flush();
  assertSameFile();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read chronological native getEntries(): execution intent is independent of conversation navigation. */
export function latestRemoteIntent(entries: readonly SessionEntry[]): boolean | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== REMOTE_INTENT_ENTRY) continue;
    if (!isRecord(entry.data) || entry.data.version !== 1 || typeof entry.data.remote !== "boolean") {
      throw new Error("Persisted remote workspace intent is invalid; reconnect or explicitly exit remote mode.");
    }
    return entry.data.remote;
  }
  // Old releases persisted notices, not selection intent. They also emitted
  // local notices on restore, so only an explicit v1 false can clear migration.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const notice = entry.type === "custom" && entry.customType === "remote-workspace-context-v1"
      ? entry.data
      : entry.type === "custom_message" && entry.customType === "remote-workspace-binding" ? entry.details : undefined;
    if (isRecord(notice) && (notice.mode === "remote" || notice.mode === "unavailable")) return true;
  }
  return undefined;
}

async function ancestorIntent(sessionFile: string): Promise<boolean | undefined> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Filesystem errors can contain private session paths. Do not retain their cause.
    throw new Error("Cannot read ancestor remote workspace intent; reconnect or explicitly exit remote mode.");
  }
  try {
    const parsed = parseSessionContent(content);
    const header = parsed.entries[0];
    if (parsed.invalidHeader || parsed.malformedRecords !== 0 || !isRecord(header) ||
        header.type !== "session" || typeof header.id !== "string" || header.id.length === 0 ||
        typeof header.timestamp !== "string" || typeof header.cwd !== "string" ||
        parsed.entries.slice(1).some(entry => !isRecord(entry) || typeof entry.type !== "string" || entry.type === "session")) {
      throw new Error("Invalid ancestor transcript");
    }
    const entries = parsed.entries.slice(1) as SessionEntry[];
    // Inspect append order without opening a writer or replaying conversation
    // branches: rewinding must not undo a remote selection or an explicit exit.
    return latestRemoteIntent(entries);
  } catch {
    throw new Error("Cannot restore ancestor remote workspace intent; reconnect or explicitly exit remote mode.");
  }
}

/**
 * A child may be restored before its parent has resumed. Read only the durable
 * boolean intent, never connection targets, configuration, or credentials.
 * Explicit child state wins, including a deliberate return to local execution.
 */
export async function inheritedRemoteIntent(
  sessionFile: string | undefined,
  ownEntries: readonly SessionEntry[],
): Promise<boolean | undefined> {
  const own = latestRemoteIntent(ownEntries);
  if (own !== undefined || !sessionFile || !sessionFile.endsWith(".jsonl")) return own;
  // Native children live below the parent's transcript stem. A missing immediate
  // parent does not rule out a surviving grandparent transcript.
  let directory = dirname(resolve(sessionFile));
  while (dirname(directory) !== directory) {
    const inherited = await ancestorIntent(`${directory}.jsonl`);
    if (inherited !== undefined) return inherited;
    directory = dirname(directory);
  }
  return undefined;
}
