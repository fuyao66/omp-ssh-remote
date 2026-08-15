import { RemoteRuntimeClient } from "../src/client.ts";
import { ensureRemoteWorker } from "../src/deploy.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

const target = Bun.env.REMOTE_TARGET;
const cwd = Bun.env.REMOTE_CWD;
const identityFile = Bun.env.REMOTE_IDENTITY;
const knownHostsFile = Bun.env.REMOTE_KNOWN_HOSTS;
const port = Number(Bun.env.REMOTE_PORT ?? "22");
if (!target || !cwd || !identityFile || !knownHostsFile) {
  throw new Error(
    "REMOTE_TARGET, REMOTE_CWD, REMOTE_IDENTITY, and REMOTE_KNOWN_HOSTS are required",
  );
}

const options = {
  target,
  port,
  identityFile,
  knownHostsFile,
  localWorkerPath: new URL("../dist/worker-linux-arm64", import.meta.url)
    .pathname,
};
const workerPath = await ensureRemoteWorker(options);
const client = new RemoteRuntimeClient({
  command: buildSshWorkerCommand({ ...options, workerPath }),
});
try {
  const ready = await client.initialize(cwd);
  if (ready.cwd !== cwd) throw new Error(`Unexpected remote cwd: ${ready.cwd}`);

  const content = `remote-arm64-${Date.now()}`;
  await client.execute("write", "remote-write", {
    path: "probe.txt",
    content: `${content}\n`,
  });
  const read = await client.execute("read", "remote-read", {
    path: "probe.txt",
  });
  const readText = JSON.stringify(read);
  const header = readText.match(/\[probe\.txt#[A-F0-9]+\]/)?.[0];
  if (!header || !readText.includes(content))
    throw new Error("Remote native read did not return hashline content");

  await client.execute("edit", "remote-edit", {
    input: `${header}\nPUT 1.=1:\n+edited-${content}`,
  });
  const grep = await client.execute("grep", "remote-grep", {
    pattern: `edited-${content}`,
    path: ".",
  });
  const glob = await client.execute("glob", "remote-glob", { path: "*.txt" });
  const bash = await client.execute("bash", "remote-bash", {
    command:
      'printf \'user=%s\\nhost=%s\\ncwd=%s\\n\' "$(whoami)" "$(hostname)" "$PWD"; cat probe.txt',
  });
  const grepText = JSON.stringify(grep);
  const globText = JSON.stringify(glob);
  const bashText = JSON.stringify(bash);
  if (!grepText.includes("probe.txt") || !globText.includes("probe.txt"))
    throw new Error("Remote grep/glob did not observe edit");
  if (
    !bashText.includes(`cwd=${cwd}`) ||
    !bashText.includes(`edited-${content}`)
  ) {
    throw new Error(`Remote bash did not observe the remote edit: ${bashText}`);
  }
  console.log(
    JSON.stringify({
      cwd: ready.cwd,
      workerPath,
      tools: ready.tools.map((tool) => tool.name),
      deployment: "ok",
      nativeTools: "ok",
    }),
  );
} finally {
  await client.close();
}
