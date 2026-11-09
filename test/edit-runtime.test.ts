import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { createOmpRuntimeHandshake } from "../src/omp/runtime-contract.ts";
import { createNativeWorkerRuntime } from "../src/runtime.ts";
import { pathShouldStayLocal } from "../src/path-domain.ts";
import { assertNestedRemoteTool } from "../src/nested-dispatch.ts";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SUPPORTED_SDK_VERSION } from "../src/omp/sdk-contract.ts";

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
        const handshake = createOmpRuntimeHandshake({ hostVersion: SUPPORTED_SDK_VERSION, editMode });
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

  test("none preserves native reads and leaves edit unavailable to direct, Eval, and xdev calls", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-edit-none-"));
    const client = new RemoteRuntimeClient({
      command: [process.execPath, join(import.meta.dir, "../src/worker.ts")],
      env: { PI_EDIT_VARIANT: "hashline" },
    });
    let runtime: Awaited<ReturnType<typeof createNativeWorkerRuntime>> | undefined;
    try {
      await writeFile(join(cwd, "probe.txt"), "original value\n");
      runtime = await createNativeWorkerRuntime(cwd, { editMode: "none" });
      expect(runtime.editMode).toBe("none");
      expect(runtime.session.hasEditTool).toBe(false);
      expect(runtime.session.isToolActive?.("edit")).toBe(false);
      expect(runtime.session.isToolActive?.("bash")).toBe(true);
      expect(runtime.session.getToolByName?.("edit")).toBeUndefined();
      expect(runtime.session.getToolByName?.("xd://edit")).toBeUndefined();
      const xdev = runtime.session.xdev;
      if (!xdev?.resolve) throw new Error("Expected native xdev resolver");
      expect(xdev.resolve("edit")).toBeUndefined();
      const native = new ReadTool({
        cwd, settings: Settings.isolated({ "edit.mode": "none" }), hasEditTool: false,
      } as ToolSession);
      const nativeRead = await native.execute("native-none", { path: "probe.txt" });
      const ready = await client.initialize(cwd, createOmpRuntimeHandshake({ hostVersion: SUPPORTED_SDK_VERSION, editMode: "none" }));
      expect(ready.editMode).toBe("none");
      const remoteRead = await client.execute("read", "read-none", { path: "probe.txt" });
      expect((remoteRead as { content: unknown }).content).toEqual(nativeRead.content);
      expect(JSON.stringify(remoteRead)).not.toMatch(/\[probe\.txt#[A-F0-9]+\]/);
      await expect(client.execute("edit", "edit-none", {
        path: "probe.txt", old_string: "original", new_string: "forbidden",
      })).rejects.toThrow(/disabled.*edit.mode=none/);
      let nestedInvocations = 0;
      const nested = await client.execute("eval", "eval-none", {
        language: "js", title: "Disabled edit", code: 'await tool.edit({path:"probe.txt",old_string:"original",new_string:"forbidden"})',
      }, undefined, undefined, { onInvoke: async () => { nestedInvocations++; throw new Error("Disabled edit reached host"); } });
      expect(nested).toMatchObject({ isError: true });
      expect(nestedInvocations).toBe(0);
      const xdevResult = await client.execute("write", "xdev-none", {
        path: "xd://edit", content: JSON.stringify({ path: "probe.txt", old_string: "original", new_string: "forbidden" }),
      });
      expect(xdevResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("No such tool: xd://edit") }],
      });
      expect(await readFile(join(cwd, "probe.txt"), "utf8")).toBe("original value\n");
      const written = await client.execute("write", "write-none", { path: "written.txt", content: "write remains available\n" });
      expect(written).not.toMatchObject({ isError: true });
      const bash = await client.execute("bash", "bash-none", { command: "printf 'bash remains available\\n'", cwd, timeout: 10 });
      expect(bash).not.toMatchObject({ isError: true });
      expect(JSON.stringify(bash)).toContain("bash remains available");
      expect(await readFile(join(cwd, "written.txt"), "utf8")).toBe("write remains available\n");
      expect(() => pathShouldStayLocal("edit", { path: "local://probe" }, "none")).toThrow(/disabled/);
      expect(() => assertNestedRemoteTool("edit", { path: "remote-artifact://binding/file" }, "binding", "none")).toThrow(/disabled/);
    } finally {
      await runtime?.dispose();
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
