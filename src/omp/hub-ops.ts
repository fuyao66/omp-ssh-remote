const LAUNCH_OPS = new Set([
  "start",
  "ps",
  "logs",
  "stop",
  "restart",
  "describe",
]);

/**
 * Whether a hub call is a supervised-process (launch) operation. Mirrors the
 * native hub's own split: explicit process ops, or `send`/`wait` addressing a
 * process `name` rather than a peer/job. Shared by the local wrapper (routing)
 * and the remote worker (admission) so both sides agree on the boundary.
 * Dependency-free so the path-domain classifier can use it.
 */
export function isHubLaunchOperation(params: Record<string, unknown>): boolean {
  const op = params.op;
  if (typeof op !== "string") return false;
  if (LAUNCH_OPS.has(op)) return true;
  if (op !== "send" && op !== "wait") return false;
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) return false;
  if (typeof params.to === "string" && params.to.trim()) return false;
  if (typeof params.from === "string" && params.from.trim()) return false;
  return true;
}
