import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "../protocol.ts";

const terminal = (state: string): boolean => state === "exited" || state === "failed";
export type ServiceStopReceipt = { name: string; id: string; status: "stopped" | "replaced" };

/** Broker-side id comparison makes the lookup-to-stop replacement window safe. */
export async function stopRemoteServiceInstance(cwd: string, name: string, id: string): Promise<ServiceStopReceipt> {
  const client = await daemonClientForProject(cwd);
  const result = await client.request({ op: "stop", name, id, timeoutMs: 1_000 }, AbortSignal.timeout(10_000));
  if (result.op !== "stop") throw new Error(`Unexpected stop response for remote service ${name}`);
  if (result.daemon.id !== id) return { name, id, status: "replaced" };
  if (!terminal(result.daemon.state)) throw new Error(`Remote service ${name} (${id}) did not stop: ${result.daemon.state}`);
  return { name, id, status: "stopped" };
}

/**
 * Native bash keeps its validation, normalization and shell environment. Its
 * service receipt has a PID, not the broker generation UUID. Keep the launch
 * RPC alive on abort, interrupt only readiness, then use PID + fixed owner to
 * look up the UUID. A mismatching replacement is never ours to stop.
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
      const client = await daemonClientForProject(cwd);
      const described = await client.request({ op: "describe", name }, AbortSignal.timeout(10_000));
      if (described.op !== "describe") throw new Error(`Unexpected describe response for remote service ${name}`);
      const daemon = described.daemon;
      if (daemon.pid === service.pid && daemon.owner === owner) {
        id = daemon.id;
        ownership = "owned";
      } else {
        // The acknowledged process already exited or its name was replaced.
        ownership = terminal(daemon.state) ? "terminal" : "replaced";
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
