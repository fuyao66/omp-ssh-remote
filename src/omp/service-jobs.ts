import type { RemoteRuntimeClient } from "../client.ts";
import { resolveLocalAsyncJobManager } from "./async-bash.ts";

/** Native wait sees a local job; the remote broker remains the process owner. */
const exits = new WeakMap<RemoteRuntimeClient, Map<string, { promise: Promise<unknown>; resolve(value: unknown): void }>>();
export function prepareService(client: RemoteRuntimeClient, name: string): void {
  let map = exits.get(client);
  if (!map) { map = new Map(); exits.set(client, map); }
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  map.set(name, { promise, resolve });
}
export function forgetService(client: RemoteRuntimeClient, name: string): void {
  exits.get(client)?.delete(name);
}
export function completeService(client: RemoteRuntimeClient, name: string, result: unknown): boolean {
  const pending = exits.get(client)?.get(name);
  if (!pending) return false;
  pending.resolve(result);
  return true;
}
export function trackService(client: RemoteRuntimeClient, name: string, ownerId: string): void {
  const manager = resolveLocalAsyncJobManager();
  const pending = exits.get(client)?.get(name);
  if (!manager || !pending) return;
  manager.register("bash", `Remote service: ${name}`, async ({ signal }) => {
    let onAbort!: () => void;
    let offClose = () => {};
    const failed = new Promise<never>((_, reject) => {
      offClose = client.onClose(reject);
      onAbort = () => {
        void client.execute("write", `service-cancel-${name}`, { path: `proc://${name}/kill`, content: "" }).catch(() => {});
        reject(new Error(`Remote service ${name} cancelled`));
      };
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([pending.promise, failed]);
      return JSON.stringify(result);
    } finally {
      offClose(); signal.removeEventListener("abort", onAbort);
      if (exits.get(client)?.get(name) === pending) exits.get(client)?.delete(name);
    }
  }, { ownerId });
}
