import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { PI_VERSION } from "../src/protocol.ts";

type Target = "arm64" | "x64";

const targetArg = process.argv[2] as Target | undefined;
if (targetArg !== "arm64" && targetArg !== "x64") {
  throw new Error("Usage: bun scripts/compile-pi-worker.ts <arm64|x64>");
}
const target: Target = targetArg;
const bunTarget = target === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, `pi-worker-linux-${target}`);
await mkdir(dist, { recursive: true });

console.log(`Compiling Pi worker for ${target}...`);

const result = await Bun.build({
  entrypoints: [resolve(root, "src/pi-worker.ts")],
  compile: {
    target: bunTarget,
    outfile,
  },
  minify: false,
});

if (!result.success) {
  throw new AggregateError(result.logs, `Pi ${target} worker compile failed`);
}

await chmod(outfile, 0o755);
const workerHash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(outfile).arrayBuffer())
  .digest("hex");
await writeFile(`${outfile}.sha256`, `${workerHash}\n`);
console.log(`Pi ${target} worker compiled to ${outfile} (${workerHash})`);
