import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { cfgLspEnabled } from "@oh-my-pi/pi-coding-agent/lsp/settings";
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
