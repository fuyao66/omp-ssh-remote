import { resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

/** Resolve live ownership, not AgentRef.sessionFile's registration-time snapshot. */
export function resolveHostSessionRef(
  sessionFile: string | undefined,
  ctx?: Pick<ExtensionContext, "agent" | "sessionManager">,
  registry: AgentRegistryApi = AgentRegistry.global(),
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

/** Full tool/session APIs are available only on the session's actual home thread. */
export function resolveLocalHostSession(
  sessionFile: string | undefined,
  ctx?: Pick<ExtensionContext, "agent" | "sessionManager">,
  registry: AgentRegistryApi = AgentRegistry.global(),
) {
  const session = resolveHostSessionRef(sessionFile, ctx, registry)?.session;
  return session && isLocalAgentSession(session) ? session : undefined;
}
