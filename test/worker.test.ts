import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";

let cwd: string;
let client: RemoteRuntimeClient;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-"));
  client = new RemoteRuntimeClient({
    command: ["bun", join(import.meta.dir, "../src/worker.ts")],
  });
  const ready = await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE);
  expect(ready.cwd).toBe(cwd);
  expect(ready.tools.map((tool) => tool.name).sort()).toEqual([
    "ast_edit",
    "ast_grep",
    "bash",
    "debug",
    "edit",
    "eval",
    "glob",
    "grep",
    "lsp",
    "read",
    "write",
  ]);
});

afterAll(async () => {
  await client.close();
  await rm(cwd, { recursive: true, force: true });
});

describe("native worker round trip", () => {
  test("native workspace tools share one filesystem and snapshot state", async () => {
    const writeResult = await client.execute("write", "write-1", {
      path: "probe.txt",
      content: "remote runtime\n",
    });
    expect(JSON.stringify(writeResult)).toContain("probe.txt");
    expect(await readFile(join(cwd, "probe.txt"), "utf8")).toBe(
      "remote runtime\n",
    );

    const readResult = await client.execute("read", "read-1", {
      path: "probe.txt",
    });
    const readText = JSON.stringify(readResult);
    expect(readText).toContain("remote runtime");
    const header = readText.match(/\[probe\.txt#[A-F0-9]+\]/)?.[0];
    expect(header).toBeDefined();

    const editResult = await client.execute("edit", "edit-1", {
      input: `${header}\nPUT 1.=1:\n+edited remotely`,
    });
    expect(JSON.stringify(editResult)).toContain("edited remotely");
    expect(await readFile(join(cwd, "probe.txt"), "utf8")).toBe(
      "edited remotely\n",
    );

    const grepResult = await client.execute("grep", "grep-1", {
      pattern: "edited remotely",
      path: ".",
    });
    expect(JSON.stringify(grepResult)).toContain("probe.txt");
    const globResult = await client.execute("glob", "glob-1", {
      path: "*.txt",
    });
    expect(JSON.stringify(globResult)).toContain("probe.txt");

    const bashResult = await client.execute("bash", "bash-1", {
      command: "printf 'cwd=%s\\n' \"$PWD\" && cat probe.txt",
    });
    const bashText = JSON.stringify(bashResult);
    expect(bashText).toContain(`cwd=${cwd}`);
    expect(bashText).toContain("edited remotely");
  });

  test("native xdev AST edit stages and resolves in the same ToolSession", async () => {
    await client.execute("write", "ast-write", {
      path: "ast.ts",
      content: "const value = oldApi(1);\n",
    });
    const preview = await client.execute("write", "ast-preview", {
      path: "xd://ast_edit",
      content: JSON.stringify({
        ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }],
        paths: ["ast.ts"],
      }),
    });
    expect(JSON.stringify(preview)).toContain("files NOT modified yet");
    expect(await readFile(join(cwd, "ast.ts"), "utf8")).toContain("oldApi");

    const applied = await client.execute("write", "ast-resolve", {
      path: "xd://resolve",
      content: "Apply the verified structural rewrite",
    });
    expect(JSON.stringify(applied)).toContain("Applied");
    expect(await readFile(join(cwd, "ast.ts"), "utf8")).toContain("newApi");
  });

  test("native Python eval keeps kernel state in the remote ToolSession", async () => {
    const first = await client.execute("eval", "eval-setup", {
      language: "py",
      title: "setup",
      code: "remote_value = 41",
    });
    expect(JSON.stringify(first)).not.toContain('isError":true');

    const second = await client.execute("eval", "eval-use", {
      language: "py",
      title: "reuse",
      code: "print(remote_value + 1)",
    });
    expect(JSON.stringify(second)).toContain("42");
  });

  test("native JavaScript eval keeps VM state in the remote ToolSession", async () => {
    await client.execute("eval", "eval-js-setup", {
      language: "js",
      title: "setup",
      code: "globalThis.remoteValue = 6",
    });
    const result = await client.execute("eval", "eval-js-use", {
      language: "js",
      title: "reuse",
      code: "print(globalThis.remoteValue * 7)",
    });
    expect(JSON.stringify(result)).toContain("42");
  });

  test("remote eval tool bridge uses the same remote workspace", async () => {
    const result = await client.execute("eval", "eval-tool-read", {
      language: "js",
      title: "tool read",
      code: 'print(await tool.read({ path: "probe.txt" }))',
    });
    expect(JSON.stringify(result)).toContain("edited remotely");
  });

  test("remote eval tool bridge rejects local and unsupported state domains", async () => {
    const internalUri = await client.execute("eval", "eval-tool-local-uri", {
      language: "js",
      title: "local URI",
      code: 'await tool.read({ path: "skill://planning-with-files" })',
    });
    expect(JSON.stringify(internalUri)).toContain(
      "cannot access local internal URIs",
    );

    const controlPlane = await client.execute("eval", "eval-tool-task", {
      language: "js",
      title: "control plane",
      code: 'await tool.task({ task: "inspect" })',
    });
    expect(JSON.stringify(controlPlane)).toContain("Unknown tool");

    const stagedAst = await client.execute("eval", "eval-tool-ast-edit", {
      language: "js",
      title: "stateful AST",
      code: 'await tool.ast_edit({ ops: [], paths: ["ast.ts"] })',
    });
    expect(JSON.stringify(stagedAst)).toContain("Unknown tool");
  });

  test("remote eval cannot spawn an unbridged subagent", async () => {
    const result = await client.execute("eval", "eval-agent-disabled", {
      language: "js",
      title: "agent-disabled",
      code: 'await agent("inspect the workspace")',
    });
    expect(JSON.stringify(result)).toContain("spawns disabled");
  });

  test("remote eval has no model completion capability", async () => {
    const result = await client.execute("eval", "eval-completion-disabled", {
      language: "js",
      title: "completion-disabled",
      code: 'await completion("hello")',
    });
    expect(JSON.stringify(result)).toContain("could not resolve a model");
  });

  test("native async bash remains disabled without a local hub bridge", async () => {
    await expect(
      client.execute("bash", "bash-async-disabled", {
        command: "sleep 1",
        async: true,
      }),
    ).rejects.toThrow("Async bash execution is disabled");
  });
});
