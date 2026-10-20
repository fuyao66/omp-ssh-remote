import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { pathShouldStayLocal } from "../path-domain.ts";
import type { RemoteToolName } from "../protocol.ts";

/** A multi-resource read/grep cannot send a local job to a remote broker. */
export function processExecutionTarget(
  tool: RemoteToolName,
  params: Record<string, unknown>,
  isLocalId: (id: string) => boolean,
): "local" | "remote" | undefined {
  if (typeof params.path !== "string") return undefined;
  const paths = params.path.split(";");
  const ids = paths.map(path => /^proc:\/\/([^/:;?#]+)(?:\/|:|\?|#|$)/.exec(path)?.[1]);
  if (!ids.some(Boolean)) return undefined;
  const targets = paths.map((path, index) => ids[index]
    ? isLocalId(ids[index]!) ? "local" : "remote"
    : pathShouldStayLocal(tool, { ...params, path }) ? "local" : "remote");
  if (new Set(targets).size > 1) throw new Error("Mixed local and remote process resources are not supported; read or search each execution domain separately");
  return targets[0];
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

/** Native read renderers consume details.proc, not the diagnostic source blobs. */
export function mergeProcessListings(local: AgentToolResult, remote: AgentToolResult): AgentToolResult {
  const l = record(record(local.details).proc);
  const r = record(record(remote.details).proc);
  const proc = Object.fromEntries(["jobs", "agents", "daemons"].map(key => [key, [
    ...(Array.isArray(l[key]) ? l[key] as unknown[] : []),
    ...(Array.isArray(r[key]) ? r[key] as unknown[] : []),
  ]]));
  return {
    content: [{ type: "text", text: "Local process resources:" }, ...local.content, { type: "text", text: "Remote services:" }, ...remote.content],
    details: { proc, local: local.details, remote: remote.details },
    ...(local.isError || remote.isError ? { isError: true } : {}),
  };
}
