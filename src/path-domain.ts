import { editInspect, type EditInspection } from "@oh-my-pi/pi-natives";
import { recoverConflictUriPrefix } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import type { OmpEditMode, RemoteToolName } from "./protocol.ts";

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function isInternalUri(path: string): boolean {
  return URI_SCHEME.test(path);
}

export function normalizePathArgument(value: unknown): string {
  if (typeof value !== "string") return "";
  return recoverConflictUriPrefix(unwrapHashlineHeaderPath(value.trim())).path;
}

function classifyPathDomains(paths: string[]): boolean {
  const concrete = paths.map(normalizePathArgument).filter(Boolean);
  const isRemote = (path: string) => !isInternalUri(path) || path.startsWith("remote-artifact://") || path.startsWith("proc://") || path.startsWith("remote-conflict://");
  const hasLocal = concrete.some((path) => !isRemote(path));
  const hasRemote = concrete.some(isRemote);
  if (hasLocal && hasRemote) {
    throw new Error(
      "One tool call cannot mix local internal URIs with remote filesystem paths",
    );
  }
  return hasLocal;
}

export function pathShouldStayLocal(
  tool: RemoteToolName,
  params: Record<string, unknown>,
  editMode: OmpEditMode = "hashline",
): boolean {
  if (tool === "bash" || tool === "eval") return false;
  if (tool === "debug") {
    const paths = [params.program, params.cwd, params.file].filter(
      (path): path is string => typeof path === "string",
    );
    return classifyPathDomains(paths);
  }
  if (tool === "edit") {
    if (!["replace", "patch", "apply_patch", "hashline", "sloppy"].includes(editMode)) {
      throw new Error(`Cannot classify edit paths for unsupported mode: ${editMode}`);
    }
    let inspection: EditInspection;
    try {
      inspection = editInspect(editMode, JSON.stringify(params));
    } catch {
      throw new Error(`Cannot classify edit paths: native ${editMode} patch inspection failed`);
    }
    const paths = [...inspection.paths];
    for (const op of inspection.fileOps) {
      if (op.kind === "move" && op.to !== undefined) paths.push(op.to);
    }
    if (paths.length === 0) {
      throw new Error(`Cannot classify edit paths: native ${editMode} patch inspection found no targets`);
    }
    return classifyPathDomains(paths);
  }
  const paths: string[] = [];
  if (typeof params.path === "string") paths.push(...params.path.split(";"));
  if (Array.isArray(params.paths))
    paths.push(
      ...params.paths.filter(
        (path): path is string => typeof path === "string",
      ),
    );
  if (typeof params.file === "string") paths.push(params.file);
  return classifyPathDomains(paths);
}
