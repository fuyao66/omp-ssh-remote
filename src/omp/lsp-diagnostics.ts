import type { DeferredDiagnosticsEntry } from "@oh-my-pi/pi-coding-agent/tools";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";

export type LspMutation = { sessionId: string; resourceBinding: string; path: string; version: number };
export type LspDiagnostics = LspMutation & Omit<DeferredDiagnosticsEntry, "isStale">;
export type LspOperation = { sessionId: string; resourceBinding: string; id: number };

export function parseLspEvent(value: Record<string, unknown>, diagnostics: boolean): LspMutation | LspDiagnostics {
  for (const key of ["sessionId", "resourceBinding", "path"] as const)
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Invalid remote LSP ${key}`);
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new Error("Invalid remote LSP mutation version");
  const mutation: LspMutation = { sessionId: value.sessionId as string, resourceBinding: value.resourceBinding as string,
    path: value.path as string, version: value.version as number };
  if (!diagnostics) return mutation;
  if (typeof value.summary !== "string" || typeof value.errored !== "boolean" ||
      !Array.isArray(value.messages) || !value.messages.every(message => typeof message === "string"))
    throw new Error("Invalid remote LSP diagnostics");
  return { ...mutation, summary: value.summary, errored: value.errored, messages: value.messages as string[] };
}

export function mayMutateLsp(tool: string, args: Record<string, unknown>): boolean {
  return tool === "write" || tool === "edit" || tool === "ast_edit" ||
    (tool === "lsp" && ["rename", "rename_file", "code_actions", "request"].includes(String(args.action)));
}

type DiagnosticOwner = { yieldQueue: { enqueueWithReceipt<P>(kind: string, entry: P): Promise<void> } };

/** Native next-yield delivery with exact owner, worker revisions and actual-operation cancellation fences. */
export class RemoteLspDiagnostics {
  readonly #versions = new Map<string, number>();
  readonly #staged = new Set<LspDiagnostics>();
  readonly #operations = new Set<number>();
  #mutations = 0;
  #closed = false;
  constructor(readonly owner: DiagnosticOwner, readonly sessionId: string, readonly resourceBinding: string,
    readonly isCurrent: () => boolean) {}
  #owned(entry: { sessionId: string; resourceBinding: string }): boolean {
    return !this.#closed && this.isCurrent() && entry.sessionId === this.sessionId && entry.resourceBinding === this.resourceBinding;
  }
  #held(): boolean { return this.#mutations > 0 || this.#operations.size > 0; }
  mutation(entry: LspMutation): void {
    if (!this.#owned(entry)) return;
    if (entry.version <= (this.#versions.get(entry.path) ?? 0)) throw new Error("Remote LSP mutation version did not advance");
    this.#versions.set(entry.path, entry.version);
    for (const staged of this.#staged) if (staged.path === entry.path && staged.version !== entry.version) this.#staged.delete(staged);
  }
  operation(event: LspOperation, phase: "begin" | "end"): void {
    if (!this.#owned(event)) return;
    if (!Number.isSafeInteger(event.id) || event.id < 1) throw new Error("Invalid remote LSP operation id");
    if (phase === "begin") this.#operations.add(event.id); else this.#operations.delete(event.id);
    if (!this.#held()) this.#flush();
  }
  diagnostics(entry: LspDiagnostics): void {
    if (!this.#fresh(entry)) return;
    if (this.#held()) this.#staged.add(entry); else this.#enqueue(entry);
  }
  beginMutation(): () => void {
    this.#mutations++;
    let ended = false;
    return () => { if (ended) return; ended = true; this.#mutations--; if (!this.#held()) this.#flush(); };
  }
  close(): void { this.#closed = true; this.#staged.clear(); this.#versions.clear(); this.#operations.clear(); }
  #fresh(entry: LspDiagnostics): boolean { return this.#owned(entry) && this.#versions.get(entry.path) === entry.version; }
  #enqueue(entry: LspDiagnostics): void {
    let held = false;
    const nativeEntry: DeferredDiagnosticsEntry = { path: entry.path, summary: entry.summary, messages: entry.messages,
      errored: entry.errored, isStale: () => {
        if (!this.#fresh(entry)) return true;
        if (this.#held()) { held = true; return true; }
        return false;
      } };
    void this.owner.yieldQueue.enqueueWithReceipt(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, nativeEntry).catch(() => {
      if (held && this.#fresh(entry)) { this.#staged.add(entry); if (!this.#held()) this.#flush(); }
    });
  }
  #flush(): void {
    for (const entry of [...this.#staged]) { this.#staged.delete(entry); if (this.#fresh(entry)) this.#enqueue(entry); }
  }
}
