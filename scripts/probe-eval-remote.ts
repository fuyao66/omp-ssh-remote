import { RemoteRuntimeClient } from "../src/client.ts";
import { ensureRemoteWorker } from "../src/deploy.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

const target = Bun.env.REMOTE_TARGET;
const cwd = Bun.env.REMOTE_CWD;
const identityFile = Bun.env.REMOTE_IDENTITY;
const knownHostsFile = Bun.env.REMOTE_KNOWN_HOSTS;
const port = Number(Bun.env.REMOTE_PORT ?? "22");
if (!target || !cwd || !identityFile || !knownHostsFile) throw new Error("Remote probe environment is incomplete");

const options = {
  target,
  cwd,
  port,
  identityFile,
  knownHostsFile,
  localArtifactDir: new URL("../packages/omp/dist/", import.meta.url).pathname,
};
const started = performance.now();
const log = (phase: string): void => console.error(`${phase} ${Math.round(performance.now() - started)}ms`);
const run = async (client: RemoteRuntimeClient, id: string, args: Record<string, unknown>): Promise<unknown> => {
  log(`${id}:start`);
  const signal = AbortSignal.timeout(20_000);
  const result = await client.execute("eval", id, args, signal);
  log(`${id}:done`);
  return result;
};

log("deploy:start");
const workerPath = await ensureRemoteWorker(options);
log("deploy:done");
const client = new RemoteRuntimeClient({ command: buildSshWorkerCommand({ ...options, workerPath }) });
try {
  await client.initialize(cwd);
  log("initialize:done");
  const py1 = await run(client, "py-setup", { language: "py", title: "setup", code: "remote_value = 40" });
  const py2 = await run(client, "py-use", { language: "py", title: "reuse", code: "print(remote_value + 2)" });
  const js1 = await run(client, "js-setup", { language: "js", title: "setup", code: "globalThis.remoteValue = 6" });
  const js2 = await run(client, "js-use", { language: "js", title: "reuse", code: "print(globalThis.remoteValue * 7)" });
  console.log(JSON.stringify({ py1, py2, js1, js2 }));
} finally {
  log("close:start");
  await client.close();
  log("close:done");
}
