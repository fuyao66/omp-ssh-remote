// No prompt, SSH connection, or provider request. Uses normal native plugin
// discovery against copied registry manifests and the actual installed packages.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPluginsDir } from "@oh-my-pi/pi-utils";

// Resolve under the original environment: pi-utils caches its directory resolver.
const registry = getPluginsDir();
const directory = await mkdtemp(join(tmpdir(), "omp-global-admission-"));
const home = join(directory, "home"), plugins = join(home, ".omp", "plugins");
let completed = false, keepDiagnostics = false;
try {
  await Promise.all([plugins, "project", "agent", "sessions", "config", "data", "cache", "state", "tmp", "mc-storage"].map(part => mkdir(part === plugins ? part : join(directory, part), { recursive: true })));
  for (const name of ["package.json", "omp-plugins.lock.json"]) {
    if (await Bun.file(join(registry, name)).exists()) await copyFile(join(registry, name), join(plugins, name));
  }
  await symlink(join(registry, "node_modules"), join(plugins, "node_modules"), "dir");
  await mkdir(join(directory, "config", "cortexkit"), { recursive: true });
  await writeFile(join(directory, "config", "cortexkit", "magic-context.jsonc"), JSON.stringify({
    enabled: true, transform_mode: "ts", compaction: { enabled: true }, fail_closed_blocking: true,
    system_prompt_injection: { enabled: true }, historian: { disable: true },
    dreamer: { disable: true, inject_docs: false }, embedding: { provider: "off" },
    shadow_embedding: { enabled: false }, smart_notes: { enabled: false },
    memory: { enabled: false, auto_promote: false, auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
    mural: { enabled: false }, auto_update: false,
  }));
  const config = join(directory, "config.json");
  await writeFile(config, JSON.stringify({ memory: { enabled: false }, autolearn: { enabled: false }, compaction: { enabled: false } }));
  // An allowlist prevents inherited provider secrets, storage overrides, profile
  // paths and MC test/migration switches from escaping this fresh installation.
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SHELL", "LANG", "LC_ALL", "TERM"]) if (Bun.env[name]) env[name] = Bun.env[name]!;
  Object.assign(env, { HOME: home, PI_CODING_AGENT_DIR: join(directory, "agent"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"),
    MAGIC_CONTEXT_STORAGE_DIR: join(directory, "mc-storage"), MAGIC_CONTEXT_LOG_PATH: join(directory, "mc.log"), MAGIC_CONTEXT_LOG_SYNC: "1",
    OPENAI_API_KEY: "unused-local-command-only" });
  const child = Bun.spawn([Bun.env.OMP_BINARY ?? "omp", "--mode", "rpc", "--no-ui", "--no-title", "--no-skills", "--no-rules", "--config", config,
    "--session-dir", join(directory, "sessions"), "--model", "openai/gpt-4o-mini"],
    { cwd: join(directory, "project"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  let expired = false, admitted = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, 60_000);
  const frames: any[] = [];
  try {
    child.stdin.write(JSON.stringify({ id: "admission", type: "get_available_commands" }) + "\n"); await child.stdin.flush();
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
    const consume = async (line: string) => {
      let frame: any; try { frame = JSON.parse(line); } catch { if (line.trim()) frames.push({ diagnostic: line }); return; }
      frames.push(frame);
      assert.notEqual(frame.type, "agent_start", "No-provider admission unexpectedly started an agent turn");
      assert.notEqual(frame.type, "extension_error", JSON.stringify(frame));
      if (frame.type !== "response" || frame.id !== "admission") return;
      assert(!admitted && frame.command === "get_available_commands" && frame.success === true, "Missing, failed or duplicate native admission response");
      const commands = frame.data?.commands; assert(Array.isArray(commands));
      for (const name of ["remote-connect", "remote-status", "remote-exit", "ctx-status"]) {
        assert(commands.some((command: any) => command.name === name && command.source === "extension"), `Normal global loader did not admit ${name}`);
      }
      admitted = true; await child.stdin.end();
    };
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }); let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); await consume(line); }
      }
      buffer += decoder.decode(); if (buffer) await consume(buffer);
    } finally { reader.releaseLock(); }
    assert(!expired, "Global admission exceeded its deadline");
    assert.equal(await child.exited, 0); assert(admitted, "Native global plugin admission did not complete");
  } finally {
    clearTimeout(timer); try { await child.stdin.end(); } catch {}
    if (child.exitCode === null) child.kill(); await child.exited;
    const errors = await stderr;
    await writeFile(join(directory, "stderr.log"), errors);
    await writeFile(join(directory, "rpc.json"), JSON.stringify(frames, null, 2));
    // Retain original diagnostics. Never suppress or bypass MC's active-process
    // migration refusal, even for this isolated database.
    assert(!/failed to load|extension[^\n]*(?:error|failed)|migration[^\n]*(?:blocked|refus|cannot)|cannot[^\n]*migrat/i.test(errors), "Native plugin startup reported an error or migration guard refusal; inspect retained private diagnostics");
    const mcLog = Bun.file(join(directory, "mc.log"));
    assert(await mcLog.exists(), "Expected production MC log is absent; admission is inconclusive");
    const mcDiagnostics = await mcLog.text();
    assert(!/storage fatal:|storage unavailable:|storage unavailable at|fail-closed blocking surface registered|cannot migrate the shared database|persistent storage failed/i.test(`${errors}\n${mcDiagnostics}`),
      "Production MC storage refused admission; preserve its shared-database guard and inspect retained diagnostics");
    if (/storage warning: continuing migration/i.test(mcDiagnostics)) {
      keepDiagnostics = true;
      console.warn("GLOBAL_ADMISSION_WARNING: MC continued after an inconclusive process probe; inspect retained diagnostics");
    }
  }
  completed = true;
  console.log("GLOBAL_PLUGIN_ADMISSION_PASS", JSON.stringify({ normalDiscovery: true, actualInstalledPackages: true, freshHomeAndStorage: true, promptsSent: 0, scope: "command registration and host admission only; not MC compaction or remote connection" }));
} finally {
  if (completed && !keepDiagnostics && Bun.env.SMOKE_KEEP_ARTIFACTS !== "1") await rm(directory, { recursive: true, force: true });
  else console.error(`Retained private admission diagnostics: ${directory}`);
}
