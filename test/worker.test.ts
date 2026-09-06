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
    "hub",
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
  test("truncated bash output is recoverable through remote artifact selectors", async () => {
    const result = await client.execute("bash", "large-output", { command: "seq 1 20000" });
    const uri = JSON.stringify(result).match(/remote-artifact:\/\/[a-f0-9-]+\/\d+/)?.[0];
    expect(uri).toBeDefined();
    const recovered = await client.execute("read", "recover-output", { path: `${uri}:10000-10002` });
    expect(JSON.stringify(recovered)).toContain("10000:10000");
    expect(JSON.stringify(recovered)).toContain("10002:10002");
  });

  test("debug device executes in the worker", async () => {
    const result = await client.execute("write", "debug-device", { path: "xd://debug", content: JSON.stringify({ action: "sessions" }) });
    expect(result).toMatchObject({ details: { xdev: { tool: "debug", mode: "execute", inner: { success: true } } } });
  });
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
  test("remote hub rejects messaging and job ops (local control plane)", async () => {
    await expect(
      client.execute("hub", "hub-list", { op: "list" }),
    ).rejects.toThrow("Remote hub only supervises processes");
    await expect(
      client.execute("hub", "hub-jobs", { op: "jobs" }),
    ).rejects.toThrow("Remote hub only supervises processes");
    await expect(
      client.execute("hub", "hub-send-peer", { op: "send", to: "Main", message: "x" }),
    ).rejects.toThrow("Remote hub only supervises processes");
  });

  test("remote hub supervises a process through the worker-hosted broker", async () => {
    const name = `probe-${process.pid}`;
    const started = await client.execute("hub", "hub-start", {
      op: "start",
      name,
      application: "sh",
      args: ["-c", "echo booted; sleep 30"],
      ready: { log: "booted", timeout: 20 },
    });
    const startedText = JSON.stringify(started);
    expect(startedText).toContain(name);
    expect(startedText).not.toContain("disabled");

    const listed = await client.execute("hub", "hub-ps", { op: "ps" });
    expect(JSON.stringify(listed)).toContain(name);

    const logs = await client.execute("hub", "hub-logs", { op: "logs", name });
    expect(JSON.stringify(logs)).toContain("booted");

    const stopped = await client.execute("hub", "hub-stop", { op: "stop", name });
    expect(JSON.stringify(stopped)).toContain(name);
  }, 60_000);
});

describe("hub launch ownership", () => {
  test("worker teardown stops all stubborn services while another owner remains connected", async () => {
    const ownedCwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-hub-"));
    const first = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const second = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const names = ["owned-one", "owned-two", "owned-three"];
    try {
      await first.initialize(ownedCwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: "owner" });
      await second.initialize(ownedCwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: "observer" });
      await second.execute("hub", "observe", { op: "ps" });
      for (const name of names) await first.execute("hub", name, {
        op: "start", name, application: "bun",
        args: ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
        pty: false, ready: { log: "ready", timeout: 20 },
      });
      await first.close();
      const result = await second.execute("hub", "after", { op: "ps" }) as { details: { daemons: Array<{ name: string; state: string }> } };
      for (const name of names) expect(result.details.daemons.find((daemon) => daemon.name === name)?.state).toBe("exited");
    } finally {
      for (const name of names) await second.execute("hub", `stop-${name}`, { op: "stop", name, timeout: 0.1 }).catch(() => {});
      await first.close().catch(() => {});
      await second.close().catch(() => {});
      await rm(ownedCwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("owner receives a launch-completion event when its daemon exits", async () => {
    const eventCwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-hub-evt-"));
    const owner = "session-owner-events";
    const worker = new RemoteRuntimeClient({
      command: ["bun", join(import.meta.dir, "../src/worker.ts")],
    });
    try {
      await worker.initialize(eventCwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: owner });
      const name = `short-${process.pid}`;
      const completion = new Promise<Record<string, unknown>>((resolve) => {
        worker.onEvent((event) => {
          if (event.event === "launch-completion") resolve(event.payload);
        });
      });
      await worker.execute("hub", "hub-start-short", {
        op: "start",
        name,
        application: "sh",
        args: ["-c", "echo done; exit 3"],
      });
      // The test-level timeout bounds this; the awaited signal is the real event.
      const payload = await completion;
      const daemon = payload.daemon as Record<string, unknown>;
      expect(daemon.name).toBe(name);
      expect(daemon.owner).toBe(owner);
      expect(["exited", "failed"]).toContain(String(daemon.state));
      expect(daemon.exitCode).toBe(3);
    } finally {
      await worker.close().catch(() => {});
      await rm(eventCwd, { recursive: true, force: true });
    }
  }, 60_000);
});
