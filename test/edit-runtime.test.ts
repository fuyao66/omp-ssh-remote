import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { createOmpRuntimeHandshake } from "../src/omp/runtime-contract.ts";

describe("negotiated native edit language", () => {
  for (const editMode of ["replace", "hashline"] as const) {
    test(`${editMode}: read anchors and edit parser use the negotiated mode despite ambient env`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omp-edit-${editMode}-`));
      const client = new RemoteRuntimeClient({
        command: [process.execPath, join(import.meta.dir, "../src/worker.ts")],
        env: { PI_EDIT_VARIANT: editMode === "hashline" ? "replace" : "hashline" },
      });
      try {
        await writeFile(join(cwd, "probe.txt"), "original value\n");
        const handshake = createOmpRuntimeHandshake({ hostVersion: "18.12.6", editMode });
        const ready = await client.initialize(cwd, handshake);
        expect(ready.editMode).toBe(editMode);
        const manifest = ready.tools.find(tool => tool.name === "edit")!;
        const read = await client.execute("read", "read-mode", { path: "probe.txt" });
        const header = JSON.stringify(read).match(/\[probe\.txt#[A-F0-9]+\]/)?.[0];
        if (editMode === "hashline") {
          expect(header).toBeDefined();
          expect(manifest.customFormat?.syntax).toBe("lark");
          expect(manifest.customFormat!.definition.length).toBeGreaterThan(0);
          const result = await client.execute("edit", "edit-mode", { input: `${header}\nPUT 1.=1:\n+updated value` });
          expect(result).not.toMatchObject({ isError: true });
        } else {
          expect(header).toBeUndefined();
          expect(manifest.customFormat).toBeUndefined();
          const result = await client.execute("edit", "edit-mode", {
            path: "probe.txt", old_string: "original value", new_string: "updated value",
          });
          expect(result).not.toMatchObject({ isError: true });
        }
        expect(await readFile(join(cwd, "probe.txt"), "utf8")).toBe("updated value\n");
      } finally {
        await client.close();
        await rm(cwd, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
