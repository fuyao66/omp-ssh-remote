import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { PI_AFT_PROFILE } from "../src/pi/profiles/pi-aft.ts";
import {
  loadConfiguredSshHosts,
  parseConnectArgs,
} from "../src/connect-options.ts";
import { prepareRemoteWorker } from "../src/deploy.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";

type Host = "omp" | "pi";

const host = process.argv[2] as Host | undefined;
if (host !== "omp" && host !== "pi") {
  throw new Error(`Usage: bun scripts/benchmark-remote.ts <omp|pi>`);
}
const target = process.env.REMOTE_ALIAS ?? process.env.REMOTE_TARGET;
const requestedCwd = process.env.REMOTE_CWD;
if (!target) throw new Error("REMOTE_ALIAS or REMOTE_TARGET is required");

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

const configuredHosts = await loadConfiguredSshHosts(process.cwd());
const args = [quote(target)];
if (requestedCwd) args.push(quote(requestedCwd));
if (process.env.REMOTE_PORT) args.push("--port", process.env.REMOTE_PORT);
if (process.env.REMOTE_IDENTITY)
  args.push("--identity", quote(process.env.REMOTE_IDENTITY));
if (process.env.REMOTE_KNOWN_HOSTS)
  args.push("--known-hosts", quote(process.env.REMOTE_KNOWN_HOSTS));
const connection = parseConnectArgs(args.join(" "), configuredHosts);

const milliseconds = (started: number): number =>
  Math.round((performance.now() - started) * 100) / 100;
const percentile = (samples: number[], ratio: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  );
};
const sample = async (
  count: number,
  call: (index: number) => Promise<unknown>,
): Promise<number[]> => {
  const timings: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await call(index);
    timings.push(milliseconds(started));
  }
  return timings;
};
const summary = (samples: number[]) => ({
  p50: percentile(samples, 0.5),
  p95: percentile(samples, 0.95),
  samples,
});

const localArtifactDir = new URL(`../packages/${host}/dist/`, import.meta.url)
  .pathname;
const runtime = host === "pi" ? PI_AFT_PROFILE : undefined;
let started = performance.now();
const prepared = await prepareRemoteWorker(
  { ...connection, localArtifactDir },
  runtime?.workerBundle,
);
const deployCacheMs = milliseconds(started);
const cwd = requestedCwd ?? prepared.home;
if (!cwd) throw new Error("Remote cwd and probed remote home are unavailable");
const client = new RemoteRuntimeClient({
  command: buildSshWorkerCommand({
    ...connection,
    workerPath: prepared.workerPath,
  }),
});
const benchmarkFile = `.ssh-remote-benchmark-${host}-${process.pid}.ts`;
try {
  started = performance.now();
  const ready = await client.initialize(
    cwd,
    runtime?.handshake ?? OMP_RUNTIME_HANDSHAKE,
    30_000,
  );
  const initializeMs = milliseconds(started);
  await client.execute("write", "benchmark-write", {
    path: benchmarkFile,
    content: "export interface RemoteBenchmark { id: string }\n",
  });

  const reads = await sample(12, (index) =>
    client.execute("read", `benchmark-read-${index}`, { path: benchmarkFile }),
  );
  const shells = await sample(8, (index) =>
    client.execute("bash", `benchmark-bash-${index}`, { command: ":" }),
  );

  const hostSpecific =
    host === "omp"
      ? {
          lspStatus: summary(
            await sample(3, (index) =>
              client.execute("write", `benchmark-lsp-${index}`, {
                path: "xd://lsp",
                content: JSON.stringify({ action: "status" }),
              }),
            ),
          ),
        }
      : {
          aftOutline: summary(
            await sample(8, (index) =>
              client.execute("aft_outline", `benchmark-aft-${index}`, {
                target: benchmarkFile,
              }),
            ),
          ),
        };

  console.log(
    JSON.stringify({
      host,
      remotePlatform: ready.capabilities?.aftHostRuntime ?? ready.ompVersion,
      toolCount: ready.tools.length,
      deployCacheMs,
      initializeMs,
      read: summary(reads),
      bash: summary(shells),
      ...hostSpecific,
    }),
  );
} finally {
  if (!client.isClosed) {
    try {
      await client.execute("bash", "benchmark-cleanup", {
        command: `rm -f -- ${quote(benchmarkFile)}`,
      });
    } catch {}
    await client.close().catch(() => client.kill());
  }
}
