import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { adaptNativeMutationSettlement } from "../src/omp/native-mutation-adapter.ts";
import { SDK_SOURCE_ADAPTATIONS, SUPPORTED_SDK_VERSION, assertSdkBuildAdaptations } from "../src/omp/sdk-contract.ts";
import { lspFixtureSource } from "../scripts/fixtures/lsp-server.ts";

const root = resolve(import.meta.dir, "..");

test("mutation adapters reject unsupported SDKs and every missing or duplicate registered anchor", async () => {
  for (const adaptation of SDK_SOURCE_ADAPTATIONS) {
    if (adaptation.kind !== "mutation") continue;
    const source = await readFile(Bun.resolveSync(adaptation.sdkModule, root), "utf8");
    const apply = (input: string, version: string = SUPPORTED_SDK_VERSION) =>
      adaptNativeMutationSettlement(input, version, adaptation.module, "fence.ts");
    const errorContext = `${adaptation.id} (${adaptation.sdkModule}; upstream ${adaptation.upstreamPath})`;
    expect(apply(source)).not.toBe(source);
    expect(() => apply(source, "unsupported-sdk")).toThrow(`${errorContext} requires SDK ${SUPPORTED_SDK_VERSION}`);
    for (const [anchorId, anchor] of Object.entries(adaptation.anchors)) {
      expect(() => apply(source.replace(anchor.text, ""))).toThrow(`${errorContext} anchor drift at ${anchorId}: expected ${anchor.expectedCount}, got 0`);
      expect(() => apply(`${source}\n${anchor.text}`)).toThrow(`${errorContext} anchor drift at ${anchorId}: expected ${anchor.expectedCount}, got 2`);
    }
  }
});

test("worker coverage requires every registered SDK adaptation exactly once", () => {
  const counts = new Map<string, number>(SDK_SOURCE_ADAPTATIONS.map(adaptation => [adaptation.id, adaptation.expectedBuildCount]));
  expect(() => assertSdkBuildAdaptations(counts)).not.toThrow();
  for (const adaptation of SDK_SOURCE_ADAPTATIONS) {
    for (const count of [0, 2]) {
      const invalid = new Map(counts);
      invalid.set(adaptation.id, count);
      expect(() => assertSdkBuildAdaptations(invalid)).toThrow(`${adaptation.id} (${adaptation.sdkModule}; upstream ${adaptation.upstreamPath}) build coverage`);
    }
  }
});

test("actual adapted native WriteTool waits for an aborted filesystem primitive before operation end", async () => {
  await mkdir(join(root, ".cache"), { recursive: true });
  const cwd = await mkdtemp(join(root, ".cache/native-mutation-fence-"));
  const entry = join(cwd, "entry.ts"); const outfile = join(cwd, "bundle.mjs");
  await writeFile(entry, `export { createNativeWorkerRuntime } from ${JSON.stringify(join(root, "src/runtime.ts"))};
    export { createLspWritethrough } from "@oh-my-pi/pi-coding-agent/lsp/writethrough";
    export { shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";`);
  try {
    const built = await Bun.build({ entrypoints: [entry], outdir: cwd, naming: "bundle.mjs", target: "bun", format: "esm", external: ["@oh-my-pi/pi-natives"],
      plugins: [{ name: "actual-native-mutation-fence", setup(build) {
        build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({ path: "omp-legacy-pi-modules", namespace: "mutation-fence-test" }));
        build.onLoad({ filter: /^omp-legacy-pi-modules$/, namespace: "mutation-fence-test" }, () => ({
          contents: "export const BUNDLED_PI_MODULE_LOADERS = {};", loader: "js",
        }));
        build.onLoad({ filter: /[/\\](?:tools[/\\](?:write|ast-edit)|lsp[/\\]writethrough)\.ts$/ }, async args => {
          if (!args.path.includes("@oh-my-pi/pi-coding-agent/")) return;
          const module = args.path.endsWith("writethrough.ts") ? "writethrough" : args.path.endsWith("ast-edit.ts") ? "ast-edit" : "write";
          return { loader: "ts", contents: adaptNativeMutationSettlement(await readFile(args.path, "utf8"), SUPPORTED_SDK_VERSION, module,
            join(root, "src/omp/mutation-settlement.ts")) };
        });
      } }],
    });
    if (!built.success) throw new AggregateError(built.logs, "Native mutation test bundle failed");
    // This temporary module is built above with the actual native source adaptations.
    // A static import would instead load the unadapted SDK and cannot test this boundary.
    const { createNativeWorkerRuntime, createLspWritethrough, shutdownAll } = await import(outfile);
    const operations: string[] = [];
    const runtime = await createNativeWorkerRuntime(cwd, {
      settings: { "lsp.diagnosticsOnWrite": false, "lsp.formatOnWrite": false },
      onLspOperation: (_event: unknown, phase: string) => operations.push(phase),
    });
    const target = join(cwd, "controlled.ts"); const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const original = Bun.write;
    const intercepted = new Proxy(original, {
      async apply(write, receiver, args) {
        if (String(args[0]) === target) { started.resolve(); await release.promise; }
        return Reflect.apply(write, receiver, args);
      },
    });
    Bun.write = intercepted;
    const controller = new AbortController(); let settled = false;
    const pending = runtime.tools.write.execute("write", { path: target, content: "committed" }, controller.signal)
      .then(() => { settled = true; }, () => { settled = true; });
    try {
      await started.promise; controller.abort(new Error("cancelled")); await Promise.resolve();
      expect(settled).toBe(false); expect(operations).toEqual(["begin"]);
      release.resolve(); await pending;
      expect(await readFile(target, "utf8")).toBe("committed");
      expect(operations).toEqual(["begin", "end"]);
    } finally { release.resolve(); await pending; Bun.write = original; await runtime.dispose(); }
    // Actual native writethrough + a real stdio server: formatter-only status
    // must not masquerade as verified inline diagnostics and cancel late delivery.
    const fixture = join(cwd, "fixture.py"); const log = join(cwd, "fixture.log"); const file = join(cwd, "late.smoke");
    await writeFile(fixture, lspFixtureSource);
    await writeFile(join(cwd, "lsp.json"), JSON.stringify({ servers: { fixture: {
      command: "python3", args: [fixture, log], fileTypes: [".smoke"], rootMarkers: ["lsp.json"],
    } } }));
    const queryRuntime = await createNativeWorkerRuntime(cwd);
    try {
      const late = Promise.withResolvers<unknown>();
      const controller = new AbortController();
      let finalized: unknown = "not finalized";
      const writethrough = createLspWritethrough(cwd, { enableFormat: true, enableDiagnostics: true, requestTimeoutSec: 15 });
      const result = await writethrough(file, "HOLD_LATE_ERROR\n", undefined, undefined, undefined, () => ({
        signal: controller.signal, onDeferredDiagnostics: (value: unknown) => late.resolve(value),
        finalize: (value: unknown) => { finalized = value; if (value) controller.abort(); },
      }));
      expect(result.diagnostics.formatter).toBe("unsupported");
      expect(finalized).toBeUndefined(); expect(controller.signal.aborted).toBe(false);
      await queryRuntime.tools.lsp.execute("release", { action: "request", file, query: "smoke/release", payload: JSON.stringify({ uri: `file://${file}` }) });
      const delivered = await Promise.race([late.promise, Bun.sleep(5_000).then(() => { throw new Error("Formatter placeholder cancelled native late diagnostics"); })]);
      expect(delivered).toMatchObject({ errored: true, messages: [expect.stringContaining("HOLD_LATE_ERROR")] });
      const cleanController = new AbortController(); let cleanFinalized: unknown;
      const clean = await writethrough(file, "CLEAN\n", undefined, undefined, undefined, () => ({
        signal: cleanController.signal, onDeferredDiagnostics() {},
        finalize: (value: unknown) => { cleanFinalized = value; if (value) cleanController.abort(); },
      }));
      expect(clean.diagnostics.messages).toEqual([]);
      expect(cleanFinalized).toBeDefined(); expect(cleanController.signal.aborted).toBe(true);
    } finally { await queryRuntime.dispose(); await shutdownAll(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 60_000);
