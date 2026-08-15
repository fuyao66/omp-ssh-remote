import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import remoteRuntimeExtension from "../src/extension.ts";

describe("OMP extension loading", () => {
  test("registers commands without a model-visible workspace-state handler", async () => {
    const commands = new Set<string>();
    const events = new Set<string>();
    const api = {
      registerCommand(name: string) {
        commands.add(name);
      },
      on(event: string) {
        events.add(event);
      },
    };

    await remoteRuntimeExtension(api as unknown as ExtensionAPI);

    expect([...commands].sort()).toEqual([
      "remote-connect",
      "remote-exit",
      "remote-status",
    ]);
    expect(events.has("context")).toBe(false);
  });
});
