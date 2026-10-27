import { AsyncLocalStorage } from "node:async_hooks";
import { ConflictHistory } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import type { ConflictEntry } from "@oh-my-pi/pi-tui/tools/conflict-detect";
import { isRecord } from "../protocol.ts";

/** Native registrations are attributed to the exact read, including concurrent and multi-path reads. */
export class RemoteConflictHistory extends ConflictHistory {
  readonly #readIds = new AsyncLocalStorage<Set<number>>();

  override register(input: Omit<ConflictEntry, "id">): ConflictEntry {
    const entry = super.register(input);
    this.#readIds.getStore()?.add(entry.id);
    return entry;
  }

  captureRead<T>(execute: () => Promise<T>): Promise<T> {
    // Native multi-path reads recurse through the wrapped ReadTool.execute.
    // Keep those registrations in the outer call: native batching discards
    // child result details when it assembles the final result.
    if (this.#readIds.getStore()) return execute();
    return this.#readIds.run(new Set<number>(), async () => {
      const result = await execute();
      const ids = this.#readIds.getStore()!;
      if (ids.size === 0 || !isRecord(result)) return result;
      const details = isRecord(result.details) ? result.details : {};
      const resources = isRecord(details.remoteResources) ? details.remoteResources : {};
      return {
        ...result,
        details: {
          ...details,
          remoteResources: { ...resources, conflictIds: [...ids] },
        },
      } as T;
    });
  }
}
