import { resolveRemoteHome, prepareRemoteWorker } from "../src/deploy.ts";
import { RemoteRuntimeClient } from "../src/client.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

console.log("Starting live Pi remote smoke test on trialsfinder...");

const options = {
  target: "root@trialsfinder",
  host: "trialsfinder",
  user: "root",
  port: 22,
  identityFile: "~/.ssh/trialsfinder_ed25519",
};
try {
  const remoteHome = await resolveRemoteHome(options);
  console.log(`[1] Resolved remote home: ${remoteHome}`);

  const prepared = await prepareRemoteWorker(options, "pi");
  console.log(`[2] Prepared remote worker at: ${prepared.workerPath}`);
  const command = buildSshWorkerCommand({
    ...options,
    workerPath: prepared.workerPath,
  });

  const testCwd = `${remoteHome}/.cache/omp-ssh-remote/pi-test-smoke`;
  const client = new RemoteRuntimeClient({ command });
  console.log(`[3] Initializing client with cwd: ${testCwd}...`);
  const ready = await client.initialize(testCwd, 20_000, "pi");
  console.log(`[4] Ready received! Host: ${ready.host}, tools: ${ready.tools.map((t) => t.name).join(", ")}`);

  // 1. Write file
  console.log("[5] Testing remote write...");
  const writeRes = await client.execute("write", "call-write-1", {
    path: "remote-probe.txt",
    content: `Pi Remote Runtime Probe Test ${Date.now()}\n`,
  });
  console.log("Write response:", JSON.stringify(writeRes));

  // 2. Read file
  console.log("[6] Testing remote read...");
  const readRes = (await client.execute("read", "call-read-1", {
    path: "remote-probe.txt",
  })) as { content: Array<{ type: string; text?: string }> };
  console.log("Read response:", JSON.stringify(readRes));
  if (!readRes.content?.[0]?.text?.includes("Pi Remote Runtime Probe Test")) {
    throw new Error("Read content did not match written content!");
  }

  // 3. Bash execute
  console.log("[7] Testing remote bash...");
  const bashRes = (await client.execute("bash", "call-bash-1", {
    command: "uname -a && pwd && cat remote-probe.txt",
  })) as { content: Array<{ type: string; text?: string }> };
  console.log("Bash output:", bashRes.content?.[0]?.text);

  // 4. Ls & Find
  console.log("[8] Testing remote ls...");
  const lsRes = await client.execute("ls", "call-ls-1", {});
  console.log("Ls output:", JSON.stringify(lsRes));

  // Clean up
  await client.close();
  console.log("[9] Remote client closed cleanly.");
  console.log("=== Pi Live Remote Smoke Test PASSED! ===");
} catch (err) {
  console.error("Live smoke test failed:", err);
  process.exit(1);
}
