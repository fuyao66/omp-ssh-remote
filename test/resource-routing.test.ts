import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ConflictHistory, formatConflictSummary, formatConflictWarning, scanConflictLines } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { pathShouldStayLocal } from "../src/path-domain.ts";
import { bindRemoteResourceResult, resolveRemoteResourceArgs, resourceExecutionTarget } from "../src/resource-routing.ts";
import { createNativeWorkerRuntime, type NativeWorkerRuntime } from "../src/runtime.ts";

const binding = "workspace-one";
const root = `remote-conflict://${binding}/`;

function registration() {
  const history = new ConflictHistory();
  const block = scanConflictLines(["<<<<<<< HEAD", "conflict://1 is application data", "=======", "remote-conflict://user-literal/2", ">>>>>>> branch"], 10)[0]!;
  return history.register({ ...block, absolutePath: "/remote/file", displayPath: "file" });
}

describe("bound remote conflict resources", () => {
  test("keeps identical local and remote native ids in distinct domains", () => {
    expect(pathShouldStayLocal("read", { path: "conflict://1" })).toBe(true);
    expect(pathShouldStayLocal("write", { path: "conflict://*" })).toBe(true);
    expect(resourceExecutionTarget("read", { path: "conflict://1" }, binding)).toBeUndefined();
    expect(resourceExecutionTarget("read", { path: `${root}1` }, binding)).toBe("remote");
    expect(pathShouldStayLocal("read", { path: `${root}1` })).toBe(false);
    expect(resolveRemoteResourceArgs("read", { path: `${root}1` }, binding)).toEqual({ path: "conflict://1" });
  });

  test("normalizes native conflict aliases before read/write domain checks", () => {
    for (const name of ["read", "write"] as const) {
      for (const path of ["file.txt:conflict://1", "/remote/file.txt:conflict://1/ours", "[conflict://1#ABCD]", "[conflict://1]", "[file.txt:conflict://1#ABCD]", "remote-conflict://old-binding/1:conflict://1"]) {
        const args = { path, content: "file.txt:conflict://7 [conflict://8#ABCD]" };
        expect(pathShouldStayLocal(name, args)).toBe(true);
        expect(resourceExecutionTarget(name, args, binding)).toBeUndefined();
        expect(resourceExecutionTarget(name, args, "new-binding")).toBeUndefined();
        expect(resolveRemoteResourceArgs(name, args, binding)).toBe(args);
      }
      for (const path of [`[${root}1#ABCD]`, `[${root}1]`]) {
        const args = { path, content: "file.txt:conflict://7 [conflict://8#ABCD]" };
        expect(pathShouldStayLocal(name, args)).toBe(false);
        expect(resourceExecutionTarget(name, args, binding)).toBe("remote");
        expect(resolveRemoteResourceArgs(name, args, binding)).toEqual({ ...args, path: "conflict://1" });
        expect(() => resourceExecutionTarget(name, args, "new-binding")).toThrow("stale workspace binding");
        expect(() => resolveRemoteResourceArgs(name, args, "new-binding")).toThrow("stale workspace binding");
      }
    }
    for (const path of [`${root}1;file.txt:conflict://1`, `file.txt:conflict://1;${root}1`]) {
      expect(() => resourceExecutionTarget("read", { path }, binding)).toThrow("cannot mix");
    }
  });

  test("supports remote side reads and wildcard writes without changing content", () => {
    for (const side of ["ours", "theirs", "base"]) {
      expect(resolveRemoteResourceArgs("read", { path: `${root}1/${side}` }, binding)).toEqual({ path: `conflict://1/${side}` });
    }
    const content = "1: @ours\n2: @theirs\nconflict://3 remote-conflict://user-literal/4";
    const args = { path: `${root}*`, content };
    expect(resolveRemoteResourceArgs("write", args, binding)).toEqual({ path: "conflict://*", content });
    expect(args.path).toBe(`${root}*`);
    expect(resolveRemoteResourceArgs("read", { path: `${root}1/ours;${root}2/theirs` }, binding)).toEqual({ path: "conflict://1/ours;conflict://2/theirs" });
  });

  test("rejects stale, disabled, malformed and mixed-domain references", () => {
    for (const current of ["workspace-two", undefined]) {
      expect(() => resourceExecutionTarget("read", { path: `${root}1` }, current)).toThrow("stale workspace binding");
    }
    for (const suffix of ["", "0", "1/unknown", "*/ours", "%31", "1:raw"]) {
      expect(() => resourceExecutionTarget("read", { path: root + suffix }, binding)).toThrow("Invalid bound remote conflict reference");
    }
    expect(() => resourceExecutionTarget("read", { path: `${root}1;conflict://1` }, binding)).toThrow("cannot mix");
    expect(() => resourceExecutionTarget("grep", { path: `${root}1` }, binding)).toThrow("only read and write");
  });

  test("remote-only validation handles native process aliases without claiming host process ownership", () => {
    for (const path of [`${root}1;PROC://%77eb:1-5`, `PROC://%77eb:1-5;${root}1`]) {
      expect(resourceExecutionTarget("read", { path }, binding)).toBe("remote");
      expect(resolveRemoteResourceArgs("read", { path }, binding).path).toBe(path.replace(`${root}1`, "conflict://1"));
    }
    // The worker cannot know whether bg_1 is host-local. Shared host ownership
    // must classify it before this remote-only validator/decoder is called.
    expect(resourceExecutionTarget("read", { path: `${root}1;proc://bg_1` }, binding)).toBe("remote");
    for (const path of [`${root}1;agent://Scout`, `agent://Scout;${root}1`]) {
      expect(() => resolveRemoteResourceArgs("read", { path }, binding)).toThrow("cannot mix");
    }
  });

  test("does not treat resource-like user literals as routing operands", () => {
    const args = { path: "file", content: `${root}1 conflict://1`, nested: { path: `${root}1` } };
    expect(resourceExecutionTarget("write", args, binding)).toBeUndefined();
    expect(resolveRemoteResourceArgs("write", args, binding)).toBe(args);
    const result = { content: [{ type: "text", text: "conflict://1" }], details: {} };
    expect(bindRemoteResourceResult("read", { path: "file" }, result, binding)).toBe(result);
  });

  test("publishes binding-owned references from structured runtime registrations", () => {
    const entry = registration();
    for (const text of [formatConflictSummary([entry], { displayPath: "file" }), "1: source literal conflict://1\n" + formatConflictWarning([entry])]) {
      const original = { content: [{ type: "text", text }], details: { remoteResources: { conflictIds: [1] } } };
      const result = bindRemoteResourceResult("read", { path: "file:conflicts" }, original, binding);
      expect(result.content[0]).toBe(original.content[0]);
      expect(result.content[0]!.text).toBe(text);
      expect(result.content[1]!.text).toContain(`${root}1`);
      expect(result.content[1]!.text).toContain(`${root}*`);
      expect(original.content).toHaveLength(1);
    }
  });

  test("publishes once per binding and rejects relabeling a published result", () => {
    const original = { content: [{ type: "text", text: "untouched" }], details: { remoteResources: { conflictIds: [1], other: "kept" } } };
    const first = bindRemoteResourceResult("read", { path: "file" }, original, binding);
    expect(first.details).toHaveProperty("remoteResources", { conflictIds: [1], other: "kept", binding });
    expect(first.content).toHaveLength(2);
    expect(original.details.remoteResources).not.toHaveProperty("binding");
    expect(bindRemoteResourceResult("read", { path: "file" }, first, binding)).toBe(first);
    expect(() => bindRemoteResourceResult("read", { path: "file" }, first, "new-binding")).toThrow("stale workspace binding");
  });

  test("does not infer ownership from conflict sides, other tools, errors or native-looking text", () => {
    const text = formatConflictSummary([registration()], { displayPath: "file" });
    const result = { content: [{ type: "text", text }], details: { conflictCount: 1 } };
    expect(bindRemoteResourceResult("read", { path: "file" }, result, binding)).toBe(result);
    expect(bindRemoteResourceResult("write", { path: "file" }, result, binding)).toBe(result);
    expect(bindRemoteResourceResult("read", { path: "conflict://1/ours" }, result, binding)).toBe(result);
    expect(bindRemoteResourceResult("read", { path: `${root}1/ours` }, result, binding)).toBe(result);
    const error = { ...result, details: { remoteResources: { conflictIds: [1] } }, isError: true };
    expect(bindRemoteResourceResult("read", { path: "file" }, error, binding)).toBe(error);
    const mismatch = { ...result, details: { conflictCount: 2 } };
    expect(bindRemoteResourceResult("read", { path: "file" }, mismatch, binding)).toBe(mismatch);
    const literal = { ...result, content: [{ type: "text", text: "user documentation: conflict://1" }] };
    expect(bindRemoteResourceResult("read", { path: "file" }, literal, binding)).toBe(literal);
  });

  test("publishes single and multi-path registrations without parsing their text", () => {
    for (const path of ["file", "file;second", `${root}1/ours;second`]) {
      const text = "Application literal conflict://1, remote-conflict://user-literal/3, and #99 L1-L5";
      const original = { content: [{ type: "text", text }], details: { remoteResources: { conflictIds: [17, 22] } } };
      const result = bindRemoteResourceResult("read", { path }, original, binding);
      expect(result.content[0]).toBe(original.content[0]);
      expect(result.content[1]!.text).toContain(`${root}17`);
      expect(result.content[1]!.text).toContain(`${root}22`);
      expect(result.content[1]!.text).not.toContain(`${root}99`);
      expect(result.content[1]!.text).not.toContain(`${root}1\n`);
    }
  });

  test("requires nonempty unique positive safe integer registration ids", () => {
    for (const conflictIds of [undefined, null, [], "1", [0], [-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1], ["1"], [1, 1], [1, 0], [1, undefined]]) {
      const result = { content: [{ type: "text", text: "conflict://1" }], details: { remoteResources: { conflictIds } } };
      expect(bindRemoteResourceResult("read", { path: "file" }, result, binding)).toBe(result);
    }
    const valid = { content: [{ type: "text", text: "unchanged" }], details: { remoteResources: { conflictIds: [1] } } };
    expect(bindRemoteResourceResult("write", { path: "file" }, valid, binding)).toBe(valid);
  });

  test("resolves a real remote conflict without touching the same local conflict id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-resource-routing-"));
    const runtimes: NativeWorkerRuntime[] = [];
    try {
      const localCwd = join(directory, "local");
      const remoteCwd = join(directory, "remote");
      await Promise.all([mkdir(localCwd), mkdir(remoteCwd)]);
      const localFile = join(localCwd, "file.txt");
      const remoteFile = join(remoteCwd, "file.txt");
      await writeFile(localFile, "local-before\n<<<<<<< HEAD\nlocal-ours\n=======\nlocal-theirs\n>>>>>>> branch\nlocal-after\n");
      await writeFile(remoteFile, "remote-before\n<<<<<<< HEAD\nremote-ours\n=======\nremote-theirs\n>>>>>>> branch\nremote-after\n");
      const localBefore = await readFile(localFile);
      const local = await createNativeWorkerRuntime(localCwd, "test");
      runtimes.push(local);
      const remote = await createNativeWorkerRuntime(remoteCwd, "test");
      runtimes.push(remote);
      await local.tools.read.execute("local-register", { path: "file.txt:conflicts" });
      const params = { path: "file.txt:conflicts" };
      const nativeRead = await remote.tools.read.execute("remote-register", params) as AgentToolResult;
      expect(local.session.conflictHistory!.entries().map(entry => entry.id)).toEqual([1]);
      expect(remote.session.conflictHistory!.entries().map(entry => entry.id)).toEqual([1]);
      expect(nativeRead.details).toMatchObject({ remoteResources: { conflictIds: [1] } });
      const published = bindRemoteResourceResult("read", params, nativeRead, remote.resourceBinding);
      expect(published).toBe(nativeRead);
      expect(published.content.slice(0, nativeRead.content.length)).toEqual(nativeRead.content);
      const referenceBlock = published.content.at(-1);
      if (referenceBlock?.type !== "text") throw new Error("Missing bound remote conflict references");
      const uri = /^#1: (remote-conflict:\/\/\S+)$/m.exec(referenceBlock.text)?.[1];
      expect(uri).toBe(`remote-conflict://${remote.resourceBinding}/1`);
      if (!uri) throw new Error("Missing bound reference for the registered remote conflict");
      const writeArgs = { path: uri, content: "@ours" };
      expect(resourceExecutionTarget("write", writeArgs, remote.resourceBinding)).toBe("remote");
      const nativeArgs = resolveRemoteResourceArgs("write", writeArgs, remote.resourceBinding);
      expect(nativeArgs).toEqual({ path: "conflict://1", content: "@ours" });
      const written = await remote.tools.write.execute("remote-resolve", nativeArgs) as AgentToolResult;
      expect(written.isError).not.toBe(true);
      expect(await readFile(remoteFile, "utf8")).toBe("remote-before\nremote-ours\nremote-after\n");
      expect(await readFile(localFile)).toEqual(localBefore);
      expect(local.session.conflictHistory!.get(1)?.absolutePath).toBe(localFile);
      expect(() => resourceExecutionTarget("write", writeArgs, "workspace-two")).toThrow("stale workspace binding");
      expect(() => resolveRemoteResourceArgs("write", writeArgs, "workspace-two")).toThrow("stale workspace binding");
      expect(pathShouldStayLocal("write", { path: "conflict://1", content: "@ours" })).toBe(true);
      expect(resourceExecutionTarget("write", { path: "conflict://1", content: "@ours" }, remote.resourceBinding)).toBeUndefined();
    } finally {
      try {
        await Promise.all(runtimes.map(runtime => runtime.dispose()));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

describe("native edit operand inspection", () => {
  test("checks both directions of a hashline move, including quoted destinations", () => {
    for (const [from, to] of [["file.ts", "local://plan.md"], ["local://plan.md", "file.ts"], ["file.ts", '"local://plan with spaces.md"']]) {
      const input = `*** Begin Patch\n[${from}#AB12]\nMV ${to}\n*** End Patch`;
      expect(() => pathShouldStayLocal("edit", { input })).toThrow("cannot mix");
    }
    expect(pathShouldStayLocal("edit", { input: "*** Begin Patch\n[file.ts#AB12]\nMV other.ts\n*** End Patch" })).toBe(false);
    expect(pathShouldStayLocal("edit", { input: "*** Begin Patch\n[local://a#AB12]\nMV local://b\n*** End Patch" })).toBe(true);
  });

  test("does not classify patch body literals as move operands", () => {
    const input = "*** Begin Patch\n[file.ts#AB12]\nPUT 1.=1:\n+MV local://literal\n+[local://body#AB12]\n*** End Patch";
    expect(pathShouldStayLocal("edit", { input })).toBe(false);
  });

  test("uses the effective mode for replace, patch, and apply_patch", () => {
    expect(pathShouldStayLocal("edit", { path: "local://a", old_string: "a", new_string: "b" }, "replace")).toBe(true);
    expect(pathShouldStayLocal("edit", { path: "file", old_string: "a", new_string: "b" }, "replace")).toBe(false);
    expect(() => pathShouldStayLocal("edit", { path: "file", edits: [{ op: "update", rename: "local://other", diff: "@@\n-a\n+b" }] }, "patch")).toThrow("cannot mix");
    expect(() => pathShouldStayLocal("edit", { input: "*** Begin Patch\n*** Update File: local://a\n*** Move to: file\n@@\n-a\n+b\n*** End Patch" }, "apply_patch")).toThrow("cannot mix");
    expect(() => pathShouldStayLocal("edit", { input: "not a patch" })).toThrow("Cannot classify edit paths");
    expect(() => pathShouldStayLocal("edit", { path: "file", old_string: "a", new_string: "b" }, "hashline")).toThrow("Cannot classify edit paths");
  });
});
