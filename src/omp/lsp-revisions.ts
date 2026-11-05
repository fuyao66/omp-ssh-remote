import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { DeferredDiagnosticsEntry } from "@oh-my-pi/pi-coding-agent/tools";

function content(path: string): string | undefined {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return undefined; }
}

/** Native counters name diagnostic generations; exact post-commit bytes also catch LSP/AST mutations. */
export class LspDiagnosticRevisions {
  readonly #revisions = new Map<string, { version: number; content?: string; pending: boolean }>();
  readonly #pending: DeferredDiagnosticsEntry[] = [];
  #active = false;
  constructor(readonly version: (path: string) => number, readonly invalidate: (path: string) => void,
    readonly deliver: (entry: DeferredDiagnosticsEntry) => void) {}
  begin(): void { this.#active = true; }
  bumped(path: string, version: number): void {
    // Native begin() runs before commit. Never label that pre-write content as
    // the revision diagnostics will describe; capture only after real settlement.
    this.#revisions.set(path, { version, pending: true });
  }
  diagnostics(entry: DeferredDiagnosticsEntry): void {
    if (this.#active) this.#pending.push(entry);
    else { this.#reconcile(); if (!entry.isStale()) this.deliver(entry); }
  }
  end(): void {
    this.#reconcile();
    this.#active = false;
    for (const entry of this.#pending.splice(0)) if (!entry.isStale()) this.deliver(entry);
  }
  #reconcile(): void {
    for (const [path, revision] of this.#revisions) {
      if (revision.version !== this.version(path)) { this.#revisions.delete(path); continue; }
      const now = content(path);
      if (revision.pending) { revision.content = now; revision.pending = false; }
      else if (revision.content !== now) {
        // The native LSP/AST apply paths do not bump ToolSession's counters.
        // Invalidate exactly the diagnosed file, including partial failed applies.
        this.#revisions.delete(path);
        this.invalidate(path);
      }
    }
  }
  dispose(): void { this.#revisions.clear(); this.#pending.length = 0; }
}
