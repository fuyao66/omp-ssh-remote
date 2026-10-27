import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { normalizePathArgument, pathsShouldStayLocal, resourcePathOperands } from "../path-domain.ts";
import type { RemoteToolName } from "../protocol.ts";

/** Native consumers resolve proc URLs; debugger/LSP path metadata does not. */
export function consumesProcessResources(tool: RemoteToolName): boolean {
  return tool === "read" || tool === "write" || tool === "grep" || tool === "glob";
}

/** Use the same selector peeling and authority decoding as the native tools. */
function processResource(path: string) {
  const router = InternalUrlRouter.instance();
  const bare = router.split(normalizePathArgument(path)).path;
  if (!/^proc:\/\//i.test(bare)) return;
  const url = parseInternalUrl(bare);
  return url.protocol.toLowerCase() === "proc:" ? url : undefined;
}

/** Empty authority + root pathname lists both domains, never a concrete id. */
export function isProcessListingPath(path: unknown): boolean {
  if (typeof path !== "string" || path.includes(";")) return false;
  const url = processResource(path);
  const pathname = url?.rawPathname ?? url?.pathname;
  return !!url && !url.rawHost && (pathname === "" || pathname === "/") &&
    !url.search && !url.hash;
}

/** Resolve every process operand before composing it with other resource owners. */
export function processOperandExecutionTarget(
  paths: string[],
  isLocalId: (id: string) => boolean,
): "local" | "remote" | undefined {
  const resources = paths.map(processResource);
  if (!resources.some(Boolean)) return undefined;
  const targets = paths.map((path, index) => resources[index]
    ? resources[index]!.rawHost && isLocalId(resources[index]!.rawHost) ? "local" : "remote"
    : pathsShouldStayLocal([path]) ? "local" : "remote");
  if (new Set(targets).size > 1) throw new Error("Mixed local and remote process resources are not supported; read or search each execution domain separately");
  return targets[0];
}

/** A multi-resource read/grep cannot send a local job to a remote broker. */
export function processExecutionTarget(
  tool: RemoteToolName,
  params: Record<string, unknown>,
  isLocalId: (id: string) => boolean,
): "local" | "remote" | undefined {
  if (!consumesProcessResources(tool)) return undefined;
  return processOperandExecutionTarget(resourcePathOperands(tool, params), isLocalId);
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
