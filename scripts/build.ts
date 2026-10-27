import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveOmpBuildVersion } from "../src/omp/host-identity.ts";
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
  const hostVersion = await resolveOmpBuildVersion(root);
  const extension = await Bun.build({
    entrypoints: [resolve(root, "src/extension.ts")],
    outdir: ompOutdir,
    target: "bun",
    format: "esm",
    minify: true,
    plugins: [{
      name: "omp-ssh-remote:renderer-imports",
      setup(build) {
        // The compiled host exposes the agent-core root, but not this new
        // renderer dependency's subpath. Bundle its stateless definitions.
        build.onResolve({ filter: /^@oh-my-pi\/pi-agent-core\/thinking$/ }, () => ({
          path: Bun.resolveSync("@oh-my-pi/pi-agent-core/thinking", root),
        }));
        // Pure source adapters are not all exposed by the compiled host shim.
        build.onResolve({ filter: /^@oh-my-pi\/pi-coding-agent\/async$/ }, () => ({
          path: Bun.resolveSync("@oh-my-pi/pi-coding-agent/async/auto-background", root),
        }));
        build.onResolve({ filter: /^@oh-my-pi\/pi-coding-agent\/job-widgets\/pipe-source$/ }, () => ({
          path: Bun.resolveSync("@oh-my-pi/pi-coding-agent/job-widgets/pipe-source", root),
        }));
      },
    }],
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

