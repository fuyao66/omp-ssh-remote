import { normalizePathArgument, pathShouldStayLocal } from "./path-domain.ts";
import { isRecord, type RemoteToolName } from "./protocol.ts";

const REMOTE_CONFLICT = "remote-conflict://";
const CONFLICT_TARGET = /^remote-conflict:\/\/([^/]+)\/(\*|[1-9]\d*)(?:\/(ours|theirs|base))?$/;

function nativeConflictTarget(path: string, binding: string | undefined): string {
  const target = normalizePathArgument(path);
  if (!target.startsWith(REMOTE_CONFLICT)) return path;
  const match = CONFLICT_TARGET.exec(target);
  if (!match || (match[2] === "*" && match[3])) {
    throw new Error("Invalid bound remote conflict reference");
  }
  let owner: string;
  try {
    owner = decodeURIComponent(match[1]!);
  } catch {
    throw new Error("Invalid bound remote conflict reference");
  }
  if (!binding || owner !== binding) {
    throw new Error("Remote conflict reference belongs to a stale workspace binding; read the remote file again");
  }
  return `conflict://${match[2]}${match[3] ? `/${match[3]}` : ""}`;
}

/** Inspect only resource operands, never replacement text or application output. */
export function resourceExecutionTarget(
  name: RemoteToolName,
  params: Record<string, unknown>,
  binding?: string,
): "remote" | undefined {
  const paths = [
    ...(typeof params.path === "string" ? params.path.split(";") : []),
    ...(typeof params.file === "string" ? [params.file] : []),
    ...(Array.isArray(params.paths) ? params.paths.filter((path): path is string => typeof path === "string") : []),
  ];
  if (!paths.some(path => normalizePathArgument(path).startsWith(REMOTE_CONFLICT))) return undefined;
  if (name !== "read" && name !== "write") {
    throw new Error("Bound remote conflict references support only read and write");
  }
  for (const path of paths) nativeConflictTarget(path, binding);
  // Also reject a semicolon list that would send local conflict:// ids remotely.
  pathShouldStayLocal(name, params);
  return "remote";
}

/** Convert validated bound operands just before remote native execution. */
export function resolveRemoteResourceArgs(
  name: RemoteToolName,
  params: Record<string, unknown>,
  binding: string,
): Record<string, unknown> {
  if (!resourceExecutionTarget(name, params, binding) || typeof params.path !== "string") return params;
  const path = params.path.split(";").map(part => nativeConflictTarget(part, binding)).join(";");
  return { ...params, path };
}

type ResourceResult = {
  content: Array<{ type: string }>;
  details?: unknown;
  isError?: boolean;
};

/** Publish ownership only for native conflict registrations from a remote read. */
export function bindRemoteResourceResult<T extends ResourceResult>(
  name: RemoteToolName,
  params: Record<string, unknown>,
  result: T,
  binding: string,
): T {
  if (name !== "read" || result.isError || typeof params.path !== "string") return result;
  // This metadata is produced by the remote runtime at ConflictHistory.register,
  // scoped to the current read. Never infer ownership from application text.
  const details = isRecord(result.details) ? result.details : {};
  const resources = isRecord(details.remoteResources) ? details.remoteResources : {};
  if (resources.binding !== undefined) {
    if (resources.binding !== binding) throw new Error("Remote conflict result belongs to a stale workspace binding");
    return result;
  }
  if (!binding) return result;
  const ids: unknown = resources.conflictIds;
  if (!Array.isArray(ids) || ids.length === 0
    || ids.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length) return result;
  const root = `${REMOTE_CONFLICT}${encodeURIComponent(binding)}/`;
  const references = ids.map(id => `#${id}: ${root}${id}`).join("\n");
  const text = `REMOTE CONFLICT REFERENCES (current workspace binding)\n${references}\nRead a bound reference (optionally /ours, /theirs, /base), or write it to resolve that remote block. Bulk remote writes use ${root}*. Use these bound references instead of the native conflict:// examples above; bare conflict:// references belong to the local session. Replacement content and per-id bulk directives are unchanged.`;
  return {
    ...result,
    content: [...result.content, { type: "text", text }],
    details: { ...details, remoteResources: { ...resources, binding } },
  } as T;
}
