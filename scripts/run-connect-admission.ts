// Build: bun scripts/run-connect-admission.ts --build
// Run: REMOTE_CONNECT_ARGS='host /authorized/scratch' bun scripts/run-connect-admission.ts
// Offline worker-setting refusal: bun scripts/run-connect-admission.ts --refusal-only
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { formatTitleUserMessage } from "@oh-my-pi/pi-coding-agent/tiny/message-preproc";
const root = resolve(import.meta.dir, ".."), bundle = join(root, ".cache/smoke/connect-admission-smoke.js");
if (process.argv.includes("--build")) {
  const result = await Bun.build({ entrypoints: [join(root, "scripts/smoke-connect-admission.ts")], outdir: join(root, ".cache/smoke"), naming: "connect-admission-smoke.js",
    target: "bun", minify: true, external: ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-agent-core", "@oh-my-pi/pi-natives"],
    plugins: [{ name: "release-extension-location", setup(build) {
      build.onResolve({ filter: /^\.\.\/packages\/omp\/dist\/extension\.js$/ }, () => ({ path: "../../packages/omp/dist/extension.js", external: true }));
    } }] });
  if (!result.success) throw new AggregateError(result.logs, "Admission bundle failed"); console.log(`Built ${bundle}`); process.exit(0);
}
const refusalOnly = process.argv.includes("--refusal-only");
assert(await Bun.file(bundle).exists(), "Build first with --build");
if (!refusalOnly) assert(Bun.env.REMOTE_CONNECT_ARGS, "Authorized scratch workspace required");
const directory = await mkdtemp(join(tmpdir(), "omp-connect-admission-")), run = crypto.randomUUID().replaceAll("-", ""), marker = join(directory, "unsafe-local-write");
const fixtureId = `admit_${run}`, label = formatTitleUserMessage(`ADMISSION_TURN=${fixtureId}:initial`);
const promptRoot = join(root, "node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system");
const labelPrompt = (await readFile(join(promptRoot, "task-label.md"), "utf8")).trim(), markerPrompt = (await readFile(join(promptRoot, "title-marker-instruction.md"), "utf8")).trim();
const observations: any[] = [], failures: string[] = [], shutdown = new Set<string>();
const initialEntered = Promise.withResolvers<void>(), initialRelease = Promise.withResolvers<void>(), wakeSeen = Promise.withResolvers<void>();
let omp: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined, remoteHost: string | undefined, requests = 0, completed = false, revokedDenied = false;
let initialSeen = false;
const sshIdentities = new Map<number, string>();
const captureSsh = async () => {
  const rows: { pid: number; ppid: number; start: string }[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { const fields = (await readFile(`/proc/${name}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
      rows.push({ pid: Number(name), ppid: Number(fields[1]), start: fields[19] }); } catch { /* Exited during snapshot. */ }
  }
  const owned = new Set(omp ? [omp.pid] : []);
  while (true) { const added = rows.filter(row => owned.has(row.ppid) && !owned.has(row.pid)); if (!added.length) break; for (const row of added) owned.add(row.pid); }
  for (const row of rows) if (owned.has(row.pid) && basename(await readlink(`/proc/${row.pid}/exe`).catch(() => "")) === "ssh") sshIdentities.set(row.pid, row.start);
};
const assertSshGone = async () => {
  for (const [pid, start] of sshIdentities) {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    assert(!stat || stat.split(") ").at(-1)!.split(" ")[19] !== start, `Owned SSH PID/start ${pid}:${start} survives`);
  }
};
const absent = async () => assert(!(await Bun.file(marker).exists()), "Revoked child wrote into the local workspace");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 180, async fetch(request) {
  try {
    assert.equal(request.method, "POST"); const route = new URL(request.url).pathname, body: any = await request.json();
    if (route === "/observe") {
      assert.equal(body.pid, omp!.pid);
      assert(body.isMainThread === true && body.threadId === 0 && body.instanceKey.startsWith("main:"));
      assert(body.id === fixtureId && ["local", "remote"].includes(body.mode));
      if (body.mode === "remote") assert(observations.some(row => row.id === body.id && row.mode === "local" && row.instanceKey !== body.instanceKey));
      observations.push(body); return Response.json({ ok: true });
    }
    if (route === "/await-initial") { await initialEntered.promise; return Response.json({ observations }); }
    if (route === "/release-initial") { initialRelease.resolve(); return Response.json({ ok: true }); }
    if (route === "/await-wake") { await wakeSeen.promise; return Response.json({ ok: true }); }
    if (route === "/shutdown") { shutdown.add(`${body.id}:${body.instanceKey}`); return Response.json({ ok: true }); }
    if (route === "/assert-no-shutdown") { assert(!shutdown.has(`${body.id}:${body.instanceKey}`)); return Response.json({ ok: true }); }
    if (route === "/assert-shutdown") { assert(shutdown.has(`${body.id}:${body.instanceKey}`)); return Response.json({ ok: true }); }
    if (route === "/remote-host") { assert(typeof body.hostname === "string" && body.hostname.length > 0); remoteHost = body.hostname; return Response.json({ ok: true }); }
    if (route === "/before-exit") { await captureSsh(); assert(sshIdentities.size >= 2, "Owner and revived child need attributable live SSH transports"); return Response.json({ ok: true }); }
    if (route === "/assert-marker-absent") { assert(revokedDenied); await absent(); await assertSshGone(); return Response.json({ ok: true }); }
    assert.equal(route, "/v1/chat/completions"); assert.equal(body.model, "probe"); requests++;
    const text = (message: any): string => typeof message?.content === "string" ? message.content : Array.isArray(message?.content)
      ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "";
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "admission", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const answer = (content: string) => chunk({ role: "assistant", content }, null) + chunk({}, "stop");
    const call = (name: string, input: object) => {
      assert(body.tools.some((tool: any) => tool.function.name === name));
      return chunk({ role: "assistant", tool_calls: [{ index: 0, id: `probe_${requests}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, null) + chunk({}, "tool_calls");
    };
    const respond = (stream: string) => new Response(stream + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    if (!Array.isArray(body.tools) || !body.tools.length) {
      const system = body.messages.filter((message: any) => ["system", "developer"].includes(message.role)).map(text).join("\n\n");
      assert(system.includes(labelPrompt) && system.includes(markerPrompt)); assert.equal(text(body.messages.findLast((message: any) => message.role === "user")), label);
      return respond(answer("<title>Admission probe</title>"));
    }
    const messages = body.messages.map(text).join("\n"), turn = [...messages.matchAll(/ADMISSION_TURN=([A-Za-z0-9_]+):(initial|revived|revoked)/g)].at(-1);
    assert(turn && turn[1] === fixtureId, "Unapproved model consumer"); const [, id, phase] = turn;
    if (messages.lastIndexOf(`ADMISSION_WAKE=${id}`) > messages.lastIndexOf(`ADMISSION_TURN=${id}:`)) {
      assert.equal(phase, "initial"); assert(initialSeen); wakeSeen.resolve(); return respond(answer(`WAKE_ACK_${run}`));
    }
    const last = body.messages.at(-1), previous = body.messages.findLast((message: any) => message.role === "assistant" && message.tool_calls)?.tool_calls?.at(-1)?.function?.name;
    if (phase === "revoked") {
      if (last.role !== "tool") return respond(call("remote_workspace_status", {}));
      if (previous === "remote_workspace_status") { assert(text(last).includes("unavailable")); return respond(call("bash", { command: `printf unsafe > '${marker}'` })); }
      assert.equal(previous, "bash"); assert(/unavailable|disconnect|closed|revoked/i.test(text(last))); revokedDenied = true; return respond(answer(`REVOKED_ACK_${run}`));
    }
    const observer = observations.filter(row => row.id === id).at(-1); assert(observer);
    if (last.role === "tool") {
      assert.equal(previous, "bash"); const output = text(last);
      assert(output.includes(`HOST=${phase === "initial" ? hostname() : remoteHost}`)); assert(output.includes(`SESSION=${observer.sessionId}`));
      assert(output.includes(`PWD=${phase === "initial" ? directory : observer.remoteCwd}`));
      return respond(answer(`${phase === "initial" ? "LOCAL_ACK" : "REMOTE_ACK"}_${run}`));
    }
    if (phase === "initial") { initialSeen = true; initialEntered.resolve(); await initialRelease.promise; }
    else assert(observer.mode === "remote" && remoteHost);
    return respond(call("bash", { command: "printf 'HOST='; hostname; printf 'PWD=%s\\nSESSION=%s\\n' \"$PWD\" \"$PI_SESSION_ID\"" }));
  } catch (error) {
    failures.push(String(error)); console.error("ADMISSION_FIXTURE_ERROR", error); initialEntered.resolve(); initialRelease.resolve(); wakeSeen.resolve();
    if (omp?.exitCode === null) omp.kill(); return new Response(String(error), { status: 500 });
  }
} });
try {
  const runProbe = async (workerThreads: 0 | 1) => {
    const refusal = workerThreads > 0;
    const command = refusal ? "connect-worker-setting-refusal-smoke" : "connect-admission-smoke";
    const passMarker = refusal ? "CONNECT_WORKER_SETTING_REFUSAL_SMOKE_PASS" : "CONNECT_ADMISSION_SMOKE_PASS";
    const config = join(directory, `config-${workerThreads}.json`), model = "connect-admission/probe";
    await writeFile(config, JSON.stringify({ async: { enabled: false, widgets: false }, task: { batch: true, maxConcurrency: 1, workerThreads, structured: false,
      perCallModel: "on", perCallModelAllow: [model], agentIdleTtlMs: 0, completionProbe: false, softRequestBudget: 0, prewalk: false },
      modelRoles: { default: model, tiny: model, smol: model, commit: model }, retry: { modelFallback: false }, advisor: { enabled: false }, memory: { enabled: false }, autolearn: { enabled: false }, compaction: { enabled: false } }));
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(Bun.env)) if (["PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK", "SSH_AGENT_PID"].includes(name) || /^(REMOTE_|OMP_REMOTE_)/.test(name)) env[name] = value;
    if (refusal) delete env.REMOTE_CONNECT_ARGS;
    Object.assign(env, { OMP_ACCEPTANCE_RUN_ID: run, CONNECT_ADMISSION_ENDPOINT: `http://127.0.0.1:${server.port}`, PI_CODING_AGENT_DIR: join(directory, `agent-${workerThreads}`), OPENAI_API_KEY: "unused-local-command-only" });
    const child = omp = Bun.spawn([Bun.env.OMP_BINARY ?? "omp", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--config", config, "--session-dir", join(directory, `sessions-${workerThreads}`),
      "-e", bundle, "--model", "openai/gpt-4o-mini", "--approval-mode", "yolo", "--mode", "rpc"], { cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const errors = new Response(child.stderr).text(), timer = setTimeout(() => { failures.push(`${command} timed out`); child.kill(); }, refusal ? 60_000 : 8 * 60_000);
    let admitted = false, passed = false;
    try {
      const send = async (frame: object) => { child.stdin.write(JSON.stringify(frame) + "\n"); await child.stdin.flush(); };
      await send({ id: "admission", type: "get_available_commands" });
      const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
      const consume = async (line: string) => {
        if (line.includes(passMarker)) passed = true;
        let frame: any; try { frame = JSON.parse(line); } catch { if (line) console.log(line); return; }
        if (frame.type === "response" && frame.id === "admission") {
          assert(!admitted && frame.success && frame.data.commands.some((entry: any) => entry.name === command && entry.source === "extension"));
          admitted = true; await send({ id: "execution", type: "prompt", message: `/${command}` });
        }
        if (frame.type === "extension_error" || (frame.id === "execution" && frame.success === false)) throw new Error(JSON.stringify(frame));
        if (refusal) assert.notEqual(frame.type, "agent_start", "The worker-setting refusal must not start an agent turn");
        if (frame.type === "extension_ui_request" && frame.message) console.log(frame.message);
      };
      try {
        while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true });
          let newline: number; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); await consume(line); } }
        buffer += decoder.decode(); if (buffer) await consume(buffer);
      } finally { reader.releaseLock(); }
      assert.equal(await child.exited, 0); assert(admitted && passed, `${command} did not complete`);
      assert.equal(failures.length, 0, failures.join("\n"));
    } finally {
      clearTimeout(timer); if (!refusal) initialRelease.resolve();
      try { await child.stdin.end(); } catch {}
      if (child.exitCode === null) child.kill();
      await child.exited; await writeFile(join(directory, `${command}-stderr.log`), await errors);
    }
  };
  await runProbe(1);
  assert.equal(requests, 0, "The worker-setting refusal must not contact a provider");
  assert.equal(observations.length, 0, "The worker-setting refusal must not create descendants");
  if (!refusalOnly) {
    await runProbe(0);
    assert(initialSeen && revokedDenied);
    await absent(); await assertSshGone();
    console.log("CONNECT_ADMISSION_ACCEPTANCE_PASS", JSON.stringify({ workerSettingRefused: true, nativeTasks: 1, connectParkedChild: true, sameThreadRemoteRevival: true, ownerExitFailClosed: true, reapedSshIdentities: sshIdentities.size, providerRequests: requests }));
  }
  completed = true;
} finally {
  server.stop(true); await writeFile(join(directory, "evidence.json"), JSON.stringify({ observations, failures, requests, revokedDenied, sshIdentities: [...sshIdentities] }, null, 2));
  if (completed && Bun.env.SMOKE_KEEP_ARTIFACTS !== "1") await rm(directory, { recursive: true, force: true }); else console.error(`Retained private acceptance artifacts: ${directory}`);
}
