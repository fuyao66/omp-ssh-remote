import { resolveRemoteArtifacts } from "./artifacts.ts";

const artifactHead = /^(\s*)(remote-artifact:\/\/[a-f0-9-]{36}\/\d+)(?=[:/?#]|$)/;

async function resolveTarget(target: string): Promise<string> {
  const match = artifactHead.exec(target);
  if (!match) return target;
  // Resolve the resource, not URI selectors/queries (which may contain literals).
  return match[1]! + await resolveRemoteArtifacts(match[2]!) + target.slice(match[0].length);
}

/** Native reads retain immutable URL semantics; only query extraction and grep need a file operand. */
export async function resolveRemoteArtifactArgs(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ((toolName === "grep" || (toolName === "read" && typeof args.path === "string" && args.path.includes("?"))) && typeof args.path === "string") {
    const path = toolName === "grep"
      ? (await Promise.all(args.path.split(";").map(resolveTarget))).join(";")
      : await resolveTarget(args.path);
    if (path !== args.path) return { ...args, path };
  }
  return args;
}
