import { resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/** Resolve live ownership, not AgentRef.sessionFile's registration-time snapshot. */
export function resolveHostSessionRef(
  sessionFile: string | undefined,
  ctx?: Pick<ExtensionContext, "agent" | "sessionManager">,
  registry: AgentRegistry = AgentRegistry.global(),
) {
  const refs = registry.list();
  if (ctx) {
    const owner = refs.find(ref => ref.id === ctx.agent?.id);
    if (owner?.session?.sessionManager === ctx.sessionManager) return owner;
    // Never let a stale/incorrect agent id select another session sharing a path.
    return refs.find(ref => ref.session?.sessionManager === ctx.sessionManager);
  }
  if (!sessionFile) return undefined;
  const file = resolve(sessionFile);
  return refs.find(ref => {
    const liveFile = ref.session?.sessionManager?.getSessionFile();
    return liveFile !== undefined && resolve(liveFile) === file;
  });
}
