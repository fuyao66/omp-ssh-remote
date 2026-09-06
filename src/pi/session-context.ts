import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHANNEL = "pi-ssh-remote:session-context";
const KEY = Symbol.for("pi-ssh-remote/session-contexts");
const host = globalThis as typeof globalThis & { [KEY]?: Map<string, object> };
const sessions = host[KEY] ??= new Map<string, object>();

/** ExtensionAPI.events is a per-extension facade, not the shared event bus identity. */
export function publishSessionContext(pi: ExtensionAPI, getKey: () => object): void {
  pi.events.on(CHANNEL, (message: unknown) => {
    if (message && typeof message === "object" && "accept" in message && typeof message.accept === "function") message.accept(getKey());
  });
}
export function requestSessionContext(pi: ExtensionAPI): object {
  let key: object | undefined;
  pi.events.emit(CHANNEL, { accept(value: object) { key = value; } });
  if (!key) throw new Error("Load Pi SSH Remote before managed workspace plugins");
  return key;
}
export function restoreSessionContext(ctx: ExtensionContext, initial: object): object {
  const id = ctx.sessionManager.getSessionId();
  const existing = sessions.get(id);
  if (existing) return existing;
  sessions.set(id, initial);
  return initial;
}
export function releaseSessionContext(ctx: ExtensionContext): void {
  sessions.delete(ctx.sessionManager.getSessionId());
}
