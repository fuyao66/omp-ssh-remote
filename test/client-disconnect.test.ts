import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";

describe("remote runtime disconnects", () => {
  test("rejects a pending tool call without local fallback", async () => {
    const client = new RemoteRuntimeClient({
      command: ["bun", join(import.meta.dir, "fixtures/hanging-worker.ts")],
    });
    await client.initialize("/remote/workspace", OMP_RUNTIME_HANDSHAKE);
    const pending = client.execute("read", "pending-read", {
      path: "file.txt",
    });
    client.kill();
    await expect(pending).rejects.toThrow(/Remote runtime (?:killed|exited)/);
    await expect(
      client.execute("read", "later-read", { path: "file.txt" }),
    ).rejects.toThrow("disconnected");
  });
});
