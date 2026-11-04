import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";

test("companion initializes the theme before native LSP diagnostics format a no-server message", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-worker-theme-"));
  let client: RemoteRuntimeClient | undefined;
  try {
    const cwd = join(root, "project");
    await mkdir(cwd);
    // An unsupported extension selects the real native no-server branch without
    // depending on an installed language server or waiting for its diagnostics.
    const file = "probe.omp-theme-regression";
    await writeFile(join(cwd, file), "theme initialization regression\n");
    // A fresh process cannot inherit a theme initialized by another test. The
    // isolated home also prevents user LSP configuration from selecting a server.
    client = new RemoteRuntimeClient({
      command: [process.execPath, join(import.meta.dir, "../src/worker.ts")],
      cwd,
      env: {
        HOME: root,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        XDG_CONFIG_HOME: join(root, "config"),
      },
    });
    await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE);
    const result = await client.execute("lsp", "theme-no-server", { action: "diagnostics", file });
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining(`${file}: No language server found`) }],
      details: { action: "diagnostics" },
    });
    expect(result).not.toMatchObject({ isError: true });
  } finally {
    try {
      if (client) {
        await client.close();
        expect(await client.waitForExit()).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);
