import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveOmpHostVersion } from "../src/omp/host-identity.ts";
const root = resolve(import.meta.dir, "..");
const ompOutdir = resolve(root, "packages/omp/dist");
await mkdir(ompOutdir, { recursive: true });
{
  for (const entry of await readdir(ompOutdir)) {
    if (
      entry === "worker.js" ||
      entry.startsWith("CHANGELOG-") ||
      entry.startsWith("template-") ||
      entry.startsWith("tool-views.generated-")
    ) {
      await rm(resolve(ompOutdir, entry), { force: true });
    }
  }
}
{
  const hostVersion = await resolveOmpHostVersion();
  const extension = await Bun.build({
    entrypoints: [resolve(root, "src/extension.ts")],
    outdir: ompOutdir,
    target: "bun",
    format: "esm",
    minify: true,
    external: [
      "@oh-my-pi/pi-coding-agent",
      "@oh-my-pi/pi-agent-core",
      "@oh-my-pi/pi-natives",
    ],
    define: {
      "process.env.OMP_COMPILED_HOST_VERSION": JSON.stringify(hostVersion),
    },
  });
  if (!extension.success)
    throw new AggregateError(extension.logs, "OMP extension build failed");
}

