import { canonicalProjectDir, daemonClient } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { projectScope } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "../protocol.ts";

const terminal = (state: string): boolean => state === "exited" || state === "failed";
export type ServiceStopReceipt = { name: string; id: string; status: "stopped" | "replaced" };

async function serviceRef(cwd: string, key: string) {
  return { kind: "proc", scope: projectScope(await canonicalProjectDir(cwd)), key };
}

/** The daemon atomically compares the generation before stopping a named unit. */
export async function stopRemoteServiceInstance(cwd: string, name: string, id: string): Promise<ServiceStopReceipt> {
  const client = await daemonClient();
  const { unit } = await client.request({
    op: "stop", unit: await serviceRef(cwd, name), generation: id, timeoutMs: 1_000,
  }, AbortSignal.timeout(10_000));
  if (unit.generation !== id) return { name, id, status: "replaced" };
  if (!terminal(unit.state)) throw new Error(`Remote service ${name} (${id}) did not stop: ${unit.state}`);
  return { name, id, status: "stopped" };
}

/**
 * Native bash keeps its validation, normalization and shell environment. Its
 * service receipt has a PID, not the daemon generation UUID. Keep the launch
 * RPC alive on abort, interrupt only readiness, then use PID + fixed owner to
 * look up the generation. A mismatching replacement is never ours to stop.
 */
export async function executeOwnedRemoteService(
  cwd: string,
  owner: string,
  name: string,
  execute: (steeringSignal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
  steeringSignal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const readiness = AbortSignal.any([...(signal ? [signal] : []), ...(steeringSignal ? [steeringSignal] : [])]);
  const result = await execute(readiness);
  // Pre-launch errors have no ownership receipt and must not trigger a stop.
  if (!isRecord(result))
    throw new Error(`Remote service ${name} returned no supported launch receipt; refusing name-only cleanup`);
  if (result.isError) return result;
  const details = isRecord(result.details) ? result.details : undefined;
  const service = details && isRecord(details.service) ? details.service : undefined;
  if (!service || service.name !== name || typeof service.state !== "string")
    throw new Error(`Remote service ${name} returned no supported launch receipt; refusing name-only cleanup`);
  let id: string | undefined;
  let ownership: "terminal" | "replaced" | "owned" = "terminal";
  try {
    if (!terminal(service.state)) {
      if (typeof service.pid !== "number" || !Number.isSafeInteger(service.pid) || service.pid <= 1)
        throw new Error(`Remote service ${name} returned no process PID; refusing name-only cleanup`);
      const client = await daemonClient();
      const { unit } = await client.request({ op: "describe", unit: await serviceRef(cwd, name) }, AbortSignal.timeout(10_000));
      if (unit.pids[0] === service.pid && unit.owner === owner && !terminal(unit.state)) {
        id = unit.generation;
        ownership = "owned";
      } else {
        // The acknowledged process already exited or its name was replaced.
        ownership = terminal(unit.state) ? "terminal" : "replaced";
      }
    }
    if (signal?.aborted) {
      if (id) await stopRemoteServiceInstance(cwd, name, id);
      signal.throwIfAborted();
    }
  } catch (error) {
    if (signal?.aborted && error !== signal.reason)
      throw new AggregateError([signal.reason, error], `${signal.reason instanceof Error ? signal.reason.message : String(signal.reason)}; remote service ${name} cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return { ...result, details: { ...details, service: { ...service, ...(id ? { id } : {}), ownership } } } as AgentToolResult;
}
