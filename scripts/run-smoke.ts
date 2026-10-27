// Admit and execute the helper in one RPC session; do not submit unknown commands.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const commands: Record<string, { command: string; marker: string }> = {
  cache: { command: "remote-cache-smoke", marker: "CACHE_SMOKE_PASS" },
  lifecycle: { command: "remote-lifecycle-smoke", marker: "LIFECYCLE_SMOKE_PASS" },
  capture: { command: "remote-capture-smoke", marker: "CAPTURE_SMOKE_PASS" },
  "rich-output": { command: "remote-rich-output-smoke", marker: "RICH_OUTPUT_SMOKE_PASS" },
};
const requested = process.argv[2] ?? "cache";
const admissionOnly = Bun.env.SMOKE_ADMISSION_ONLY === "1";
const name = requested === "cache-mc" ? "cache" : requested;
const mcCompat = name === "cache" && (requested === "cache-mc" || !!Bun.env.CACHE_SMOKE_MC_COMPAT)
  ? (Bun.env.CACHE_SMOKE_MC_COMPAT && Bun.env.CACHE_SMOKE_MC_COMPAT !== "1"
    ? resolve(Bun.env.CACHE_SMOKE_MC_COMPAT) : resolve(import.meta.dir, "../../omp-mc-compat/index.js"))
  : undefined;
const selected = Object.hasOwn(commands, name)
  ? { ...commands[name], ...(mcCompat ? { marker: "MC_CACHE_SMOKE_PASS" } : {}) } : undefined;
if (!selected) throw new Error("Usage: bun scripts/run-smoke.ts [cache|cache-mc|lifecycle|capture|rich-output]");
if (mcCompat && !await Bun.file(mcCompat).exists()) throw new Error(`Installed MC compat not found: ${mcCompat}`);
const bundle = resolve(import.meta.dir, `../packages/omp/dist/${name}-smoke.js`);
if (!await Bun.file(bundle).exists()) throw new Error(`Build the helper first: bun scripts/build-smoke.ts ${name}`);
const directory = await mkdtemp(join(tmpdir(), `omp-${name}-accept-`));
const config: string[] = [];
const childEnv: Record<string, string | undefined> = { ...Bun.env };
if (mcCompat) {
  const configHome = join(directory, "config");
  await Promise.all(["project", "agent", "tmp", "cache", "data", "mc-storage", "config"].map(part => mkdir(join(directory, part), { recursive: true })));
  // MC 0.49.20 reads $XDG_CONFIG_HOME/cortexkit/magic-context.jsonc.
  // Keep the real context transform/fence enabled, but disable all auxiliary
  // model consumers and embedding downloads. A fresh cwd prevents project
  // configuration from overriding this isolated user configuration.
  await mkdir(join(configHome, "cortexkit"), { recursive: true });
  await writeFile(join(configHome, "cortexkit", "magic-context.jsonc"), JSON.stringify({
    enabled: true,
    transform_mode: "ts",
    compaction: { enabled: true },
    fail_closed_blocking: true,
    system_prompt_injection: { enabled: true },
    historian: { disable: true },
    dreamer: { disable: true, inject_docs: false },
    embedding: { provider: "off" },
    shadow_embedding: { enabled: false },
    smart_notes: { enabled: false },
    memory: {
      enabled: false, auto_promote: false,
      auto_search: { enabled: false },
      git_commit_indexing: { enabled: false },
    },
    mural: { enabled: false },
    auto_update: false,
  }, null, 2));
  Object.assign(childEnv, {
    CACHE_SMOKE_MC_COMPAT: mcCompat,
    CACHE_SMOKE_ISOLATION_DIR: directory,
    MAGIC_CONTEXT_STORAGE_DIR: join(directory, "mc-storage"),
    MAGIC_CONTEXT_LOG_PATH: join(directory, "mc.log"),
    MAGIC_CONTEXT_LOG_SYNC: "1",
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    TMPDIR: join(directory, "tmp"),
  });
  // Do not select MC's unit-test mode: it requires a synthetic provider factory
  // and would not exercise the installed production context/fence.
  delete childEnv.MAGIC_CONTEXT_TEST_DATA_DIR;
  delete childEnv.OMP_PROFILE;
  delete childEnv.PI_PROFILE;
  console.log(`MC_SMOKE_ISOLATION ${directory} compat=${mcCompat}`);
}
if (name === "capture") {
  const file = join(directory, "config.yml");
  await writeFile(file, "bash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 300\n");
  config.push("--config", file);
}
// MC must pass through OMP's extension loader for its legacy package aliases.
// Keep MC first so remote's final context also faces its real dispatch fence.
const extensions = mcCompat ? ["-e", mcCompat, "-e", bundle] : ["-e", bundle];
const child = Bun.spawn([Bun.env.OMP_BINARY ?? "omp", "--no-extensions", "--no-skills", "--no-rules", "--no-title", ...config, "--session-dir", join(directory, "sessions"), ...extensions, "--approval-mode", "yolo", "--mode", "rpc"], { cwd: mcCompat ? join(directory, "project") : "/tmp", env: childEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
    if (admissionOnly) {
      passed = true;
      console.log("SMOKE_ADMISSION_PASS", name, "(no prompt, provider request or SSH connection)");
      await child.stdin.end();
    } else {
      await send({ id: "execution", type: "prompt", message: `/${selected.command}` });
    }
  } else if (frame?.type === "response" && frame.id === "execution" && frame.success === false) {
    throw new Error(failure(frame.error) ?? "Native command failed");
  } else if (frame?.type === "extension_error") {
    throw new Error(failure(frame.error) ?? frame.message ?? "Extension error");
  } else if (frame?.type === "prompt_result" && frame.id === "execution") {
    if (frame.status !== "completed") throw new Error(failure(frame.error) ?? "Native smoke prompt did not complete");
  } else if (frame?.type === "agent_start" && (admissionOnly || name !== "cache")) {
    throw new Error("Unexpected agent turn in admission-only or model-free acceptance");
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
  if (completed && Bun.env.SMOKE_KEEP_ARTIFACTS !== "1") await rm(directory, { recursive: true, force: true });
  else console.error(`Retained ${completed ? "successful" : "failed"} acceptance session: ${directory}`);
}
