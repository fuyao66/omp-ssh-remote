import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { MAX_FRAME_BYTES } from "../src/protocol.ts";

// The worker accumulates command definitions and mounts only names it has a spec for, so the
// client may omit a spec only after a frame carrying it was actually written.
test("a command definition counts as sent only once its frame is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-command-specs-"));
  const frames = join(dir, "frames");
  // A worker stand-in that records every frame it receives and exits on EOF.
  const client = new RemoteRuntimeClient({ command: ["sh", "-c", 'exec cat > "$0"', frames] });
  try {
    const commands = { names: ["probe"], specs: [{ name: "probe", description: "probe-spec", schema: { type: "object" } }] };
    await expect(client.execute("bash", "oversized", { command: "x".repeat(MAX_FRAME_BYTES) }, undefined, undefined, { commands }))
      .rejects.toThrow("exceeds");
    const pending = [
      client.execute("bash", "first", { command: "probe" }, undefined, undefined, { commands }),
      client.execute("bash", "second", { command: "probe" }, undefined, undefined, { commands }),
    ].map(call => call.catch(() => undefined));
    await client.close().catch(() => undefined);
    await Promise.all(pending);
    const written = await readFile(frames, "utf8");
    expect(written).not.toContain("oversized");
    expect(written.split("probe-spec").length - 1).toBe(1);
    expect(written.indexOf("probe-spec")).toBeLessThan(written.indexOf('"second"'));
  } finally {
    client.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
