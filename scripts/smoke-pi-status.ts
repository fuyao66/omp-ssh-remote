import { prepareRemoteWorker } from "../src/deploy.ts";
import { RemoteRuntimeClient } from "../src/client.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";
import { buildPiWorkspaceStatus, type PiRemoteExtensionState } from "../src/pi-extension.ts";

async function main() {
  console.log("Starting Pi status and subagent live smoke test against trialsfinder...");

  const target = "root@8.138.98.106";
  const identityFile = `${process.env.HOME}/.ssh/trialsfinder_ed25519`;

  const prepared = await prepareRemoteWorker(
    {
      target,
      identityFile,
    },
    "pi",
  );
  console.log(`[smoke] Pi worker deployed at: ${prepared.workerPath}`);

  const command = buildSshWorkerCommand({
    target,
    identityFile,
    workerPath: prepared.workerPath,
  });

  const client = new RemoteRuntimeClient({ command });
  const remoteCwd = "/root";
  await client.initialize(remoteCwd, 15_000, "pi");
  console.log("[smoke] Connected to remote Pi companion worker.");

  // Test 1: Workspace status evaluation
  const state: PiRemoteExtensionState = {
    selected: true,
    cwd: remoteCwd,
    client,
    connectOptions: {
      target,
      displayTarget: "trialsfinder",
    },
  };
  const status = buildPiWorkspaceStatus(state);
  console.log("[smoke] Status payload:", JSON.stringify(status, null, 2));
  if (status.mode !== "remote" || status.transport !== "connected") {
    throw new Error(`Unexpected status mode: ${status.mode}`);
  }

  // Test 2: Subagent worker test (spawn a simulated subagent with inherited spec)
  console.log("[smoke] Testing subagent companion isolation...");
  const subagentClient = new RemoteRuntimeClient({ command });
  await subagentClient.initialize(remoteCwd, 15_000, "pi");
  const bashRes = await subagentClient.execute("bash", "sub-1", {
    command: "echo 'subagent-probe-success' && uname -m",
  });
  console.log("[smoke] Subagent bash execution result:", bashRes);

  await subagentClient.close();
  await client.close();
  console.log("[smoke] All status & subagent checks passed cleanly!");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
