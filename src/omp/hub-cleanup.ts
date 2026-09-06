import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { canonicalProjectDir, daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import { readLiveDaemonBrokerPid } from "@oh-my-pi/pi-coding-agent/launch/presence";

const TERMINAL = new Set(["exited", "failed"]);

/**
 * Stop every non-persist supervised process this owner started in the project
 * broker. Called when the remote worker tears down (remote-exit, transport
 * loss, session shutdown): a service started from a now-gone local session
 * has no one to observe it. `persist`/`detached` daemons are deliberately
 * left alone; that is the user's explicit survival request.
 *
 * Returns the names stopped. Never throws for individual stop failures.
 */
export async function stopOwnedRemoteDaemons(
  projectDir: string,
  owner: string,
): Promise<string[]> {
  // Never spawn a broker just to ask it for nothing: teardown of a worker
  // that never launched anything must not leave a fresh idle broker behind.
  const canonical = await canonicalProjectDir(projectDir);
  if ((await readLiveDaemonBrokerPid(daemonRuntimeDir(canonical))) === undefined) return [];
  const client = await daemonClientForProject(projectDir);
  const listed = await client.request({ op: "list" });
  if (listed.op !== "list") return [];
  const stopped: string[] = [];
  for (const daemon of listed.daemons) {
    if (daemon.owner !== owner) continue;
    if (daemon.persist || daemon.detached) continue;
    if (TERMINAL.has(daemon.state)) continue;
    try {
      await client.request({ op: "stop", name: daemon.name, timeoutMs: 5_000 });
      stopped.push(daemon.name);
    } catch {
      // Best effort; broker shutdown's own idle path is the backstop.
    }
  }
  return stopped;
}
