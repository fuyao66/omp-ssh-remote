import { resolveRemoteArtifacts } from "./artifacts.ts";

const artifactHead = /^(\s*)(remote-artifact:\/\/[a-f0-9-]{36}\/\d+)(?=[:/?#]|$)/;

async function resolveTarget(target: string): Promise<string> {
  const match = artifactHead.exec(target);
  if (!match) return target;
  // Resolve the resource, not URI selectors/queries (which may contain literals).
  return match[1]! + (await resolveRemoteArtifacts(match[2]!) as string) + target.slice(match[0].length);
}

/** Resolve artifact operands without traversing opaque tool data. */
export async function resolveRemoteArtifactArgs(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (toolName === "bash" && typeof args.command === "string" && args.command.includes("remote-artifact://")) {
    // Retain the established shell shorthand for artifact operands.
    return { ...args, command: await resolveRemoteArtifacts(args.command) };
  }
  if ((toolName === "read" || toolName === "grep") && typeof args.path === "string") {
    const path = toolName === "grep"
      ? (await Promise.all(args.path.split(";").map(resolveTarget))).join(";")
      : await resolveTarget(args.path);
    if (path !== args.path) return { ...args, path };
  }
  return args;
}
