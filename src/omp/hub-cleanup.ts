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
 * Rejects if any owned process could not be stopped.
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
  const owned = listed.daemons.filter((daemon) =>
    daemon.owner === owner && !daemon.persist && !daemon.detached && !TERMINAL.has(daemon.state),
  );
  await Promise.all(owned.map(async (daemon) => {
    await client.request({ op: "stop", name: daemon.name, timeoutMs: 1_000 });
  }));
  return owned.map((daemon) => daemon.name);
}
