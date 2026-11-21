import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { cfgLspEnabled, cfgLspShared } from "@oh-my-pi/pi-coding-agent/lsp/settings";
import { isSharedLspEnabled } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { subagentLspWritethroughSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { captureExecutionSettings } from "../src/omp/execution-settings.ts";
import { createNativeWorkerRuntime } from "../src/runtime.ts";

const text = (result: unknown) => (result as AgentToolResult).content
  .flatMap(part => part.type === "text" ? [part.text] : []).join("");

describe("native worker runtime teardown and LSP switch", () => {
  test("the forwarded effective LSP switch reaches the worker session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-runtime-lsp-"));
    const disabled = await createNativeWorkerRuntime(cwd, { settings: { "lsp.enabled": false } });
    const enabled = await createNativeWorkerRuntime(cwd);
    try {
      expect(cfgLspEnabled.get(disabled.session.settings)).toBe(false);
      expect(cfgLspEnabled.get(enabled.session.settings)).toBe(true);
    } finally {
      await Promise.all([disabled.dispose(), enabled.dispose()]);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("native task LSP overlays disable writethrough but retain queries and keep worker LSP private", async () => {
    const parent = Settings.isolated({
      "task.enableLsp": false, "lsp.enabled": true, "lsp.shared": true,
      "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": true, "lsp.diagnosticsOnEdit": true,
    });
    const child = parent.overlay(subagentLspWritethroughSettings(parent)!);
    const settings = captureExecutionSettings(child);
    expect(settings).toMatchObject({
      "lsp.enabled": true, "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": false, "lsp.diagnosticsOnEdit": false,
    });
    expect(settings).not.toHaveProperty("lsp.shared");
    const cwd = await mkdtemp(join(tmpdir(), "omp-runtime-lsp-private-"));
    const runtime = await createNativeWorkerRuntime(cwd, { settings });
    try {
      expect(cfgLspEnabled.get(runtime.session.settings)).toBe(true);
      expect(cfgLspShared.get(runtime.session.settings)).toBe(false);
      expect(isSharedLspEnabled()).toBe(false);
      await Bun.write(join(cwd, "probe.no-such-language"), "probe\n");
      const result = await runtime.tools.lsp.execute("private-query", { action: "diagnostics", file: "probe.no-such-language" });
      expect(result).toMatchObject({ details: { action: "diagnostics" } });
      expect(isSharedLspEnabled()).toBe(false);
    } finally {
      await runtime.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("dispose runs tool dispose callbacks once and releases the owner's persistent shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-runtime-dispose-"));
    const sessionId = `dispose-${crypto.randomUUID()}`;
    const first = await createNativeWorkerRuntime(cwd, { sessionId });
    try {
      let calls = 0;
      first.session.registerDisposeCallback?.(() => { calls++; });
      const unregistered = first.session.registerDisposeCallback?.(() => { throw new Error("unregistered callback ran"); });
      if (typeof unregistered === "function") unregistered();
      first.session.registerDisposeCallback?.(() => { throw new Error("one failing callback"); });
      first.session.registerDisposeCallback?.(() => { calls++; });
      await first.tools.bash.execute("mark", { command: "export REMOTE_DISPOSE_MARK=kept" });
      expect(text(await first.tools.bash.execute("same", { command: "echo ${REMOTE_DISPOSE_MARK:-unset}" }))).toContain("kept");
      await Promise.all([first.dispose(), first.dispose()]);
      expect(calls).toBe(2);
      // A later runtime for the same owner must start from a fresh native shell.
      const second = await createNativeWorkerRuntime(cwd, { sessionId });
      try {
        expect(text(await second.tools.bash.execute("fresh", { command: "echo ${REMOTE_DISPOSE_MARK:-unset}" }))).toContain("unset");
      } finally { await second.dispose(); }
    } finally {
      await first.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
