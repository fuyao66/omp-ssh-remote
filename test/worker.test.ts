import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "node:fs";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { startRemoteService } from "../src/omp/service-jobs.ts";
import { executeOwnedRemoteService } from "../src/omp/service-lifecycle.ts";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

const ownerSessionId = "native-worker-owner";
let cwd: string;
let client: RemoteRuntimeClient;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-"));
  client = new RemoteRuntimeClient({
    command: ["bun", join(import.meta.dir, "../src/worker.ts")],
    env: { PI_SESSION_ID: "inherited-wrong-owner", PI_SESSION_FILE: "/local-only/inherited-session.jsonl" },
  });
  const ready = await client.initialize(cwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: ownerSessionId });
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
  expect(await client.waitForExit()).toBe(0);
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

  for (const via of ["read", "grep"] as const) {
    test(`${via} cannot authorize editing a column-truncated line`, async () => {
      const path = `long-${via}.txt`;
      const original = `LONG_SENTINEL${"x".repeat(20_000)}TAIL_SENTINEL\n`;
      await client.execute("write", `long-write-${via}`, { path, content: original });
      const preview = await client.execute(via, `long-preview-${via}`, via === "read" ? { path } : { path, pattern: "LONG_SENTINEL" });
      const header = JSON.stringify(preview).match(/\[long-(?:read|grep)\.txt#[A-F0-9]+\]/)?.[0];
      expect(header).toBeDefined();
      const rejected = await client.execute("edit", `long-unsafe-${via}`, {
        input: `${header}\nPUT 1.=1:\n+replacement`,
      }).catch((error: Error) => ({ isError: true, error: error.message }));
      expect(rejected).toMatchObject({ isError: true });
      expect(await readFile(join(cwd, path), "utf8")).toBe(original);
      await client.execute("read", `long-full-${via}`, { path: `${path}:raw` });
      await client.execute("edit", `long-safe-${via}`, { input: `${header}\nPUT 1.=1:\n+replacement` });
      expect(await readFile(join(cwd, path), "utf8")).toBe("replacement\n");
    });
  }
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

  test("eval print remains available after native display removal", async () => {
    const js = await client.execute("eval", "print-only-js", { language: "js", title: "print contract", code: 'console.log("JS_DISPLAY", typeof display); print("JS_PRINT", 42)' });
    expect(js).not.toMatchObject({ isError: true });
    expect(JSON.stringify(js)).toContain("JS_DISPLAY undefined");
    expect(JSON.stringify(js)).toContain("JS_PRINT 42");
    const py = await client.execute("eval", "print-only-py", { language: "py", title: "print contract", code: 'print("PY_DISPLAY", "display" in globals()); print("PY_PRINT", 42)' });
    expect(py).not.toMatchObject({ isError: true });
    expect(JSON.stringify(py)).toContain("PY_DISPLAY False");
    expect(JSON.stringify(py)).toContain("PY_PRINT 42");
  });

  test("foreground bash retains session variables across remote calls", async () => {
    await client.execute("bash", "shell-export", { command: "export OMP_REMOTE_SHELL_SENTINEL=remote_persisted" });
    const result = await client.execute("bash", "shell-reuse", { command: 'printf "%s" "$OMP_REMOTE_SHELL_SENTINEL"' });
    expect(JSON.stringify(result)).toContain("remote_persisted");
  });

  test("job shells neither inherit nor mutate the foreground session shell", async () => {
    const scope = { bashScope: "job" as const };
    await client.execute("bash", "isolation-export", { command: "export OMP_REMOTE_SCOPE=foreground" });
    const first = await client.execute("bash", "isolated-first", { name: "", command: 'printf "INHERITED=%s" "${OMP_REMOTE_SCOPE-unset}"; export OMP_REMOTE_SCOPE=job' }, undefined, undefined, scope);
    expect(JSON.stringify(first)).toContain("INHERITED=unset");
    const second = await client.execute("bash", "isolated-second", { name: "  ", command: 'printf "NEXT=%s" "${OMP_REMOTE_SCOPE-unset}"' }, undefined, undefined, scope);
    expect(JSON.stringify(second)).toContain("NEXT=unset");
    const foreground = await client.execute("bash", "foreground-intact", { command: 'printf "FOREGROUND=%s" "$OMP_REMOTE_SCOPE"' });
    expect(JSON.stringify(foreground)).toContain("FOREGROUND=foreground");
  });

  for (const bashScope of [undefined, "session", "job"] as const) {
    test(`bash session identity is preserved in ${bashScope ?? "direct"} execution`, async () => {
      const result = await client.execute("bash", `identity-${bashScope ?? "direct"}`, {
        command: 'printf "SESSION_ID=%s\\nSESSION_FILE=<%s>\\n" "$PI_SESSION_ID" "$PI_SESSION_FILE"',
      }, undefined, undefined, bashScope ? { bashScope } : undefined);
      expect(result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(`SESSION_ID=${ownerSessionId}\\n`);
      expect(JSON.stringify(result)).toContain("SESSION_FILE=<>");
      expect(JSON.stringify(result)).not.toContain("inherited-wrong-owner");
      expect(JSON.stringify(result)).not.toContain("inherited-session.jsonl");
    });
  }

  test("foreground-backed capture retains the owning session shell", async () => {
    const result = await client.execute("bash", "managed-export", {
      command: "export OMP_MANAGED_SCOPE=managed",
    }, undefined, undefined, { bashScope: "session" });
    expect(result).not.toMatchObject({ isError: true });
    const next = await client.execute("bash", "managed-reuse", { command: 'printf "MANAGED=%s" "$OMP_MANAGED_SCOPE"' });
    expect(JSON.stringify(next)).toContain("MANAGED=managed");
  });

  test("concurrent captured job shells keep independent state under one owner", async () => {
    const results = await Promise.all(["A", "B"].map(value => client.execute("bash", `concurrent-${value}`, {
      command: `export OMP_CONCURRENT=${value}; printf ready > job-ready-${value}; while [ ! -f job-ready-${value === "A" ? "B" : "A"} ]; do sleep 0.01; done; printf 'VALUE=%s\\nOWNER=%s\\n' "$OMP_CONCURRENT" "$PI_SESSION_ID"`,
      timeout: 3,
    }, AbortSignal.timeout(5_000), undefined, { bashScope: "job" })));
    for (const [index, result] of results.entries()) {
      expect(result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(`VALUE=${index === 0 ? "A" : "B"}`);
      expect(JSON.stringify(result)).toContain(`OWNER=${ownerSessionId}`);
    }
    const foreground = await client.execute("bash", "concurrent-foreground-intact", { command: 'printf "FOREGROUND=%s" "${OMP_CONCURRENT-unset}"' });
    expect(JSON.stringify(foreground)).toContain("FOREGROUND=unset");
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

  test("remote hub supervises a process through the worker-hosted broker", async () => {
    const name = `probe-${process.pid}`;
    const started = await client.execute("bash", "service-start", {
      name,
      command: "echo booted; sleep 30",
      pty: false,
      async: true,
      timeout: 1,
      ready: { log: "booted", timeout: 20 },
    });
    const startedText = JSON.stringify(started);
    expect(startedText).toContain(name);
    expect(startedText).not.toContain("disabled");
    expect(startedText).toContain("Ignored timeout: service-only");
    expect(startedText).toContain("Ignored async: service-only");

    const listed = await client.execute("read", "service-list", { path: "proc://" });
    expect(JSON.stringify(listed)).toContain(name);

    const logs = await client.execute("read", "service-logs", { path: `proc://${name}` });
    expect(JSON.stringify(logs)).toContain("booted");

    const stopped = await client.execute("write", "service-stop", { path: `proc://${name}/kill`, content: "" });
    expect(JSON.stringify(stopped)).toContain(name);
  }, 60_000);
  test("a queued host message interrupts readiness but leaves the service running", async () => {
    const name = `steer-${process.pid}`;
    const marker = `${name}.started`;
    const steering = new AbortController();
    const watcher = watch(cwd, { persistent: false }, (_event, file) => {
      if (file === marker) steering.abort();
    });
    try {
      const started = Date.now();
      const result = await client.execute("bash", "steer-ready", {
        name, command: `touch '${marker}'; sleep 30`, pty: false,
        ready: { log: "NEVER_READY", timeout: 20 },
      }, AbortSignal.timeout(15_000), undefined, { steeringSignal: steering.signal });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(JSON.stringify(result)).toContain("Readiness wait interrupted");
      const status = await client.execute("read", "steer-still-running", { path: `proc://${name}` });
      expect(JSON.stringify(status)).toContain("starting");
    } finally {
      watcher.close();
      await client.execute("write", "steer-stop", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
    }
  }, 30_000);
  test("readiness cancellation reaps the created process before the local job settles", async () => {
    const manager = new AsyncJobManager({ maxRunningJobs: 1 });
    const name = `abort-${process.pid}`;
    const marker = `${name}.pid`;
    const launch = new AbortController();
    const watcher = watch(cwd, { persistent: false }, (_event, file) => {
      if (file === marker) launch.abort(new Error("cancel after process creation"));
    });
    try {
      const started = startRemoteService(client, name, "Main", manager, async signal =>
        await client.execute("bash", "cancel-native-readiness", {
          name, command: `echo $$ > '${marker}'; exec sleep 30`, pty: false,
          ready: { log: "NEVER_READY", timeout: 20 },
        }, signal) as AgentToolResult, launch.signal);
      await expect(started).rejects.toThrow("cancel");
      const job = manager.getAllJobs()[0]!;
      await job.promise;
      expect(["failed", "cancelled"]).toContain(job.status);
      const pid = Number((await readFile(join(cwd, marker), "utf8")).trim());
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(client.isClosed).toBe(false);
      const status = await client.execute("read", "cancelled-state", { path: `proc://${name}` });
      expect(JSON.stringify(status)).toContain("exited");
    } finally {
      watcher.close();
      await client.execute("write", "cancel-test-cleanup", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
      await manager.dispose({ timeoutMs: 1000 });
    }
  }, 30_000);
  test("same-name preflight failure cannot roll back the existing instance", async () => {
    const manager = new AsyncJobManager({ maxRunningJobs: 1 });
    const name = `guard-${process.pid}`;
    try {
      const original = await client.execute("bash", "guard-start", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } }) as AgentToolResult<{ service: { id: string; pid: number } }>;
      const receipt = original.details!.service;
      await expect(startRemoteService(client, name, "Main", manager, async signal =>
        await client.execute("bash", "guard-invalid", { name, command: "true", cwd: join(cwd, `missing-${crypto.randomUUID()}`) }, signal) as AgentToolResult)).rejects.toThrow("Working directory does not exist");
      await manager.getAllJobs()[0]!.promise;
      expect(process.kill(receipt.pid, 0)).toBe(true);
      const stopped = await client.stopService(name, receipt.id);
      expect(stopped).toHaveProperty("status", "stopped");
    } finally {
      await client.execute("write", "guard-cleanup", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
      await manager.dispose({ timeoutMs: 1000 });
    }
  }, 30_000);
  test("instance-scoped stop refuses replacement and is repeatable for the owned instance", async () => {
    const name = `replace-${process.pid}`;
    try {
      const first = await client.execute("bash", "replace-first", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } }) as AgentToolResult<{ service: { id: string } }>;
      const second = await client.execute("bash", "replace-second", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } }) as AgentToolResult<{ service: { id: string; pid: number } }>;
      expect(first.details!.service.id).not.toBe(second.details!.service.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await client.stopService(name, first.details!.service.id)).toHaveProperty("status", "replaced");
        expect(process.kill(second.details!.service.pid, 0)).toBe(true);
      }
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await client.stopService(name, second.details!.service.id)).toHaveProperty("status", "stopped");
    } finally {
      await client.execute("write", "replace-cleanup", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
    }
  }, 30_000);
  test("another worker explicitly stopping readiness settles the terminal launch without a completion event", async () => {
    const manager = new AsyncJobManager({ maxRunningJobs: 1 });
    const observer = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const name = `stop-ready-${process.pid}`;
    const marker = `${name}.started`;
    const created = Promise.withResolvers<void>();
    const watcher = watch(cwd, { persistent: false }, (_event, file) => {
      if (file === marker) created.resolve();
    });
    try {
      await observer.initialize(cwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: "readiness-stop-observer" });
      const started = startRemoteService(client, name, "Main", manager, async signal =>
        await client.execute("bash", "externally-stopped-readiness", {
          name, command: `touch '${marker}'; exec sleep 30`, pty: false,
          ready: { log: "NEVER_READY", timeout: 20 },
        }, signal) as AgentToolResult);
      void started.catch(() => {});
      await created.promise;
      const before = await observer.execute("read", "before-external-stop", { path: `proc://${name}` }) as AgentToolResult<{ proc: { daemon: { id: string; pid: number; state: string } } }>;
      expect(before.details!.proc.daemon.state).toBe("starting");
      expect(await observer.stopService(name, before.details!.proc.daemon.id)).toHaveProperty("status", "stopped");
      const result = await started;
      expect(result).toHaveProperty("details.service.ownership", "terminal");
      const job = manager.getAllJobs()[0]!;
      await job.promise;
      expect(job.status).toBe("completed");
      expect(job.resultText).toContain('"operation":"launch-settled"');
      expect(() => process.kill(before.details!.proc.daemon.pid, 0)).toThrow();
      expect(client.isClosed).toBe(false);
    } finally {
      watcher.close();
      await observer.execute("write", "stop-ready-cleanup", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
      await manager.dispose({ timeoutMs: 1000 });
      await observer.close().catch(() => {});
    }
  }, 30_000);
  test("a replaced launch lookup settles its job without observing or stopping the replacement", async () => {
    const manager = new AsyncJobManager({ maxRunningJobs: 1 });
    const observer = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const name = `settled-replace-${process.pid}`;
    let replacementPid: number | undefined;
    try {
      await observer.initialize(cwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: "replacement-observer" });
      const result = await startRemoteService(client, name, "Main", manager, async signal =>
        await executeOwnedRemoteService(cwd, ownerSessionId, name, async () => {
          const receipt = await client.execute("bash", "settled-original", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } });
          const replacement = await observer.execute("bash", "settled-replacement", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } }) as AgentToolResult<{ service: { pid: number } }>;
          replacementPid = replacement.details!.service.pid;
          return receipt;
        }, signal) as AgentToolResult);
      expect(result).toHaveProperty("details.service.ownership", "replaced");
      const job = manager.getAllJobs()[0]!;
      await job.promise;
      expect(job.status).toBe("completed");
      expect(job.resultText).toContain('"ownership":"replaced"');
      expect(process.kill(replacementPid!, 0)).toBe(true);
      expect(manager.cancel(job.id)).toBe(false);
      expect(process.kill(replacementPid!, 0)).toBe(true);
    } finally {
      await observer.execute("write", "settled-replacement-cleanup", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
      await manager.dispose({ timeoutMs: 1000 });
      await observer.close().catch(() => {});
    }
  }, 30_000);
  test("receipt lookup rejects replacement PID/owner and unsupported receipts without killing by name", async () => {
    const name = `lookup-${process.pid}`;
    const abort = new AbortController();
    let replacementPid: number | undefined;
    try {
      await expect(executeOwnedRemoteService(cwd, ownerSessionId, name, async () => {
        const first = await client.execute("bash", "lookup-first", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } });
        const second = await client.execute("bash", "lookup-second", { name, command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } }) as AgentToolResult<{ service: { pid: number } }>;
        replacementPid = second.details!.service.pid;
        abort.abort(new Error("cancel after replacement"));
        return first;
      }, abort.signal)).rejects.toThrow("cancel after replacement");
      expect(process.kill(replacementPid!, 0)).toBe(true);
      await expect(executeOwnedRemoteService(cwd, ownerSessionId, name, async () => ({
        content: [], details: { service: { name, state: "running" } },
      }))).rejects.toThrow("no process PID");
      const failed = { content: [], isError: true };
      expect(await executeOwnedRemoteService(cwd, ownerSessionId, name, async () => failed)).toBe(failed);
      const ownerMismatch = await executeOwnedRemoteService(cwd, "different-owner", name, async () => ({
        content: [], details: { service: { name, state: "running", pid: replacementPid } },
      })) as AgentToolResult<{ service: { ownership: string } }>;
      expect(ownerMismatch.details!.service.ownership).toBe("replaced");
      expect(process.kill(replacementPid!, 0)).toBe(true);
    } finally {
      await client.execute("write", "lookup-cleanup", { path: `proc://${name}/kill`, content: "" }).catch(() => {});
      (await daemonClientForProject(cwd)).close();
    }
  }, 30_000);
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
      await second.execute("read", "observe", { path: "proc://" });
      for (const name of names) await first.execute("bash", name, {
        name, command: `bun -e "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"`,
        pty: false, ready: { log: "ready", timeout: 20 },
      });
      await first.close();
      for (const name of names) {
        const result = await second.execute("read", `after-${name}`, { path: `proc://${name}` });
        expect(JSON.stringify(result)).toContain(`${name} [service] — exited`);
      }
    } finally {
      for (const name of names) await second.execute("write", `stop-${name}`, { path: `proc://${name}/kill`, content: "" }).catch(() => {});
      await first.close().catch(() => {});
      await second.close().catch(() => {});
      await rm(ownedCwd, { recursive: true, force: true });
    }
  }, 60_000);
  test("omitted owners are unique and share native identity with shutdown and signal cleanup", async () => {
    const ownedCwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-owner-"));
    const first = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const second = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const observer = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    const names = ["omitted-first", "omitted-second"];
    try {
      await first.initialize(ownedCwd, OMP_RUNTIME_HANDSHAKE);
      await second.initialize(ownedCwd, OMP_RUNTIME_HANDSHAKE);
      await observer.initialize(ownedCwd, OMP_RUNTIME_HANDSHAKE, undefined, { sessionId: " explicit observer " });
      const snapshots: Array<{ owner: string; pid: number }> = [];
      for (const [index, worker] of [first, second].entries()) {
        await worker.execute("bash", `omitted-${index}`, { name: names[index], command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } });
        const status = await observer.execute("read", `owner-${index}`, { path: `proc://${names[index]}` }) as AgentToolResult<{ proc: { daemon: { owner: string; pid: number } } }>;
        snapshots.push(status.details!.proc.daemon);
      }
      expect(snapshots[0]!.owner).toStartWith("omp-ssh-remote:");
      expect(snapshots[1]!.owner).toStartWith("omp-ssh-remote:");
      expect(snapshots[0]!.owner).not.toBe(snapshots[1]!.owner);
      await first.close();
      expect(() => process.kill(snapshots[0]!.pid, 0)).toThrow();
      expect(process.kill(snapshots[1]!.pid, 0)).toBe(true);
      const explicit = await observer.execute("bash", "explicit-owner", { name: "explicit-owner", command: "echo ready; sleep 30", pty: false, ready: { log: "ready" } });
      expect(explicit).toHaveProperty("details.service.ownership", "owned");
      const status = await observer.execute("read", "explicit-status", { path: "proc://explicit-owner" }) as AgentToolResult<{ proc: { daemon: { owner: string; pid: number } } }>;
      expect(status.details!.proc.daemon.owner).toBe(" explicit observer ");
      second.kill();
      expect(await second.waitForExit()).toBe(143);
      expect(() => process.kill(snapshots[1]!.pid, 0)).toThrow();
      expect(process.kill(status.details!.proc.daemon.pid, 0)).toBe(true);
      await observer.close();
      expect(() => process.kill(status.details!.proc.daemon.pid, 0)).toThrow();
    } finally {
      await first.close().catch(() => {});
      await second.close().catch(() => {});
      await observer.close().catch(() => {});
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
      await worker.execute("bash", "service-start-short", {
        name,
        command: "echo done; exit 3",
        pty: false,
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

describe("forwarded execution settings", () => {
  test("bash interceptor uses forwarded rules and the local active tool set", async () => {
    const settingsCwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-settings-"));
    const worker = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    try {
      await worker.initialize(settingsCwd, OMP_RUNTIME_HANDSHAKE, undefined, {
        settings: {
          "bashInterceptor.enabled": true,
          "bashInterceptor.patterns": [
            { pattern: "^\\s*cat\\s+", tool: "read", message: "forwarded-rule: use read" },
          ],
        },
      });
      await Bun.write(join(settingsCwd, "note.txt"), "plain\n");
      // Without the local tool set nothing can be intercepted (rule target unavailable).
      const plain = JSON.stringify(await worker.execute("bash", "no-names", { command: "cat note.txt" }));
      expect(plain).toContain("plain");
      expect(plain).not.toContain("forwarded-rule");
      // With the active tool names the forwarded rule blocks the command remotely
      // (native BashTool raises a ToolError, surfaced as a rejected execute).
      await expect(
        worker.execute("bash", "with-names", { command: "cat note.txt" }, undefined, undefined, { toolNames: ["read", "bash"] }),
      ).rejects.toThrow(/forwarded-rule: use read/);
    } finally {
      await worker.close().catch(() => {});
      await rm(settingsCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("tools.maxTimeout caps remote bash and structural pins beat forwarded values", async () => {
    const settingsCwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-settings-"));
    const worker = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    try {
      const ready = await worker.initialize(settingsCwd, OMP_RUNTIME_HANDSHAKE, undefined, {
        settings: { "tools.maxTimeout": 1 },
      });
      // A forwarded value must never change the admitted tool set or schemas.
      expect(ready.tools.map((tool) => tool.name)).toContain("bash");
      const started = Date.now();
      const result = JSON.stringify(
        await worker.execute("bash", "capped", { command: "sleep 5; echo finished", timeout: 30 }).catch((error: Error) => error.message),
      );
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(result).not.toContain("finished");
    } finally {
      await worker.close().catch(() => {});
      await rm(settingsCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("forwarded artifact cap bounds shell storage while retaining the output tail", async () => {
    const settingsCwd = await mkdtemp(join(tmpdir(), "omp-ssh-remote-cap-"));
    const worker = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    try {
      await worker.initialize(settingsCwd, OMP_RUNTIME_HANDSHAKE, undefined, {
        settings: { "tools.artifactMaxBytes": 1 },
      });
      const result = await worker.execute("bash", "cap-output", {
        command: "printf 'CAP_HEAD\\n'; seq 1 400000; printf 'CAP_TAIL\\n'",
      });
      const uri = JSON.stringify(result).match(/remote-artifact:\/\/([a-f0-9-]+)\/(\d+)/);
      expect(uri).not.toBeNull();
      const { readdir, stat } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const artifactDir = join(homedir(), ".cache/omp-ssh-remote/artifacts", uri![1]!);
      const file = (await readdir(artifactDir)).find(name => name.startsWith(`${uri![2]}.`))!;
      expect((await stat(join(artifactDir, file))).size).toBeLessThan(1.1 * 1024 * 1024);
      const tail = await worker.execute("read", "cap-tail", { path: `${uri![0]}:-3:raw` });
      expect(JSON.stringify(tail)).toContain("CAP_TAIL");
    } finally {
      await worker.close().catch(() => {});
      await rm(settingsCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("git worktree add is not rewritten into a worker self-invocation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "omp-ssh-remote-wt-"));
    const worker = new RemoteRuntimeClient({ command: ["bun", join(import.meta.dir, "../src/worker.ts")] });
    try {
      await worker.initialize(repo, OMP_RUNTIME_HANDSHAKE);
      const setup = "git init -q -b main . && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init";
      await worker.execute("bash", "wt-setup", { command: setup });
      const output = JSON.stringify(
        await worker.execute("bash", "wt-add", { command: "git worktree add -q ../wt-probe-branch -b probe && echo WT_OK" }),
      );
      expect(output).toContain("WT_OK");
      const listed = JSON.stringify(await worker.execute("bash", "wt-list", { command: "git worktree list" }));
      expect(listed).toContain("wt-probe-branch");
      await worker.execute("bash", "wt-rm", { command: "git worktree remove --force ../wt-probe-branch" });
    } finally {
      await worker.close().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
