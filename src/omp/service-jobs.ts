import type { RemoteRuntimeClient } from "../client.ts";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

/** Reserve local ownership before sending any remote launch request. */
const exits = new WeakMap<RemoteRuntimeClient, Map<string, (value: unknown) => void>>();

export function completeService(client: RemoteRuntimeClient, name: string, result: unknown): boolean {
  const resolve = exits.get(client)?.get(name);
  if (!resolve) return false;
  resolve(result);
  return true;
}

export async function startRemoteService(
  client: RemoteRuntimeClient,
  name: string,
  ownerId: string,
  manager: AsyncJobManager,
  execute: (signal: AbortSignal) => Promise<AgentToolResult>,
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  signal?.throwIfAborted();
  let map = exits.get(client);
  if (!map) { map = new Map(); exits.set(client, map); }
  if (map.has(name)) throw new Error(`Remote service ${name} is already tracked`);
  const completion = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<AgentToolResult>();
  // A capacity failure is synchronous; no request has been sent at that point.
  map.set(name, completion.resolve);
  try {
    manager.register("bash", `Remote service: ${name}`, async ({ signal: jobSignal }) => {
      const combined = signal ? AbortSignal.any([signal, jobSignal]) : jobSignal;
      const lost = Promise.withResolvers<never>();
      void lost.promise.catch(() => {});
      const offClose = client.onClose(lost.reject);
      const abort = () => lost.reject(jobSignal.reason ?? new Error("Remote service cancelled"));
      jobSignal.addEventListener("abort", abort, { once: true });
      let launched = false;
      try {
        combined.throwIfAborted();
        const result = await execute(combined);
        launched = !result.isError;
        started.resolve(result);
        if (!launched) throw new Error(`Remote service ${name} failed to start`);
        combined.throwIfAborted();
        return JSON.stringify(await Promise.race([completion.promise, lost.promise]));
      } catch (error) {
        started.reject(error);
        if (launched && !client.isClosed) {
          await client.execute("write", `service-rollback-${name}`, { path: `proc://${name}/kill`, content: "" }, AbortSignal.timeout(10000));
        }
        throw error;
      } finally {
        offClose();
        jobSignal.removeEventListener("abort", abort);
        if (map.get(name) === completion.resolve) map.delete(name);
      }
    }, { ownerId });
  } catch (error) {
    map.delete(name);
    throw error;
  }
  return started.promise;
}
