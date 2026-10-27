import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { createOmpRuntimeHandshake } from "../src/omp/runtime-contract.ts";
import { TOOL_RUNTIME_VERSION, parseMessage, parseRequest } from "../src/protocol.ts";
import { resolveRemoteResourceArgs } from "../src/resource-routing.ts";

const conflict = "<<<<<<< HEAD\nours value\n=======\ntheirs value\n>>>>>>> branch\n";

describe("runtime-owned resource binding reaches nested Eval tools", () => {
  test("Eval read.text exposes bound references and nested write resolves only the owning runtime", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-eval-resource-"));
    const client = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
    const binding = "eval-workspace-binding";
    try {
      await writeFile(join(cwd, "conflicted.txt"), conflict);
      const ready = await client.initialize(cwd, createOmpRuntimeHandshake({ hostVersion: "18.12.6", editMode: "hashline" }), undefined, { resourceBinding: binding });
      expect(ready.resourceBinding).toBe(binding);
      const evalCode = (id: string, code: string) => client.execute("eval", id, { language: "js", title: id, code }, undefined, undefined, {
        onInvoke: (invocation, signal, onUpdate) => client.execute(invocation.tool, invocation.toolCallId, resolveRemoteResourceArgs(invocation.tool as Parameters<typeof resolveRemoteResourceArgs>[0], invocation.args, binding), signal, onUpdate),
      });
      const first = await evalCode("publish-bound-read", 'print((await tool.read({ path: "conflicted.txt:conflicts" })).text)');
      const output = JSON.stringify(first);
      expect(output).toContain("REMOTE CONFLICT REFERENCES");
      const id = /remote-conflict:\/\/eval-workspace-binding\/(\d+)/.exec(output)?.[1];
      expect(id).toBeDefined();
      const bound = `remote-conflict://${binding}/${id}`;
      const side = await evalCode("read-bound-side", `print((await tool.read({ path: ${JSON.stringify(`${bound}/ours`)} })).text)`);
      expect(JSON.stringify(side)).toContain("ours value");
      for (const path of [`conflict://${id}`, `file:conflict://${id}`, `[conflict://${id}#ABCD]`]) {
        const rejected = await evalCode("reject-local-conflict", `await tool.read({ path: ${JSON.stringify(path)} })`);
        expect(JSON.stringify(rejected)).toContain("cannot access local internal URIs");
      }
      const stale = await evalCode("reject-stale-binding", `await tool.write({ path: "remote-conflict://another-workspace/${id}", content: "must not write" })`);
      expect(JSON.stringify(stale)).toContain("stale workspace binding");
      expect(await readFile(join(cwd, "conflicted.txt"), "utf8")).toBe(conflict);
      const resolved = await evalCode("resolve-bound-conflict", `await tool.write({ path: ${JSON.stringify(bound)}, content: "resolved via nested Eval\\n" }); print("BOUND_WRITE_FINISHED")`);
      expect(JSON.stringify(resolved)).toContain("BOUND_WRITE_FINISHED");
      expect(await readFile(join(cwd, "conflicted.txt"), "utf8")).toBe("resolved via nested Eval\n");
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("a worker without an explicit namespace generates a fresh UUID binding", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-default-resource-binding-"));
    const clients = [new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] }), new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] })];
    try {
      const ready = await Promise.all(clients.map(client => client.initialize(cwd, createOmpRuntimeHandshake({ hostVersion: "18.12.6" }))));
      for (const result of ready) expect(result.resourceBinding).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(ready[0]!.resourceBinding).not.toBe(ready[1]!.resourceBinding);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("wire resource namespaces must be non-empty strings and opaque values roundtrip unchanged", () => {
    const initialize = { type: "initialize", protocolVersion: 1, runtimeVersion: TOOL_RUNTIME_VERSION, cwd: "/tmp", tools: ["read"] };
    const ready = { type: "ready", protocolVersion: 1, tools: [] };
    for (const resourceBinding of ["workspace-one", "opaque / namespace"]) {
      expect(parseRequest({ ...initialize, resourceBinding })).toMatchObject({ resourceBinding });
      expect(parseMessage(JSON.stringify({ ...ready, resourceBinding }))).toMatchObject({ resourceBinding });
    }
    for (const resourceBinding of ["", " \t\n", null, 1, false]) {
      expect(() => parseRequest({ ...initialize, resourceBinding })).toThrow(/resourceBinding must be a non-empty string/);
      expect(() => parseMessage(JSON.stringify({ ...ready, resourceBinding }))).toThrow(/resourceBinding must be a non-empty string/);
    }
  });
});
