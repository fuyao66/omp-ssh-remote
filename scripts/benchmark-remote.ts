import { RemoteRuntimeClient } from "../src/client.ts";
import { ensureRemoteWorker } from "../src/deploy.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

const target = Bun.env.REMOTE_TARGET;
const cwd = Bun.env.REMOTE_CWD;
const identityFile = Bun.env.REMOTE_IDENTITY;
const knownHostsFile = Bun.env.REMOTE_KNOWN_HOSTS;
const port = Number(Bun.env.REMOTE_PORT ?? "22");
if (!target || !cwd || !identityFile || !knownHostsFile) throw new Error("Remote benchmark environment is incomplete");

const options = {
  target,
  port,
  identityFile,
  knownHostsFile,
  localWorkerPath: new URL("../dist/worker-linux-arm64", import.meta.url).pathname,
};
const milliseconds = (start: number): number => Math.round((performance.now() - start) * 100) / 100;
const percentile = (samples: number[], ratio: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
};
const sample = async (count: number, call: (index: number) => Promise<unknown>): Promise<number[]> => {
  const timings: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await call(index);
    timings.push(milliseconds(started));
  }
  return timings;
};

let started = performance.now();
const workerPath = await ensureRemoteWorker(options);
const deployCacheMs = milliseconds(started);
const client = new RemoteRuntimeClient({ command: buildSshWorkerCommand({ ...options, workerPath }) });
try {
  started = performance.now();
  await client.initialize(cwd);
  const initializeMs = milliseconds(started);
  await client.execute("write", "benchmark-write", { path: "benchmark.txt", content: "benchmark\n" });

  const reads = await sample(12, index => client.execute("read", `benchmark-read-${index}`, { path: "benchmark.txt" }));
  const shells = await sample(8, index => client.execute("bash", `benchmark-bash-${index}`, { command: ":" }));
  const lsp = await sample(3, index =>
    client.execute("write", `benchmark-lsp-${index}`, {
      path: "xd://lsp",
      content: JSON.stringify({ action: "status" }),
    }),
  );
  console.log(JSON.stringify({
    deployCacheMs,
    initializeMs,
    read: { p50: percentile(reads, 0.5), p95: percentile(reads, 0.95), samples: reads },
    bash: { p50: percentile(shells, 0.5), p95: percentile(shells, 0.95), samples: shells },
    lspStatus: { p50: percentile(lsp, 0.5), p95: percentile(lsp, 0.95), samples: lsp },
  }));
} finally {
  await client.close();
}
