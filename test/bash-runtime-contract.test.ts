import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { captureOmpToolSnapshot, createOmpRuntimeHandshake, projectOmpBashExecutionSchema } from "../src/omp/runtime-contract.ts";
import { PROTOCOL_VERSION, TOOL_RUNTIME_VERSION, isRecord, parseRequest, type ReadyMessage } from "../src/protocol.ts";

describe("bash local orchestration and remote execution contracts", () => {
  test("projects only the optional local async boolean and never mutates native metadata", () => {
    const properties = { command: { type: "string" }, async: { type: "boolean" }, timeout: { type: "number" }, name: { type: "string" }, ready: { type: "object" } };
    const schema = { type: "object", properties, required: ["command"], additionalProperties: false };
    expect(projectOmpBashExecutionSchema(schema)).toEqual({ ...schema, properties: { command: properties.command, timeout: properties.timeout, name: properties.name, ready: properties.ready } });
    expect(schema.properties.async).toEqual({ type: "boolean" });
    for (const invalid of [
      { ...schema, properties: { ...properties, async: { type: "string" } } },
      { ...schema, required: ["command", "async"] },
    ]) expect(() => projectOmpBashExecutionSchema(invalid)).toThrow(/expected an optional boolean/);
  });

  test("frontend runtime snapshots reject service stops without a worker driver and dispatch injected stops exactly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-service-driver-"));
    const snapshot = await createNativeWorkerRuntime(cwd, "18.12.6");
    const calls: Array<{ cwd: string; name: string; id: string }> = [];
    const worker = await createNativeWorkerRuntime(cwd, "18.12.6", {
      serviceLifecycle: {
        execute: async () => { throw new Error("This test exercises stop dispatch only"); },
        stop: async (cwd, name, id) => {
          calls.push({ cwd, name, id });
          return { name, id, status: "stopped" };
        },
      },
    });
    try {
      await expect(snapshot.stopService("service", "instance")).rejects.toThrow("service lifecycle is unavailable");
      expect(await worker.stopService("service", "instance")).toEqual({ name: "service", id: "instance", status: "stopped" });
      expect(calls).toEqual([{ cwd: worker.cwd, name: "service", id: "instance" }]);
    } finally {
      await Promise.all([snapshot.dispose(), worker.dispose()]);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("extension bundle excludes worker-only launch client while the worker retains its real driver", async () => {
    // Bundle local dependency graphs in memory. Host packages stay external:
    // this tests our graph boundary, not the compiled host's module registry.
    const bundles: Record<string, string> = {};
    for (const name of ["extension", "worker"]) {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, `../src/${name}.ts`)],
        target: "bun",
        format: "esm",
        packages: "external",
      });
      if (!built.success) throw new AggregateError(built.logs, `${name} boundary build failed`);
      bundles[name] = (await Promise.all(built.outputs.map(output => output.text()))).join("\n");
    }
    expect(bundles.extension).not.toContain("@oh-my-pi/pi-coding-agent/launch/client");
    expect(bundles.extension).not.toContain("src/omp/service-lifecycle.ts");
    expect(bundles.worker).toContain("@oh-my-pi/pi-coding-agent/launch/client");
    expect(bundles.worker).toContain("executeOwnedRemoteService");
  });

  for (const bashServices of [false, true]) {
    test(`actual native schema matrix preserves service capability=${bashServices}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "omp-bash-contract-"));
      const runtime = await createNativeWorkerRuntime(cwd, "18.12.6", { bashServices });
      try {
        const tools = Object.values(runtime.tools).map(tool => ({ ...captureOmpToolSnapshot(tool), description: tool.description }));
        const ready: ReadyMessage = { type: "ready", protocolVersion: PROTOCOL_VERSION, runtimeVersion: TOOL_RUNTIME_VERSION, host: "omp", hostVersion: "18.12.6", tools };
        const workerBash = tools.find(tool => tool.name === "bash")!;
        expect(isRecord(workerBash.parameters) && isRecord(workerBash.parameters.properties) && "name" in workerBash.parameters.properties).toBe(bashServices);
        const workerParameters = workerBash.parameters;
        if (!isRecord(workerParameters) || !isRecord(workerParameters.properties)) throw new Error("Native bash did not expose an object schema");
        const executionProperties = workerParameters.properties;
        if (!bashServices) {
          await expect(runtime.tools.bash.execute("disabled-service", { command: "true", name: "disabled-service" })).rejects.toThrow(/Service launch is disabled/);
        }
        for (const asyncEnabled of [false, true]) {
          const host = new BashTool({ ...runtime.session, settings: Settings.isolated({ "async.enabled": asyncEnabled, "launch.enabled": bashServices }) });
          const localTools = tools.map(tool => tool.name === "bash" ? captureOmpToolSnapshot(host) : tool);
          const handshake = createOmpRuntimeHandshake({ hostVersion: "18.12.6", localTools });
          expect(handshake.bashServices).toBe(bashServices);
          expect(() => handshake.validateReady(ready)).not.toThrow();
          const changed = (properties: Record<string, unknown>) => ({ ...ready, tools: tools.map(tool => tool.name === "bash" ? { ...tool, parameters: { ...workerParameters, properties } } : tool) });
          expect(() => handshake.validateReady(changed({ ...executionProperties, command: { type: "number" } }))).toThrow(/bash schema is incompatible/);
          expect(() => handshake.validateReady(changed({ ...executionProperties, async: { type: "boolean" } }))).toThrow(/bash schema is incompatible/);
          if (bashServices) {
            expect(() => handshake.validateReady(changed({ ...executionProperties, ready: { type: "string" } }))).toThrow(/bash schema is incompatible/);
          } else {
            expect(() => handshake.validateReady(changed({ ...executionProperties, name: { type: "string" }, ready: { type: "object" } }))).toThrow(/bash schema is incompatible/);
          }
        }
      } finally {
        await runtime.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  test("protocol carries disabled service capability without coercion", () => {
    const initialize = { type: "initialize", protocolVersion: 1, runtimeVersion: TOOL_RUNTIME_VERSION, cwd: "/tmp", tools: ["bash"] };
    for (const bashServices of [false, true]) expect(parseRequest({ ...initialize, bashServices })).toMatchObject({ bashServices });
    for (const bashServices of ["false", 0, null]) expect(() => parseRequest({ ...initialize, bashServices })).toThrow(/bashServices must be a boolean/);
  });
});
