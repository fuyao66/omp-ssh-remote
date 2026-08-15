import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

describe("OMP extension loading", () => {
  test("loads the bundled extension and registers remote commands", async () => {
    const extensionPath = join(import.meta.dir, "../dist/extension.js");
    const loaded = await loadExtensions([extensionPath], process.cwd());
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect([...loaded.extensions[0]!.commands.keys()].sort()).toEqual(["remote-connect", "remote-exit", "remote-status"]);
  });
});
