import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
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
  // Native postmortem closes the shared client cache concurrently with other
  // callbacks. Teardown owns an independent connection until its stops finish.
  const client = await createDaemonBrokerClient(canonical);
  try {
    const listed = await client.request({ op: "list" }, AbortSignal.timeout(10_000));
    if (listed.op !== "list") throw new Error("Unexpected daemon list response during owner cleanup");
    const owned = listed.daemons.filter((daemon) =>
      daemon.owner === owner && !daemon.persist && !daemon.detached && !TERMINAL.has(daemon.state),
    );
    await Promise.all(owned.map(async (daemon) => {
      const result = await client.request({ op: "stop", name: daemon.name, id: daemon.id, timeoutMs: 1_000 }, AbortSignal.timeout(10_000));
      if (result.op !== "stop" || (result.daemon.id === daemon.id && !TERMINAL.has(result.daemon.state)))
        throw new Error(`Remote service ${daemon.name} (${daemon.id}) did not stop`);
    }));
    return owned.map((daemon) => daemon.name);
  } finally {
    client.close();
  }
}
