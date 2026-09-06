import { describe, expect, test } from "bun:test";
import { PiWorkspaceBinding } from "../src/pi/workspace-binding.ts";
import type { PiRemoteWorkspaceScope } from "../src/pi/scope.ts";

describe("Pi workspace execution boundaries", () => {
  test("a failed local participant suspension blocks all remote calls without local fallback", async () => {
    const binding = new PiWorkspaceBinding();
    binding.register({ suspend: async () => { throw new Error("finder still active"); } });
    await expect(binding.begin()).rejects.toThrow("finder still active");
    expect(binding.phase).toBe("unavailable");
    await expect(binding.execute("read", "call", {})).rejects.toThrow("finder still active");
  });

  test("a completed query from an exited workspace cannot appear in the next workspace", async () => {
    const binding = new PiWorkspaceBinding();
    const { promise: pending, resolve: complete } = Promise.withResolvers<unknown>();
    const scope = {
      isClosed: false,
      execute: async () => pending,
      close: async () => {},
    } as unknown as PiRemoteWorkspaceScope;
    binding.commit(scope, await binding.begin());
    const query = binding.execute("read", "query", {});
    await binding.close();
    complete({ content: [{ type: "text", text: "old remote file" }] });
    await expect(query).rejects.toThrow("previous workspace binding");
    expect(binding.phase).toBe("local");
  });

  test("closing failure retains the selected execution domain", async () => {
    const binding = new PiWorkspaceBinding();
    const scope = {
      isClosed: false,
      close: async () => { throw new Error("shutdown timeout"); },
    } as unknown as PiRemoteWorkspaceScope;
    binding.commit(scope, await binding.begin());
    await expect(binding.close()).rejects.toThrow("shutdown timeout");
    expect(binding.selected).toBe(true);
    await expect(binding.service("@ff-labs/pi-fff", "completion", {})).rejects.toThrow("shutdown timeout");
  });
});
