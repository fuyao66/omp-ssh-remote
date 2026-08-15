import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

describe("OMP extension loading", () => {
  test("loads the bundled extension and injects transient workspace state", async () => {
    const extensionPath = join(import.meta.dir, "../dist/extension.js");
    const loaded = await loadExtensions([extensionPath], process.cwd());
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0]!;
    expect([...extension.commands.keys()].sort()).toEqual([
      "remote-connect",
      "remote-exit",
      "remote-status",
    ]);

    const contextHandler = extension.handlers.get("context")?.[0] as
      | ((event: {
          type: "context";
          messages: AgentMessage[];
        }) =>
          | Promise<{ messages?: AgentMessage[] }>
          | { messages?: AgentMessage[] })
      | undefined;
    if (!contextHandler) throw new Error("Context handler was not registered");
    const original: AgentMessage[] = [
      { role: "user", content: "inspect the project", timestamp: 1 },
    ];
    const result = await contextHandler({
      type: "context",
      messages: original,
    });

    expect(original).toHaveLength(1);
    expect(result.messages).toHaveLength(2);
    const state = result.messages?.at(-1);
    expect(state?.role).toBe("custom");
    if (!state || state.role !== "custom")
      throw new Error("Workspace state was not injected");
    expect(state.customType).toBe("omp-ssh-remote/workspace-state");
    expect(state.content).toContain('mode: "local"');
  });
});
