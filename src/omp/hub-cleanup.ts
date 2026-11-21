import { canonicalProjectDir, probeDaemon } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { projectScope } from "@oh-my-pi/pi-coding-agent/daemon/protocol";

const TERMINAL = new Set(["exited", "failed"]);

/**
 * Stop the session-held services this companion launched, without starting or upgrading a daemon.
 * Owner alone is not enough: a replacement companion for the same session may already run its own.
 */
export async function stopOwnedRemoteDaemons(projectDir: string, owner: string, generations: ReadonlySet<string>): Promise<string[]> {
  if (generations.size === 0) return [];
  const scope = projectScope(await canonicalProjectDir(projectDir));
  // Native postmortem independently closes its shared client. An existing-only
  // probe owns a separate connection until our scoped stops finish.
  const client = await probeDaemon();
  if (!client) return [];
  try {
    const { units } = await client.request({ op: "list", scope, kind: "proc" }, AbortSignal.timeout(10_000));
    const owned = units.filter(unit =>
      unit.owner === owner && generations.has(unit.generation) && unit.policy.hold === "leases" && !TERMINAL.has(unit.state),
    );
    await Promise.all(owned.map(async ({ key, generation }) => {
      const { unit } = await client.request({
        op: "stop", unit: { kind: "proc", scope, key }, generation, timeoutMs: 1_000,
      }, AbortSignal.timeout(10_000));
      if (unit.generation === generation && !TERMINAL.has(unit.state))
        throw new Error(`Remote service ${key} (${generation}) did not stop`);
    }));
    return owned.map(unit => unit.key);
  } finally {
    client.close();
  }
}
