import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { TuiRequest } from "./fixtures/input-entry.ts";

const cli = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/cli"));
const fixture = fileURLToPath(new URL("./fixtures/input-entry.ts", import.meta.url));
const localText = "Exclusive local fixture content, not present in the submitted input.";
const mention = "Include @local-only.txt in the context";
const loop = "/loop --until 'touch loop-ran'";

type Frame = {
  type: string; id?: string; method?: string; message?: string; notifyType?: string;
  success?: boolean; data?: { agentInvoked?: boolean }; error?: string; title?: string;
};
type Trace = { kind: string; value: unknown };
type InputResult = { response: Frame; frames: Frame[]; trace: Trace[]; git: string };

async function withHost(run: (rpc: {
  prompt(text: string): Promise<InputResult>;
  connect(): Promise<void>;
  tui(request: TuiRequest): Promise<InputResult>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omp-input-entry-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  const remoteCwd = join(root, "remote");
  const traceFile = join(root, "input.jsonl"), gitTrace = join(root, "git.log");
  const env = {
    PATH: process.env.PATH, HOME: root, TERM: "dumb", PI_CODING_AGENT_DIR: agentDir,
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    GIT_CONFIG_NOSYSTEM: "1", OPENAI_API_KEY: "input-entry-fixture-not-a-credential",
    INPUT_ENTRY_TRACE: traceFile, GIT_TRACE: gitTrace,
  };
  try {
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(remoteCwd)]);
    await Promise.all([writeFile(join(cwd, "local-only.txt"), localText), writeFile(traceFile, ""), writeFile(gitTrace, "")]);
    await writeFile(join(agentDir, "config.yml"), "commit:\n  enabled: true\ntask:\n  workerThreads: 0\n");
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd, env: { ...env, GIT_TRACE: "0" } });
    if (init.exitCode !== 0) throw new Error(`Could not create fixture Git checkout: ${init.stderr.toString()}`);
    const child = Bun.spawn([
      process.execPath, "--preload", fixture, cli, "--mode", "rpc", "--model", "openai/gpt-4.1",
      "--offline", "--no-prewalk", "--no-lsp", "--thinking", "off", "--extension", fixture,
    ], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const stderr = new Response(child.stderr).text();
    const output = createInterface({ input: Readable.from(child.stdout), crlfDelay: Infinity });
    const lines = output[Symbol.asyncIterator]();
    let id = 0;
    const send = (command: object) => { child.stdin.write(JSON.stringify(command) + "\n"); };
    async function receive(until: (frame: Frame) => boolean) {
      const frames: Frame[] = [];
      for (;;) {
        const line = await lines.next();
        if (line.done) throw new Error(`RPC exited before replying: ${await stderr}`);
        const frame: Frame = JSON.parse(line.value);
        frames.push(frame);
        if (frame.type === "extension_ui_request" && frame.method === "select") {
          // Let an unguarded native /review finish without a human or model.
          send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        }
        if (until(frame)) return { response: frame, frames };
      }
    }
    try {
      await receive(frame => frame.type === "ready");
      const prompt = async (text: string) => {
        const traceOffset = Bun.file(traceFile).size;
        const gitOffset = Bun.file(gitTrace).size;
        const requestId = `input-${++id}`;
        send({ type: "prompt", message: text, id: requestId });
        const result = await receive(frame => frame.type === "response" && frame.id === requestId);
        if (result.response.success && result.response.data?.agentInvoked !== false) {
          // In RPC the prompt acknowledgement and prompt_result can arrive in either order.
          if (!result.frames.some(frame => frame.type === "prompt_result" && frame.id === requestId)) {
            const completion = await receive(frame => frame.type === "prompt_result" && frame.id === requestId);
            result.frames.push(...completion.frames);
          }
        }
        const [trace, git] = await Promise.all([readFile(traceFile), readFile(gitTrace)]);
        return {
          ...result,
          trace: trace.subarray(traceOffset).toString().split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace),
          git: git.subarray(gitOffset).toString(),
        };
      };
      await run({
        prompt,
        async connect() {
          const connected = await prompt(`/remote-connect fixture.invalid ${JSON.stringify(remoteCwd)}`);
          if (connected.frames.some(frame => frame.notifyType === "error" || frame.type === "extension_error") || !connected.response.success) {
            throw new Error(`Fixture connection failed: ${JSON.stringify(connected.frames.filter(frame => frame.message || frame.error))}`);
          }
          const status = await prompt("/remote-status");
          expect(status.frames.find(frame => frame.method === "notify" && frame.message?.includes("Remote runtime:"))?.message,
            JSON.stringify(connected.frames.filter(frame => frame.type !== "available_commands_update")))
            .toStartWith(`Remote runtime: ${await realpath(remoteCwd)}; role=owner; tools=`);
        },
        tui: request => prompt(`/fixture-tui ${JSON.stringify(request)}`),
      });
      child.stdin.end();
      expect(await child.exited, await stderr).toBe(0);
      expect(await readFile(traceFile, "utf8")).not.toContain('"kind":"unexpected-provider-fetch"');
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      output.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const events = (result: InputResult, kind: string) => result.trace.filter(event => event.kind === kind).map(event => event.value);
const warnings = (result: InputResult) => result.frames
  .filter(frame => frame.method === "notify" && frame.notifyType === "warning").map(frame => frame.message);

function expectBlocked(result: InputResult, text: string, reason: string) {
  expect(events(result, "input"), text).toContainEqual({ text, source: "rpc" });
  expect({
    preparedPrompts: events(result, "prepared-prompt"),
    reviewPicker: result.frames.some(frame => frame.method === "select"),
    git: result.git,
  }, text).toEqual({ preparedPrompts: [], reviewPicker: false, git: "" });
  expect(result.response).toMatchObject({ success: true, data: { agentInvoked: false } });
  expect(warnings(result)).toEqual([expect.stringContaining(reason)]);
}

test("RPC input hook stops local command dispatch and file injection", async () => {
  await withHost(async ({ connect, prompt }) => {
    // Calibrate the sinks in the same native RPC process before selection.
    expect(JSON.stringify(events(await prompt(mention), "prepared-prompt"))).toContain(localText);
    const commit = await prompt("/commit");
    expect(commit.git, JSON.stringify(commit)).toContain("git ");
    const review = await prompt("/review");
    expect(review.frames).toContainEqual(expect.objectContaining({ method: "select", title: "Review Mode" }));
    await connect();
    // /git and /loop are TUI-only builtins in this SDK: in RPC the
    // unhandled forms would instead fall through to ordinary prompt preparation.
    for (const [text, reason] of [
      ["/git", "/git would act"], ["/commit", "/commit would act"], ["/review", "/review would act"],
      [mention, "@path file mentions would act"], [loop, "/loop would act"],
    ]) expectBlocked(await prompt(text), text, reason);
  });
}, 25_000);

test("RPC does not expand bare commands with either native setting", async () => {
  await withHost(async ({ connect, prompt }) => {
    await connect();
    for (const enabled of [false, true]) {
      expect(events(await prompt(`/fixture-bare ${enabled ? "on" : "off"}`), "bare-setting")).toEqual([enabled]);
      for (const text of ["git", "GiT", " GiT "]) {
        const result = await prompt(text);
        expect(events(result, "input")).toEqual([{ text, source: "rpc" }]);
        expect(warnings(result)).toEqual([]);
        const prepared = events(result, "prepared-prompt");
        expect(prepared).toHaveLength(1);
        expect(prepared[0]).toContainEqual(expect.objectContaining({
          role: "user", content: [expect.objectContaining({ type: "text", text })],
        }));
      }
      expectBlocked(await prompt("/git"), "/git", "/git would act");
    }
  });
}, 25_000);

test("TUI input hook runs before the native builtin handler", async () => {
  await withHost(async ({ connect, tui }) => {
    const inputs = { bare: false, enter: ["/git", loop] };
    const local = await tui(inputs);
    expect(local.trace.filter(event => event.kind.startsWith("tui-") ||
      (event.kind === "input" && (event.value as { source: string }).source === "interactive"))).toEqual([
      { kind: "input", value: { text: "/git", source: "interactive" } },
      { kind: "tui-git-ui", value: true }, { kind: "tui-enter-complete", value: "" },
      { kind: "input", value: { text: loop, source: "interactive" } },
      { kind: "tui-loop", value: loop.slice("/loop ".length) }, { kind: "tui-enter-complete", value: "" },
    ]);
    await connect();
    const blocked = await tui(inputs);
    expect(events(blocked, "tui-git-ui")).toEqual([]);
    expect(events(blocked, "tui-loop")).toEqual([]);
    expect(events(blocked, "tui-prompt")).toEqual([]);
    expect(events(blocked, "tui-enter-complete")).toEqual(["", ""]);
    expect(warnings(blocked)).toEqual([expect.stringContaining("/git would act"), expect.stringContaining("/loop would act")]);
  });
}, 25_000);

test("TUI bare-command settings and confirmation precede dispatch but follow the input hook", async () => {
  await withHost(async ({ connect, tui }) => {
    const disabled = await tui({ bare: false, enter: ["git", "GiT", " GiT ", "git words"] });
    expect(events(disabled, "tui-git-ui")).toEqual([]);
    expect(events(disabled, "tui-prompt")).toEqual(["git", "GiT", "GiT", "git words"]);
    const enabled = await tui({ bare: true, enter: ["git", "GiT", " GiT ", "git words"] });
    expect(events(enabled, "tui-git-ui")).toEqual([true, true]);
    expect(events(enabled, "tui-prompt")).toEqual(["GiT", "git words"]);
    const confirmed = await tui({ bare: true, nonempty: true, enter: ["GiT", null] });
    expect(events(confirmed, "tui-status")).toEqual([expect.stringContaining("Press Enter again to run /git")]);
    expect(confirmed.trace.filter(event => event.kind === "tui-enter-complete" || event.kind === "tui-git-ui")).toEqual([
      { kind: "tui-enter-complete", value: "GiT" }, { kind: "tui-git-ui", value: true }, { kind: "tui-enter-complete", value: "" },
    ]);
    await connect();
    const connectedDisabled = await tui({ bare: false, nonempty: true, enter: ["GiT"] });
    expect(events(connectedDisabled, "tui-prompt")).toEqual(["GiT"]);
    expect(warnings(connectedDisabled)).toEqual([]);
    const connectedEnabled = await tui({ bare: true, nonempty: true, enter: ["GiT"] });
    expect(events(connectedEnabled, "tui-enter-complete")).toEqual([""]);
    expect(events(connectedEnabled, "tui-status")).toEqual([]);
    expect(events(connectedEnabled, "tui-git-ui")).toEqual([]);
    expect(events(connectedEnabled, "tui-prompt")).toEqual([]);
    expect(warnings(connectedEnabled)).toEqual([expect.stringContaining("/git would act")]);
  });
}, 25_000);
