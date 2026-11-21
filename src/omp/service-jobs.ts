import type { RemoteRuntimeClientApi } from "../client.ts";
import type { AsyncJobManagerApi } from "@oh-my-pi/pi-coding-agent/async";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

type Reservation = {
  resolve(value: unknown): void;
  /** Unset while the launch is in flight; completions wait for the receipt. */
  generation?: string;
  early: { generation: string; value: unknown; unmatched(): void }[];
};

/** Reserve local ownership before sending any remote launch request. */
const exits = new WeakMap<RemoteRuntimeClientApi, Map<string, Reservation>>();

function generationOf(value: unknown): string | undefined {
  const event = value as { unit?: { generation?: unknown } } | undefined;
  return typeof event?.unit?.generation === "string" ? event.unit.generation : undefined;
}

/**
 * Deliver a daemon exit to the job that launched that generation. An exit of any
 * other generation (e.g. an earlier instance under a retried name) goes to `unmatched`,
 * the native model-visible path; it never settles another instance's job.
 */
export function completeService(client: RemoteRuntimeClientApi, name: string, result: unknown, unmatched: () => void): void {
  const reservation = exits.get(client)?.get(name);
  const generation = generationOf(result);
  if (!reservation || generation === undefined) return unmatched();
  if (reservation.generation === undefined) {
    reservation.early.push({ generation, value: result, unmatched });
    return;
  }
  if (reservation.generation === generation) reservation.resolve(result);
  else unmatched();
}

/**
 * Settle a job from a `proc://` write receipt; neither transition emits daemon-completed
 * for the tracked instance. A stop must name its generation. A mode change that relaunched
 * the service (e.g. `detached`) replaced it under a new generation, ending the tracked one.
 */
export function completeProcReceipt(
  client: RemoteRuntimeClientApi,
  result: AgentToolResult,
): boolean {
  const proc = (result.details as { proc?: { action?: string; daemon?: { key?: string; generation?: string } } })?.proc;
  if (result.isError || !proc?.daemon?.key || typeof proc.daemon.generation !== "string") return false;
  const reservation = exits.get(client)?.get(proc.daemon.key);
  if (!reservation?.generation) return false;
  if (proc.action === "stop" && reservation.generation === proc.daemon.generation) {
    reservation.resolve({ operation: "stop", result });
    return true;
  }
  if (proc.action === "mode" && reservation.generation !== proc.daemon.generation) {
    reservation.resolve({ operation: "mode", result });
    return true;
  }
  return false;
}

export async function startRemoteService(
  client: RemoteRuntimeClientApi,
  name: string,
  ownerId: string,
  manager: AsyncJobManagerApi,
  execute: (signal: AbortSignal) => Promise<AgentToolResult>,
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  signal?.throwIfAborted();
  let map = exits.get(client);
  if (!map) { map = new Map(); exits.set(client, map); }
  if (map.has(name)) throw new Error(`Remote service ${name} is already tracked`);
  const completion = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<AgentToolResult>();
  const reservation: Reservation = { resolve: completion.resolve, early: [] };
  /**
   * Bind the receipt's generation and replay exits that arrived before it. Without
   * one (`undefined`), every exit goes to the native path: a terminal receipt does not
   * name its generation, so an early exit may be another instance's and is never dropped.
   */
  const settle = (generation: string | undefined) => {
    const early = reservation.early.splice(0);
    reservation.generation = generation ?? "";
    for (const event of early) {
      if (event.generation === generation) reservation.resolve(event.value);
      else event.unmatched();
    }
  };
  // A capacity failure is synchronous; no request has been sent at that point.
  map.set(name, reservation);
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
          settle(instanceId);
        } else if (service?.ownership !== "terminal" && service?.ownership !== "replaced") {
          throw new Error(`Remote service ${name} returned no supported ownership receipt; refusing name-only cleanup`);
        }
        combined.throwIfAborted();
        started.resolve(result);
        // Native explicit stops suppress completion notifications. The launch
        // lookup may already have observed exit/replacement before returning.
        if (service?.ownership === "terminal" || service?.ownership === "replaced") {
          settle(undefined);
          return JSON.stringify({ operation: "launch-settled", ownership: service.ownership, result });
        }
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
        // A failed or abandoned launch may leave a live instance: its exit stays model-visible.
        if (reservation.generation === undefined) settle(undefined);
        if (map.get(name) === reservation) map.delete(name);
      }
    }, { ownerId });
  } catch (error) {
    map.delete(name);
    throw error;
  }
  return started.promise;
}
