// Admit and execute the helper in one RPC session; do not submit unknown commands.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const commands: Record<string, { command: string; marker: string }> = {
  cache: { command: "remote-cache-smoke", marker: "CACHE_SMOKE_PASS" },
  lifecycle: { command: "remote-lifecycle-smoke", marker: "LIFECYCLE_SMOKE_PASS" },
  capture: { command: "remote-capture-smoke", marker: "CAPTURE_SMOKE_PASS" },
  "rich-output": { command: "remote-rich-output-smoke", marker: "RICH_OUTPUT_SMOKE_PASS" },
};
const name = process.argv[2] ?? "cache";
const selected = Object.hasOwn(commands, name) ? commands[name] : undefined;
if (!selected) throw new Error("Usage: bun scripts/run-smoke.ts [cache|lifecycle|capture|rich-output]");
const bundle = resolve(import.meta.dir, `../packages/omp/dist/${name}-smoke.js`);
if (!await Bun.file(bundle).exists()) throw new Error(`Build the helper first: bun scripts/build-smoke.ts ${name}`);
const directory = await mkdtemp(join(tmpdir(), `omp-${name}-accept-`));
const config: string[] = [];
if (name === "capture") {
  const file = join(directory, "config.yml");
  await writeFile(file, "bash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 300\n");
  config.push("--config", file);
}
const child = Bun.spawn([Bun.env.OMP_BINARY ?? "omp", "--no-extensions", "--no-skills", "--no-rules", "--no-title", ...config, "--session-dir", join(directory, "sessions"), "-e", bundle, "--approval-mode", "yolo", "--mode", "rpc"], { cwd: "/tmp", stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const errorText = new Response(child.stderr).text();
let started = false; let passed = false; let expired = false; let completed = false;
// First deployment can spend ten minutes in the native upload budget.
const deadlineMs = 12 * 60_000;
const timer = setTimeout(() => { expired = true; child.kill(); }, deadlineMs);
const send = async (request: object) => {
  child.stdin.write(JSON.stringify(request) + "\n");
  await child.stdin.flush();
};
type RpcMessage = {
  type?: string; id?: string; command?: string; success?: boolean;
  status?: string; error?: unknown; method?: string; message?: string;
  data?: { commands?: { name?: string; source?: string }[] };
};
const failure = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const consume = async (line: string) => {
  if (started && line.includes(selected.marker)) passed = true;
  let frame: RpcMessage | undefined;
  try { frame = JSON.parse(line); } catch {}
  if (frame?.type === "response" && frame.id === "admission") {
    if (frame.command !== "get_available_commands" || frame.success !== true ||
      !Array.isArray(frame.data?.commands) || !frame.data.commands.some(command => command.name === selected.command && command.source === "extension")) {
      throw new Error(`Acceptance extension command was not admitted: ${selected.command}`);
    }
    if (started) throw new Error("Duplicate smoke admission response");
    started = true;
    console.log("SMOKE_ADMITTED", name);
    await send({ id: "execution", type: "prompt", message: `/${selected.command}` });
  } else if (frame?.type === "response" && frame.id === "execution" && frame.success === false) {
    throw new Error(failure(frame.error) ?? "Native command failed");
  } else if (frame?.type === "extension_error") {
    throw new Error(failure(frame.error) ?? frame.message ?? "Extension error");
  } else if (frame?.type === "prompt_result" && frame.id === "execution") {
    if (frame.status !== "completed") throw new Error(failure(frame.error) ?? "Native smoke prompt did not complete");
  } else if (frame?.type === "agent_start" && name !== "cache") {
    throw new Error("Unexpected agent turn in a model-free acceptance");
  } else if (frame?.type === "extension_ui_request" &&
    (frame.method === "notify" || frame.method === "setWorkingMessage") && frame.message) {
    console.log(frame.message);
  } else if (!frame?.type && line) {
    console.log(line);
  }
};
try {
  await send({ id: "admission", type: "get_available_commands" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let index: number;
      while ((index = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, index).replace(/\r$/, "");
        buffered = buffered.slice(index + 1);
        await consume(line);
      }
    }
    buffered += decoder.decode();
    if (buffered) await consume(buffered);
  } finally { reader.releaseLock(); }
  const code = await child.exited;
  if (expired) throw new Error(`Native ${name} acceptance exceeded ${deadlineMs / 1000} seconds`);
  if (code !== 0 || !started || !passed) throw new Error(`Native ${name} acceptance failed (exit=${code}, admitted=${started}, passed=${passed})`);
  completed = true;
} finally {
  clearTimeout(timer);
  try { await child.stdin.end(); } catch {}
  if (child.exitCode === null) child.kill();
  await child.exited;
  const errors = await errorText; if (errors) console.error(errors);
  if (completed) await rm(directory, { recursive: true, force: true });
  else console.error(`Retained failed acceptance session: ${directory}`);
}
