import { prepareRemoteWorker } from "../src/deploy.ts";
import { RemoteRuntimeClient } from "../src/client.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

async function main() {
  console.log("Starting Live Smoke Test for Remote Pi + AFT Tools on trialsfinder...");

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

  // Test 1: Remote Write a sample TS file on trialsfinder
  const testFilePath = "/root/aft-smoke-test.ts";
  const sampleCode = `
export interface UserProfile {
  id: string;
  name: string;
}

export function computeUserScore(user: UserProfile): number {
  return user.name.length * 10;
}
`;
  console.log("[smoke] Testing remote write...");
  await client.execute("write", "write-1", {
    path: testFilePath,
    content: sampleCode,
  });

  // Test 2: Remote AST Grep Pattern Search via AFT engine
  console.log("[smoke] Testing remote ast_grep_search via remote AFT engine...");
  const astRes = await client.execute("ast_grep_search" as any, "ast-1", {
    pattern: "computeUserScore($$$ARGS)",
    lang: "typescript",
    paths: [testFilePath],
  });
  console.log("[smoke] ast_grep_search result:", JSON.stringify(astRes, null, 2));

  // Test 3: Remote AFT Outline via AFT engine
  console.log("[smoke] Testing remote aft_outline via remote AFT engine...");
  const outlineRes = await client.execute("aft_outline" as any, "outline-1", {
    target: testFilePath,
  });
  console.log("[smoke] aft_outline result:", JSON.stringify(outlineRes, null, 2));

  // Cleanup test file
  await client.execute("bash", "clean-1", {
    command: `rm -f ${testFilePath}`,
  });

  await client.close();
  console.log("[smoke] All Remote AFT & Pi smoke tests passed cleanly!");
}

main().catch((err) => {
  console.error("AFT smoke test failed:", err);
  process.exit(1);
});
