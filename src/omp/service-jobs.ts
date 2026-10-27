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

/** Native explicit stops intentionally do not emit daemon-completed. */
export function completeStoppedService(
  client: RemoteRuntimeClient,
  result: AgentToolResult,
): boolean {
  const proc = (result.details as { proc?: { action?: string; daemon?: { name?: string } } })?.proc;
  if (result.isError || proc?.action !== "stop" || !proc.daemon?.name) return false;
  return completeService(client, proc.daemon.name, { operation: "stop", result });
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
      let instanceId: string | undefined;
      try {
        combined.throwIfAborted();
        const result = await execute(combined);
        const service = (result.details as { service?: { id?: string; ownership?: string } } | undefined)?.service;
        if (result.isError) {
          started.resolve(result);
          throw new Error(`Remote service ${name} failed to start`);
        }
        if (service?.ownership === "owned") {
          if (typeof service.id !== "string" || service.id.trim().length === 0)
            throw new Error(`Remote service ${name} returned an owned receipt without an instance ID; refusing name-only cleanup`);
          instanceId = service.id;
        } else if (service?.ownership !== "terminal" && service?.ownership !== "replaced") {
          throw new Error(`Remote service ${name} returned no supported ownership receipt; refusing name-only cleanup`);
        }
        combined.throwIfAborted();
        started.resolve(result);
        // Native explicit stops suppress completion notifications. The launch
        // lookup may already have observed exit/replacement before returning.
        if (service?.ownership === "terminal" || service?.ownership === "replaced")
          return JSON.stringify({ operation: "launch-settled", ownership: service.ownership, result });
        return JSON.stringify(await Promise.race([completion.promise, lost.promise]));
      } catch (error) {
        let failure = error;
        if (instanceId && !client.isClosed) {
          try {
            await client.stopService(name, instanceId);
          } catch (cleanupError) {
            failure = new AggregateError([error, cleanupError], `${error instanceof Error ? error.message : String(error)}; remote service ${name} cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
        started.reject(failure);
        throw failure;
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
