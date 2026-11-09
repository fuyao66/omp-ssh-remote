// Authorized hosts only. Requires REMOTE_CONNECT_ARGS and TASK_ACCEPTANCE_AUDIT_SSH
// (a JSON argv array ending in the SSH destination). Never kills remote processes.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { formatTitleUserMessage } from "@oh-my-pi/pi-coding-agent/tiny/message-preproc";

type Proc = { pid: number; ppid: number; start: string; state: string; stdinOpen: boolean; marker: boolean; crash: boolean; ssh: boolean; runtime: boolean; runtimeMode: "companion" | "daemon-broker" | "js-eval" | "unknown" | "none"; threads: number };
const bundle = resolve(import.meta.dir, "../.cache/smoke/task-smoke.js");
assert(await Bun.file(bundle).exists(), "Build helper first: bun scripts/build-smoke.ts task");
assert(Bun.env.REMOTE_CONNECT_ARGS, "REMOTE_CONNECT_ARGS is required");
const ssh: string[] = JSON.parse(Bun.env.TASK_ACCEPTANCE_AUDIT_SSH ?? "null");
assert(Array.isArray(ssh) && ssh.length >= 2 && basename(ssh[0]) === "ssh" && ssh.every(value => typeof value === "string" && !value.includes("\0")), "TASK_ACCEPTANCE_AUDIT_SSH must be an explicit SSH argv array ending in the authorized destination");
const rounds = Number(Bun.env.TASK_ACCEPTANCE_ROUNDS ?? "1");
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 2, "TASK_ACCEPTANCE_ROUNDS must be 1 or 2; every round includes a real persisted-intent process restart");
const directory = await mkdtemp(join(tmpdir(), "omp-task-accept-"));
const observations: any[] = [], checkpoints: any[] = [], failures: string[] = [];
const promptRoot = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system");
const labelSystemPrompt = (await readFile(join(promptRoot, "task-label.md"), "utf8")).trim();
const labelMarkerPrompt = (await readFile(join(promptRoot, "title-marker-instruction.md"), "utf8")).trim();
const remoteScript = `import os,sys,json
marker=sys.argv[1]; rows=[]; audit=set(); current=os.getpid()
while current>1 and current not in audit:
 audit.add(current)
 try: current=int(open('/proc/'+str(current)+'/stat').read().rsplit(')',1)[1].split()[1])
 except (OSError,ValueError,IndexError): break
for name in os.listdir('/proc'):
 if not name.isdigit() or int(name) in audit: continue
 try:
  base='/proc/'+name
  if os.stat(base).st_uid!=os.getuid(): continue
  stat=open(base+'/stat').read().rsplit(')',1)[1].split()
  cmd=open(base+'/cmdline','rb').read().decode(errors='replace')
  try: env=open(base+'/environ','rb').read().decode(errors='replace')
  except OSError: env=''
  try: exe=os.readlink(base+'/exe')
  except OSError: exe=''
  args=[arg for arg in cmd.split('\\0') if arg]; runtime='/omp-ssh-remote/' in exe
  mode='none'
  if runtime:
   if '__omp_worker_daemon_broker' in args: mode='daemon-broker'
   elif '__omp_worker_js_eval_process' in args: mode='js-eval'
   elif len(args)==1: mode='companion'
   else: mode='unknown'
  rows.append(dict(pid=int(name),ppid=int(stat[1]),start=stat[19],state=stat[0],stdinOpen=os.path.lexists(base+'/fd/0'),marker=marker in cmd or ('OMP_ACCEPTANCE_RUN_ID='+marker+'\\0') in env,crash=('TASK_CRASH_'+marker) in cmd,ssh=False,runtime=runtime,runtimeMode=mode,threads=len(os.listdir(base+'/task'))))
 except (OSError,ValueError,IndexError): pass
print(json.dumps(rows))`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const key = (row: Proc) => `${row.pid}:${row.start}`;
async function localProcesses(marker: string): Promise<Proc[]> {
  const rows: Proc[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const base = `/proc/${name}`, stat = (await readFile(`${base}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
      const cmd = await readFile(`${base}/cmdline`, "utf8");
      const environment = await readFile(`${base}/environ`, "utf8").catch(() => "");
      rows.push({ pid: Number(name), ppid: Number(stat[1]), start: stat[19], state: stat[0], stdinOpen: await readlink(`${base}/fd/0`).then(() => true, () => false), marker: cmd.includes(marker) || environment.includes(`OMP_ACCEPTANCE_RUN_ID=${marker}\0`), crash: cmd.includes(`TASK_CRASH_${marker}`), ssh: basename(await readlink(`${base}/exe`).catch(() => "")) === "ssh", runtime: false, runtimeMode: "none", threads: (await readdir(`${base}/task`)).length });
    } catch { /* Processes may exit between /proc reads. */ }
  }
  return rows;
}
async function remoteProcesses(marker: string): Promise<Proc[]> {
  const child = Bun.spawn([...ssh, `python3 -c ${quote(remoteScript)} ${quote(marker)}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `Independent remote process accounting failed (exit=${code}, diagnosticBytes=${err.length})`);
    return JSON.parse(out);
  } finally { clearTimeout(timer); }
}
let completed = false, limitedRounds = 0;
try {
  for (let round = 0; round < rounds; round++) {
    const run = crypto.randomUUID().replaceAll("-", ""), roundDir = join(directory, String(round));
    await mkdir(roundDir);
    const seenLocal = new Set<string>(), seenRemote = new Set<string>();
    const baseline = await remoteProcesses(run), baselineKeys = new Set(baseline.map(key));
    let omp: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    const snapshot = async (phase: string, final = false) => {
      // Finish the independent audit SSH before scanning local processes, so
      // the observer's own marker-bearing transport is not counted as a leak.
      const remote = await remoteProcesses(run), local = await localProcesses(run);
      const select = (rows: Proc[], roots: Set<number>, seen: Set<string>) => {
        let changed = true;
        while (changed) { changed = false; for (const row of rows) if ((roots.has(row.ppid) || row.marker) && !roots.has(row.pid)) { roots.add(row.pid); changed = true; } }
        const owned = rows.filter(row => roots.has(row.pid) || seen.has(key(row)));
        for (const row of owned) seen.add(key(row));
        return owned;
      };
      const localOwned = select(local, new Set(omp ? [omp.pid] : []), seenLocal);
      const remoteRoots = new Set(remote.filter(row => (row.runtime && !baselineKeys.has(key(row))) || row.marker).map(row => row.pid));
      const remoteOwned = select(remote, remoteRoots, seenRemote);
      const entry = { round, phase, local: localOwned, remote: remoteOwned };
      checkpoints.push(entry); await writeFile(join(directory, "process-accounting.json"), JSON.stringify(checkpoints, null, 2));
      if (final) assert(localOwned.length === 0 && remoteOwned.length === 0, `Surviving test-owned process identities (local=${localOwned.length}, remote=${remoteOwned.length}); no remote process was killed`);
      return entry;
    };
    const gate = Promise.withResolvers<void>(), interruptEntered = Promise.withResolvers<void>(), interruptRelease = Promise.withResolvers<void>();
    const crashEntered = Promise.withResolvers<void>(), crashRelease = Promise.withResolvers<void>();
    let crashedRemote = new Set<string>(), crashSsh = new Set<string>();
    let crashCompanion: string | undefined;
    let requests = 0, labelRequests = 0, admitted = false, passed = false, revokedToolDenied = false;
    let roundLimited = false;
    let cleanupEvidence: { remoteCleanup: boolean; sshStdinClosed: boolean; localReaped: boolean; unreapedSsh: Proc[] } | undefined;
    let exitedRemote = new Set<string>();
    const localMarker = join(roundDir, `revoked_${run}`);
    const initial = new Set<string>();
    const fixtureIds = Array.from({ length: 9 }, (_, index) => `accept_${run}_${index}`);
    const fixturePhases = ["initial", "revived", "interrupt", "after-interrupt", "crash-service", "revoked"];
    const allowedLabels = new Set(fixtureIds.map(id => formatTitleUserMessage(`ACCEPTANCE_TURN=${id}:initial`)));
    const workerStops = new Map<string, { id: string; threadId: number; release: (value: { stop: boolean }) => void }>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 180, async fetch(request) {
      try {
        assert.equal(request.method, "POST");
        const route = new URL(request.url).pathname, body: any = await request.json();
        if (route === "/worker-control-failed") throw new Error(`Native worker stop control failed: ${body.error}`);
        if (route === "/await-worker-stop") {
          const observer = observations.slice().reverse().find(row => row.instanceKey === body.instanceKey && row.id === body.id);
          assert(observer && !observer.isMainThread && observer.threadId === body.threadId && body.threadId > 0, "Stop listener is not the observed actual worker session");
          assert(!workerStops.has(body.instanceKey), "Duplicate worker stop listener");
          server.timeout(request, 0);
          const wait = Promise.withResolvers<{ stop: boolean }>();
          workerStops.set(body.instanceKey, { id: body.id, threadId: body.threadId, release: wait.resolve });
          return Response.json({ ...body, ...await wait.promise });
        }
        if (route === "/force-worker-stop") {
          const control = workerStops.get(body.instanceKey);
          assert(control && control.id === body.id && crashCompanion && crashedRemote.has(crashCompanion), "Worker stop was not armed for the correlated crash-service owner");
          workerStops.delete(body.instanceKey);
          checkpoints.push({ round, phase: "worker-stop-requested", id: body.id, instanceKey: body.instanceKey, threadId: control.threadId });
          control.release({ stop: true }); return Response.json({ ok: true });
        }
        if (route === "/save-restart") {
          assert(typeof body.sessionFile === "string" && resolve(body.sessionFile).startsWith(`${roundDir}/`), "Restart snapshot must be a test-owned session");
          await copyFile(body.sessionFile, join(roundDir, "restart-session.jsonl"));
          return Response.json({ ok: true });
        }
        if (route === "/observe") {
          assert.equal(body.pid, omp!.pid, "Child did not execute in the native OMP process");
          assert(Number.isInteger(body.threadId) && body.threadId >= 0, "Missing actual node:worker_threads execution-thread id");
          assert.equal(body.isMainThread, body.threadId === 0, "Node worker boolean disagrees with its numeric execution-thread id");
          assert.equal(body.nativeThread === "main", body.threadId === 0, `Native home disagrees with actual execution thread: ${JSON.stringify({ nativeThread: body.nativeThread, threadId: body.threadId, nodeIsMainThread: body.isMainThread })}`);
          assert(body.instanceKey.startsWith(`${body.nativeThread}:`));
          assert.equal(body.status.mode, "remote", "Native child failed to inherit remote workspace");
          observations.push({ ...body, nodeIsMainThread: body.isMainThread, isMainThread: body.threadId === 0, round }); return Response.json({ ok: true });
        }
        if (route === "/checkpoint") {
          const accounting = await snapshot(body.phase);
          let forceWorkerCleanup = false;
          if (body.phase === "worker-terminated") {
            const deadline = Date.now() + 5000;
            let current = accounting;
            while (true) {
              const goneSsh = [...crashSsh].filter(identity => !current.local.some(row => key(row) === identity));
              const closedSsh = [...crashSsh].filter(identity => {
                const row = current.local.find(candidate => key(candidate) === identity);
                return !row || (row.state === "Z" && !row.stdinOpen);
              });
              const companionGone = !!crashCompanion && !current.remote.some(row => key(row) === crashCompanion);
              const remoteCleanup = companionGone && crashedRemote.size > 0 && !current.remote.some(row => crashedRemote.has(key(row)));
              const sshStdinClosed = closedSsh.length === 1, localReaped = goneSsh.length === 1;
              const unreapedSsh = current.local.filter(row => crashSsh.has(key(row)) && row.state === "Z" && !row.stdinOpen);
              cleanupEvidence = { remoteCleanup, sshStdinClosed, localReaped, unreapedSsh };
              forceWorkerCleanup = remoteCleanup && localReaped;
              if (remoteCleanup && sshStdinClosed) {
                if (!localReaped) {
                  assert.equal(unreapedSsh.length, 1, "Only a measured closed-fd SSH zombie permits limited continuation");
                  roundLimited = true;
                  console.log("TASK_NATIVE_REAPING_LIMITATION", JSON.stringify(cleanupEvidence));
                }
                break;
              }
              assert(Date.now() < deadline, "Abrupt worker exit left an open SSH transport or live companion/nonpersistent service");
              const retry = Promise.withResolvers<void>(); setTimeout(retry.resolve, 100); await retry.promise;
              current = await snapshot("worker-termination-drain");
            }
            crashRelease.resolve();
          }
          if (body.phase === "owner-exited") exitedRemote = new Set(accounting.remote.map(key));
          const noNewRemoteWorkers = accounting.remote.every(row => exitedRemote.has(key(row)));
          const localMarkerAbsent = !await Bun.file(localMarker).exists();
          if (body.phase === "revoked-turn") assert(revokedToolDenied && localMarkerAbsent && noNewRemoteWorkers, "Revoked child wrote locally or spawned a new remote worker");
          return Response.json({ observations: observations.filter(row => row.round === round), requests, revokedToolDenied, localMarkerAbsent, noNewRemoteWorkers, forceWorkerCleanup, ...cleanupEvidence });
        }
        if (route === "/await-interrupt") { await interruptEntered.promise; return Response.json({ ok: true }); }
        if (route === "/release-interrupt") { interruptRelease.resolve(); return Response.json({ ok: true }); }
        if (route === "/await-crash-service") {
          await crashEntered.promise;
          const before = await snapshot("before-worker-termination");
          const marked = before.remote.filter(row => row.crash); assert(marked.length > 0, "The unique remote crash-service process never became live");
          const observer = observations.slice().reverse().find(row => row.round === round && row.id === body.id);
          assert(observer && !observer.isMainThread, "Crash service has no actual worker-thread observer");
          const companion = before.remote.find(row => key(row) === `${observer.companion.pid}:${observer.companion.start}`);
          assert(companion?.runtimeMode === "companion", "ReadTool's exact remote PID/start-time is not a live companion-mode process");
          crashCompanion = key(companion);
          const roots = new Set<number>([companion.pid]);
          const ancestry: string[][] = [];
          for (const row of marked) {
            const chain: string[] = [];
            let ancestor: Proc | undefined = row;
            const visited = new Set<number>();
            while (ancestor && !visited.has(ancestor.pid)) {
              visited.add(ancestor.pid); chain.push(key(ancestor));
              if (ancestor.runtimeMode === "companion") {
                assert.equal(key(ancestor), key(companion), "Marked service belongs to a different companion");
                break;
              }
              if (ancestor.runtime) {
                assert(["daemon-broker", "js-eval"].includes(ancestor.runtimeMode), "Unrecognized runtime re-entry mode in service ancestry");
                roots.add(ancestor.pid);
              }
              ancestor = before.remote.find(candidate => candidate.pid === ancestor!.ppid);
            }
            assert(chain.some(identity => before.remote.some(candidate => key(candidate) === identity && ["daemon-broker", "companion"].includes(candidate.runtimeMode))), "Marked service has no separately identified native launcher/companion");
            ancestry.push(chain); roots.add(row.pid);
          }
          checkpoints.push({ round, phase: "crash-owner-correlation", companion: key(companion), ancestry });
          let changed = true;
          while (changed) { changed = false; for (const row of before.remote) if (roots.has(row.ppid) && !roots.has(row.pid)) { roots.add(row.pid); changed = true; } }
          crashedRemote = new Set(before.remote.filter(row => roots.has(row.pid)).map(key));
          assert(crashedRemote.has(crashCompanion), "Companion identity was omitted from the forced-death accounting set");
          crashSsh = new Set(before.local.filter(row => row.ssh).map(key)); assert(crashSsh.size > 0, "No local test-owned SSH transport observed");
          return Response.json({ ok: true, instanceKey: observer.instanceKey });
        }
        assert.equal(route, "/v1/chat/completions", "Unexpected provider endpoint");
        assert.equal(body.model, "probe"); requests++;
        const messageText = (message: any): string => typeof message?.content === "string" ? message.content
          : Array.isArray(message?.content) ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "";
        const latestUser = body.messages.findLast((message: any) => message.role === "user");
        const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "acceptance", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        // Native normalization may shorten or remove turn-marker text. Match
        // its pure input formatter against only our finite fixture assignments,
        // and require the installed native task-label prompts independently.
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          const system = body.messages.filter((message: any) => ["system", "developer"].includes(message.role)).map(messageText).join("\n\n");
          assert(system.includes(labelSystemPrompt) && system.includes(labelMarkerPrompt), "Unexpected no-tools model consumer");
          assert(allowedLabels.has(messageText(latestUser)), "Tiny label input is not an expected normalized fixture assignment");
          labelRequests++;
          return new Response(chunk({ role: "assistant", content: "<title>Remote task probe</title>" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } });
        }
        // Workspace notices are native user messages after the assignment.
        // Match the most recent explicit fixture turn, not merely the last user.
        const taskUser = body.messages.slice().reverse().find((message: any) => message.role === "user" && /ACCEPTANCE_TURN=/.test(messageText(message)));
        const turn = messageText(taskUser).match(/ACCEPTANCE_TURN=([A-Za-z0-9_]+):([a-z-]+)/);
        assert(turn && fixtureIds.includes(turn[1]) && fixturePhases.includes(turn[2]), "Unexpected model consumer: only explicit deterministic task turns are authorized");
        const [, id, phase] = turn;
        const last = body.messages.at(-1);
        const toolCall = (name: string, input: object) => chunk({ role: "assistant", tool_calls: [{ index: 0, id: `probe_${requests}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, null) + chunk({}, "tool_calls");
        let stream: string;
        if (phase === "crash-service") {
          if (last.role !== "tool") {
            const marker = `TASK_CRASH_${run}`;
            stream = toolCall("bash", { name: `accept_crash_${run}`, command: `printf '${marker}\\n'; exec python3 -c 'import time; time.sleep(600)' ${marker}`, pty: false, ready: { log: marker, timeout: 10 } });
          } else {
            crashEntered.resolve(); await crashRelease.promise;
            stream = chunk({ role: "assistant", content: "CRASH_SERVICE_OBSERVED" }, null) + chunk({}, "stop");
          }
        } else if (phase === "revoked") {
          const previous = body.messages.findLast((message: any) => message.role === "assistant" && message.tool_calls)?.tool_calls?.at(-1)?.function?.name;
          if (last.role !== "tool") {
            assert(body.tools.some((tool: any) => tool.function.name === "remote_workspace_status"), "Child does not expose the native remote status tool");
            stream = toolCall("remote_workspace_status", {});
          } else if (previous === "remote_workspace_status") {
            assert(JSON.stringify(last.content).includes("unavailable"), "Revoked child did not report unavailable workspace status");
            stream = toolCall("bash", { command: `printf unsafe > ${quote(localMarker)}` });
          } else {
            assert.equal(previous, "bash");
            assert(/unavailable|disconnect|closed|revoked/i.test(JSON.stringify(last.content)), "Revoked child did not reject its workspace command");
            revokedToolDenied = true;
            stream = chunk({ role: "assistant", content: "REVOKED_WORKSPACE_REJECTED" }, null) + chunk({}, "stop");
          }
        } else if (last.role === "tool") {
          const output = JSON.stringify(last.content);
          assert(output.includes(`TASK_PROBE_${run}`), "Child bash did not return this run's marker");
          const observer = observations.slice().reverse().find(row => row.round === round && row.id === id);
          assert(observer, "Missing native child thread observation");
          assert(typeof observer.status.remoteCwd === "string" && output.includes(observer.status.remoteCwd), "Task bash did not execute in the inherited remote cwd");
          assert(output.includes(observer.sessionId), "Task bash did not retain the native child session identity");
          stream = chunk({ role: "assistant", content: `ACCEPTED ${id}:${phase}` }, null) + chunk({}, "stop");
        } else {
          if (phase === "initial") { initial.add(id); if (initial.size === 9) gate.resolve(); await gate.promise; }
          if (phase === "interrupt") { interruptEntered.resolve(); await interruptRelease.promise; }
          stream = toolCall("bash", { command: `printf 'TASK_PROBE_${run}\\n'; pwd; printf 'SESSION=%s\\n' "$PI_SESSION_ID"` });
        }
        return new Response(stream + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
      } catch (error) {
        console.error("TASK_ACCEPTANCE_FIXTURE_ERROR", error); failures.push(String(error));
        gate.resolve(); interruptRelease.resolve(); interruptEntered.resolve(); crashEntered.resolve(); crashRelease.resolve();
        // A rejected fixture request is fatal, not a provider retry experiment.
        // Stop only the subprocess this runner created; retain normal leak audits.
        if (omp?.exitCode === null) omp.kill();
        return new Response(String(error), { status: 500 });
      }
    }});
    const config = join(roundDir, "config.json");
    const loopback = "remote-task-smoke/probe";
    await writeFile(config, JSON.stringify({ async: { enabled: false }, task: { batch: true, maxConcurrency: 9, workerThreads: 1, structured: false, perCallModel: "on", perCallModelAllow: [loopback], agentIdleTtlMs: 0, completionProbe: false, softRequestBudget: 0, prewalk: false }, modelRoles: { default: loopback, tiny: loopback, smol: loopback, commit: loopback }, retry: { modelFallback: false }, advisor: { enabled: false }, memory: { enabled: false }, autolearn: { enabled: false }, compaction: { enabled: false } }));
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(Bun.env)) {
      if (["PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK", "SSH_AGENT_PID"].includes(name) || /^(REMOTE_|OMP_REMOTE_)/.test(name)) env[name] = value;
    }
    Object.assign(env, { OMP_ACCEPTANCE_RUN_ID: run, TASK_ACCEPTANCE_ENDPOINT: `http://127.0.0.1:${server.port}`, TASK_ACCEPTANCE_LOCAL_MARKER: localMarker, PI_CODING_AGENT_DIR: join(roundDir, "agent"), OPENAI_API_KEY: "unused-local-command-only" });
    const execute = async (restart: boolean) => {
      admitted = false; passed = false;
      const command = restart ? "remote-task-restart-smoke" : "remote-task-smoke";
      const passMarker = restart ? "RESTART_INTENT_SMOKE_PASS" : "TASK_SMOKE_PASS";
      omp = Bun.spawn([Bun.env.OMP_BINARY ?? "omp", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--config", config, "--session-dir", join(roundDir, "sessions"), ...(restart ? ["--session", join(roundDir, "restart-session.jsonl")] : []), "-e", bundle, "--model", "openai/gpt-4o-mini", "--approval-mode", "yolo", "--mode", "rpc"], { cwd: roundDir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const errors = new Response(omp.stderr).text();
      const timer = setTimeout(() => { failures.push("Native task acceptance timed out"); omp!.kill(); gate.resolve(); interruptRelease.resolve(); crashRelease.resolve(); }, restart ? 60_000 : 12 * 60_000);
      try {
        const send = async (frame: object) => { omp!.stdin.write(JSON.stringify(frame) + "\n"); await omp!.stdin.flush(); };
        await send({ id: "admission", type: "get_available_commands" });
        const reader = omp.stdout.getReader(), decoder = new TextDecoder();
        let buffer = "";
        const consume = async (line: string) => {
          if (line.includes(passMarker) || (!restart && roundLimited && line.includes("TASK_SMOKE_PARTIAL"))) passed = true;
          let frame: any; try { frame = JSON.parse(line); } catch { if (line) console.log(line); return; }
          if (frame.type === "response" && frame.id === "admission") {
            assert(!admitted && frame.success && frame.data.commands.some((entry: any) => entry.name === command && entry.source === "extension")); admitted = true;
            await send({ id: "execution", type: "prompt", message: `/${command}` });
          }
          if (frame.type === "extension_error" || (frame.id === "execution" && frame.success === false)) throw new Error(JSON.stringify(frame));
          if (restart) assert.notEqual(frame.type, "agent_start", "Persisted-intent restart check must not contact a provider");
          if (frame.type === "extension_ui_request" && frame.message) console.log(frame.message);
        };
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true }); let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); await consume(line); }
          }
          buffer += decoder.decode(); if (buffer) await consume(buffer);
        } finally { reader.releaseLock(); }
        assert.equal(await omp.exited, 0); assert(admitted && passed, "Native task helper did not complete");
        assert.equal(failures.length, 0, failures.join("\n"));
      } finally {
        clearTimeout(timer); gate.resolve(); interruptRelease.resolve(); crashRelease.resolve(); crashEntered.resolve();
        try { await omp.stdin.end(); } catch {}
        if (omp.exitCode === null) omp.kill(); await omp.exited;
        const stderr = await errors; if (stderr) await writeFile(join(roundDir, `${restart ? "restart" : "task"}-stderr.log`), stderr);
        const deadline = Date.now() + 5000;
        while (true) {
          try { await snapshot("process-exited", true); break; }
          catch (error) {
            if (Date.now() >= deadline) throw error;
            const retry = Promise.withResolvers<void>(); setTimeout(retry.resolve, 100); await retry.promise;
          }
        }
        await writeFile(join(directory, "thread-observations.json"), JSON.stringify(observations, null, 2));
      }
    };
    try { await execute(false); await execute(true); }
    finally { server.stop(true); }
    if (roundLimited) limitedRounds++;
    console.log(roundLimited ? "TASK_ACCEPTANCE_ROUND_PARTIAL" : "TASK_ACCEPTANCE_ROUND_PASS", JSON.stringify({ round, nativeTasks: initial.size, actualWorkerThread: observations.some(row => row.round === round && !row.isMainThread), taskProviderRequests: requests - labelRequests, nativeLabelRequests: labelRequests, remoteCleanup: cleanupEvidence?.remoteCleanup, sshStdinClosed: cleanupEvidence?.sshStdinClosed, localReaped: cleanupEvidence?.localReaped, finalSurvivors: 0 }));
  }
  completed = true;
  console.log(limitedRounds ? "TASK_ACCEPTANCE_PARTIAL" : "TASK_ACCEPTANCE_PASS", JSON.stringify({ rounds, limitedRounds, limitation: limitedRounds ? "Native Bun worker exit leaves a closed-fd SSH zombie until parent exit; remote cleanup succeeds, local reaping fails" : undefined, restartMeaning: "real native process restart from a flushed connected-session snapshot; persisted intent unavailable, no automatic reconnect", finalSurvivors: 0 }));
} finally {
  if (completed && limitedRounds === 0 && Bun.env.SMOKE_KEEP_ARTIFACTS !== "1") await rm(directory, { recursive: true, force: true });
  else console.error(`Retained private acceptance artifacts: ${directory}`);
}
