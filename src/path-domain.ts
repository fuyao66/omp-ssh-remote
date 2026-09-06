import type { RemoteToolName } from "./protocol.ts";
import { isHubLaunchOperation } from "./omp/hub-ops.ts";

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function isInternalUri(path: string): boolean {
  return URI_SCHEME.test(path);
}

export function normalizePathArgument(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const hashline = /^\[([^\]]+)#[A-F0-9]{4,}\]$/.exec(trimmed);
  return hashline?.[1] ?? trimmed;
}

function classifyPathDomains(paths: string[]): boolean {
  const concrete = paths.map((path) => path.trim()).filter(Boolean);
  const hasLocal = concrete.some((path) => isInternalUri(path) && !path.startsWith("remote-artifact://"));
  const hasRemote = concrete.some((path) => !isInternalUri(path) || path.startsWith("remote-artifact://"));
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
): boolean {
  if (tool === "bash" || tool === "eval") return false;
  // hub: supervised-process ops run where the project lives; peer messaging
  // and job control are local control-plane operations.
  if (tool === "hub") return !isHubLaunchOperation(params);
  if (tool === "debug") {
    const paths = [params.program, params.cwd, params.file].filter(
      (path): path is string => typeof path === "string",
    );
    return classifyPathDomains(paths);
  }
  if (tool === "edit") {
    const input = typeof params.input === "string" ? params.input : "";
    const paths = input
      .split("\n")
      .filter((line) => line.startsWith("[") && line.endsWith("]"))
      .map((line) =>
        line
          .slice(1, -1)
          .replace(/^\*\*\* Update File:\s*/, "")
          .replace(/#[A-F0-9]{4,}$/, ""),
      );
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
