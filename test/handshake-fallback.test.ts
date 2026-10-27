import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { captureOmpHandshake } from "../src/extension.ts";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { captureOmpToolSnapshot } from "../src/omp/runtime-contract.ts";
import { PROTOCOL_VERSION, TOOL_RUNTIME_VERSION } from "../src/protocol.ts";

test("missing edit metadata uses the effective host edit mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "remote-handshake-mode-"));
  const previousEntry = process.argv[1];
  const previousVariant = process.env.PI_EDIT_VARIANT;
  // The production resolver identifies the actual CLI entry; this harness runs
  // outside the CLI, so select the installed source CLI without changing PATH.
  process.argv[1] = import.meta.resolve("@oh-my-pi/pi-coding-agent").replace(/^file:\/\//, "");
  delete process.env.PI_EDIT_VARIANT;
  const settings = Settings.isolated({ "edit.mode": "replace" });
  const runtime = await createNativeWorkerRuntime(cwd, "18.13.1", { editMode: "replace" });
  try {
    const pi = { getAllTools: () => Object.values(runtime.tools).filter(tool => tool.name !== "edit") } as unknown as ExtensionAPI;
    const state = {
      localCwd: cwd, selected: false, owner: false, binding: "fallback-test", wrappedTools: new Set(),
      proposalSources: [], activeToolNames: () => [],
    } as Parameters<typeof captureOmpHandshake>[1];
    const handshake = await withActiveSettings(settings, () => captureOmpHandshake(pi, state));
    expect(handshake.editMode).toBe("replace");
    expect(() => handshake.validateReady({
      type: "ready", protocolVersion: PROTOCOL_VERSION, host: "omp", hostVersion: "18.13.1",
      runtimeVersion: TOOL_RUNTIME_VERSION, editMode: "replace", cwd,
      tools: Object.values(runtime.tools).map(tool => ({ ...captureOmpToolSnapshot(tool), description: tool.description })),
    })).not.toThrow();
  } finally {
    process.argv[1] = previousEntry;
    if (previousVariant === undefined) delete process.env.PI_EDIT_VARIANT;
    else process.env.PI_EDIT_VARIANT = previousVariant;
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
