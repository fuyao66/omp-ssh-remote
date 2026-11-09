import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { RemoteRuntimeClient } from "../src/client.ts";
import { OMP_RUNTIME_HANDSHAKE } from "../src/omp/runtime-contract.ts";

type Language = "js" | "py";
const text = (result: AgentToolResult) => result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
// These are real worker/OS-child integration boundaries: fake JS timers cannot
// advance the companion's executor deadline or observe a non-child PID's exit.
async function until(description: string, predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}
async function childPid(path: string): Promise<number> {
  let pid = 0;
  await until(`child pid in ${path}`, async () => {
    const value = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    if (!/^\d+$/.test(value)) return false;
    pid = Number(value); return true;
  });
  return pid;
}
// External Python gives the assertion a real child PID, not the embedded shell's
// worker PID. The file handshake localizes cancellation after the child starts.
const sleeper = (file: string) => `python3 -u -c 'import os,time; open("${file}","w").write(str(os.getpid())); print("CHILD_READY",flush=True); time.sleep(60)'`;
function shell(language: Language, command: string, options: { cwd?: string; timeout?: number } = {}): string {
  const args = JSON.stringify(command);
  return language === "js" ? `await sh(${args}, ${JSON.stringify(options)})`
    : `sh(${args}${options.cwd === undefined ? "" : `, cwd=${JSON.stringify(options.cwd)}`}${options.timeout === undefined ? "" : `, timeout=${options.timeout}`})`;
}

for (const language of ["js", "py"] as const) {
  describe(`native ${language} Eval sh on the companion`, () => {
    let cwd: string;
    let worker: RemoteRuntimeClient;
    let calls = 0;
    const evalCell = async (code: string, signal?: AbortSignal) => worker.execute("eval", `${language}-shell-${++calls}`, {
      language, title: "native shell contract", code, timeout: 10,
    }, signal, undefined, {
      // sh is a native Eval helper, not an ordinary nested tool. Translating it
      // to tool.bash would trigger this denial and change its state/error contract.
      onInvoke: async () => { throw new Error("Unexpected host tool invocation from native sh"); },
    }) as Promise<AgentToolResult>;
    beforeAll(async () => {
      cwd = await mkdtemp(join(tmpdir(), `omp-eval-sh-${language}-`));
      await mkdir(join(cwd, "subdir"));
      worker = new RemoteRuntimeClient({ command: [process.execPath, join(import.meta.dir, "../src/worker.ts")] });
      await worker.initialize(cwd, OMP_RUNTIME_HANDSHAKE);
    });
    afterAll(async () => { try { await worker.close(); } finally { await rm(cwd, { recursive: true, force: true }); } });

    test("cwd, persistent shell state, raw output and ShellError remain native and separate from Bash", async () => {
      await worker.execute("bash", "bash-state", { command: "export OMP_SH_SCOPE=bash" });
      const first = await evalCell(`print(${shell(language, 'printf "INHERITED=%s\\n" "${OMP_SH_SCOPE-unset}"; export OMP_SH_SCOPE=eval; sh_value() { printf function_kept; }; pwd')})`);
      expect(first.isError).not.toBe(true);
      expect(text(first)).toContain(`INHERITED=unset\n${cwd}`);
      const reused = await evalCell(`print(${shell(language, 'printf "STATE=%s\\n" "$OMP_SH_SCOPE"; sh_value; printf "\\n"; pwd', { cwd: "subdir" })})`);
      expect(reused.isError).not.toBe(true);
      expect(text(reused)).toContain(`STATE=eval\nfunction_kept\n${join(cwd, "subdir")}`);
      const resetCwd = await evalCell(`print(${shell(language, "pwd")})`);
      expect(text(resetCwd).trim()).toBe(cwd);
      const bash = await worker.execute("bash", "bash-state-intact", { command: 'printf "BASH=%s" "$OMP_SH_SCOPE"' }) as AgentToolResult;
      expect(text(bash)).toContain("BASH=bash");
      const output = await evalCell(`print(${shell(language, "printf 'STDOUT\\n'; printf 'STDERR\\n' >&2")})`);
      expect(output.isError).not.toBe(true);
      expect(text(output)).toContain("STDOUT\nSTDERR");
      const failing = shell(language, "printf 'FAIL_OUTPUT\\n'; (exit 7)");
      const failure = await evalCell(language === "js"
        ? `try { ${failing}; throw new Error("sh accepted a nonzero exit"); } catch (error) { if (error.name !== "ShellError" || error.exitCode !== 7 || error.output !== "FAIL_OUTPUT\\n") throw error; print("NONZERO_OK"); }`
        : `try:\n    ${failing}\n    raise AssertionError("sh accepted a nonzero exit")\nexcept ShellError as error:\n    assert error.exit_code == 7 and error.output == "FAIL_OUTPUT\\n"\n    print("NONZERO_OK")`);
      expect(failure.isError).not.toBe(true);
      expect(text(failure).trim()).toBe("NONZERO_OK");
      const timeout = shell(language, sleeper("timeout.pid"), { timeout: 0.5 });
      const timed = await evalCell(language === "js"
        ? `try { ${timeout}; throw new Error("sh ignored its timeout"); } catch (error) { if (error.name !== "ShellError" || error.exitCode !== undefined || !error.output.includes("CHILD_READY") || !error.message.includes("timed out")) throw error; print("TIMEOUT_OK"); }`
        : `try:\n    ${timeout}\n    raise AssertionError("sh ignored its timeout")\nexcept ShellError as error:\n    assert error.exit_code is None and "CHILD_READY" in error.output and "timed out" in str(error)\n    print("TIMEOUT_OK")`);
      expect(timed.isError).not.toBe(true);
      expect(text(timed).trim()).toBe("TIMEOUT_OK");
      const pid = await childPid(join(cwd, "timeout.pid"));
      await until("timed-out shell child to exit", () => !alive(pid));
      const usable = await evalCell(`print(${shell(language, "printf usable_after_timeout")})`);
      expect(usable.isError).not.toBe(true);
      expect(text(usable).trim()).toBe("usable_after_timeout");
    }, 30_000);

    test("cell cancellation leaves a usable kernel; closing the worker reaps an active shell child", async () => {
      const controller = new AbortController();
      const cancelledCode = `${language === "js" ? "globalThis.beforeCancelState = 42;\n" : ""}print(${shell(language, sleeper("cancel.pid"))})`;
      const running = evalCell(cancelledCode, controller.signal)
        .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
      const pid = await childPid(join(cwd, "cancel.pid"));
      controller.abort(new Error("cancel native sh acceptance"));
      const cancelled = await running;
      if (cancelled.error) expect(String(cancelled.error)).toMatch(/abort|cancel|interrupt/i);
      else {
        expect(cancelled.result!.isError).toBe(true);
        expect(text(cancelled.result!)).toMatch(/abort|cancel|interrupt/i);
      }
      await until("cancelled shell child to exit", () => !alive(pid));
      const usableCode = `${language === "js" ? 'print("STATE=" + typeof globalThis.beforeCancelState);\n' : ""}print(${shell(language, "printf usable_after_cancel")})`;
      const usable = await evalCell(usableCode);
      expect(usable.isError).not.toBe(true);
      if (language === "js") {
        // Native cancellation force-kills the JS worker, not only its shell
        // command. The next cell announces state loss and runs in a fresh VM.
        expect(text(usable)).toMatch(/^Kernel restarted: the previous JS worker is dead; state is unavailable\./);
        expect(text(usable)).toContain("variables, imports and definitions from earlier cells are gone.");
        expect(text(usable).trim().split("\n").slice(-2)).toEqual(["STATE=undefined", "usable_after_cancel"]);
        const next = await evalCell(`print(${shell(language, "printf usable_after_restart")})`);
        expect(next.isError).not.toBe(true);
        expect(text(next).trim()).toBe("usable_after_restart");
      } else {
        expect(text(usable).trim()).toBe("usable_after_cancel");
      }
      const closing = evalCell(`print(${shell(language, sleeper("close.pid"))})`)
        .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
      const closePid = await childPid(join(cwd, "close.pid"));
      await worker.close();
      expect(await worker.waitForExit()).toBe(0);
      const closed = await closing;
      expect(String(closed.error)).toMatch(/closed|disconnect/i);
      await until("closed worker shell child to exit", () => !alive(closePid));
      await expect(worker.execute("eval", "closed-worker", { language, code: 'print("must not run")' })).rejects.toThrow(/disconnect/);
    }, 30_000);
  });
}
