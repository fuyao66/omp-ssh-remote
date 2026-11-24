import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { REMOTE_PREVIEW_RESOLVER } from "../src/protocol.ts";
import { createRealSession, realSessionTest } from "./fixtures/real-session.ts";

const bash = (command: string) => ({ name: "bash", arguments: { command } });
const json = (value: unknown) => `'${JSON.stringify(value)}'`;
const resultText = (dispatch: { messages: unknown[] }) =>
  JSON.stringify([...dispatch.messages].reverse().find(message => (message as { role?: string }).role === "toolResult"));
const remoteTools = (calls: unknown[][]) => calls.map(call => call[0]);

// OMP 19.1 hands a bash line made only of tool commands to its native host bash, which would set
// it up locally (cwd, direnv, shell prefix, `@path` files). While bound, every line stays in the
// remote shell, whose tool commands still reach the host's own dispatch.
realSessionTest(import.meta.path, "tool commands run in the remote shell and dispatch through the host", async root => {
  const f = await createRealSession(root, { settings: { "astGrep.enabled": true, "security.enabled": true } });
  try {
    await writeFile(join(f.cwd, "a.ts"), "const local = oldApi(0);\n");
    await writeFile(join(f.remoteCwd, "a.ts"), "const remote = oldApi(1);\n");
    await f.connect();
    expect(f.session.getMountedToolCommandNames()).toEqual(expect.arrayContaining(["ast_grep", "security_scan"]));
    const shells = () => remoteTools(f.calls).filter(name => name === "bash").length;

    // A command-only line runs in the remote shell and its command in the remote runtime.
    const before = shells();
    await f.turn("Debug sessions via the command.", bash(`debug -j '{"action":"sessions"}'`));
    expect(shells()).toBe(before + 1);
    expect(remoteTools(f.calls)).toContain("debug");

    // `@path` argument files and `cwd` resolve remotely; neither exists locally.
    await mkdir(join(f.remoteCwd, "sub"));
    await writeFile(join(f.remoteCwd, "sub", "q.json"), JSON.stringify({ pat: "oldApi($A)", path: "b.ts" }));
    await writeFile(join(f.remoteCwd, "b.ts"), "const sub = oldApi(2);\n");
    await writeFile(join(f.remoteCwd, "q.json"), JSON.stringify({ pat: "oldApi($A)", path: "a.ts" }));
    await writeFile(join(f.cwd, "q.json"), JSON.stringify({ pat: "oldApi($A)", path: "a.ts" }));
    const [, fromFile] = await f.turn("Search from an argument file.", bash("ast_grep -j @q.json"));
    expect(resultText(fromFile)).toContain("oldApi(1)");
    expect(resultText(fromFile)).not.toContain("oldApi(0)");
    const [, withCwd] = await f.turn("Search from a directory.",
      { name: "bash", arguments: { command: "ast_grep -j @q.json", cwd: "sub" } });
    expect(resultText(withCwd)).toContain("oldApi(2)");
    expect(shells()).toBe(before + 3);

    // `$` and a pipe keep the line in the remote shell as well.
    const [, grep] = await f.turn("Search via the command.",
      bash(`ast_grep -j ${json({ pat: "oldApi($A)", path: "a.ts" })} | head -n 20`));
    expect(resultText(grep)).toContain("oldApi(1)");
    expect(resultText(grep)).toContain(JSON.stringify(f.remoteCwd));
    expect(resultText(grep)).not.toContain("oldApi(0)");
    expect(remoteTools(f.calls).filter(name => name === "ast_grep")).toHaveLength(3);

    // Eval's `sh` mounts the same commands in the remote worker.
    const command = `ast_grep -j ${json({ pat: "oldApi($A)", path: "a.ts" })} | head -n 20`;
    const [, evalSh] = await f.turn("Search via Eval sh.", { name: "eval", arguments: {
      language: "js", title: "Eval sh tool command", code: `print((await sh(${JSON.stringify(command)})).output)` } });
    expect(resultText(evalSh)).toContain("oldApi(1)");
    expect(resultText(evalSh)).not.toContain("oldApi(0)");
    expect(remoteTools(f.calls).filter(name => name === "ast_grep")).toHaveLength(4);

    // A local-only tool invoked from the remote shell hits the same guard as its direct call.
    const [, scan] = await f.turn("Scan via the command.", bash(`security_scan -j '{"action":"preflight"}' || echo "exit=$?"`));
    expect(resultText(scan)).toContain("not remote-adapted");
    expect(resultText(scan)).toContain("exit=1");
  } finally { await f.dispose(); }
});

// Remote shell content must not steer a workspace tool to the host: a local URI, even in a field the
// action ignores or one a tool_call hook adds, fails as it does from an Eval callback.
realSessionTest(import.meta.path, "a remote shell's tool command never selects a host workspace target", async root => {
  let rewrite = false;
  const f = await createRealSession(root, { afterRemote: [pi => {
    pi.on("tool_call", event => {
      if (rewrite && event.toolName === "debug") return { input: { ...event.input, file: "local://x.ts" } };
    });
  }] });
  try {
    await f.connect();
    const debugs = () => remoteTools(f.calls).filter(name => name === "debug").length;
    const refused = "debug command: host resource unavailable from the remote runtime";
    const [, direct] = await f.turn("Debug with a host path.",
      bash(`debug -j '{"action":"sessions","file":"local://x.ts"}' || echo "exit=$?"`));
    expect(resultText(direct)).toContain(refused);
    expect(resultText(direct)).toContain("exit=1");
    rewrite = true;
    const [, hooked] = await f.turn("Debug sessions.", bash(`debug -j '{"action":"sessions"}' || echo "exit=$?"`));
    expect(resultText(hooked)).toContain(refused);
    expect(debugs()).toBe(0);
    rewrite = false;
    await f.turn("Debug sessions again.", bash(`debug -j '{"action":"sessions"}'`));
    expect(debugs()).toBe(1);
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "a preview staged inside a remote shell resolves through native resolve", async root => {
  const f = await createRealSession(root);
  try {
    const source = "const value = oldApi(1);\n";
    await writeFile(join(f.cwd, "a.ts"), source);
    await writeFile(join(f.remoteCwd, "a.ts"), source);
    await f.connect();
    const start = f.provider.dispatches.length;
    f.provider.replies.push(
      bash(`ast_edit -j ${json({ ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["a.ts"] })}`),
      bash(`resolve -j '{"reason":"verified rename"}' && cat a.ts`),
      null,
    );
    await f.session.prompt("Preview the rename, then apply it.");
    const [, preview, applied] = f.provider.dispatches.slice(start);
    expect(f.provider.unexpected).toEqual([]);
    expect(resultText(preview)).toContain("NOT modified");
    expect(resultText(applied)).toContain("const value = newApi(1);");
    expect(await readFile(join(f.remoteCwd, "a.ts"), "utf8")).toBe("const value = newApi(1);\n");
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe(source);
    expect(f.session.toolChoiceQueue.hasPendingInvoker).toBe(false);
    expect(remoteTools(f.calls)).toEqual(expect.arrayContaining(["ast_edit", "resolve"]));
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "connect refuses while a local preview is pending, since resolve would apply it", async root => {
  const f = await createRealSession(root);
  try {
    await writeFile(join(f.cwd, "a.ts"), "const value = oldApi(1);\n");
    // A pending preview's reminder keeps a turn going; replies past the tool call are spare stops.
    f.provider.replies.push(bash(`ast_edit -j ${json({ ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["a.ts"] })}`), null, null, null, null);
    await f.session.prompt("Preview locally.");
    f.provider.replies.length = 0;
    expect(f.session.toolChoiceQueue.hasPendingInvoker).toBe(true);
    await f.connect().catch(() => undefined);
    expect(f.clients).toHaveLength(0);
    f.provider.replies.push(bash(`reject -j '{"reason":"connect first"}'`), null, null, null, null);
    await f.session.prompt("Reject it.");
    f.provider.replies.length = 0;
    expect(f.session.toolChoiceQueue.hasPendingInvoker).toBe(false);
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("const value = oldApi(1);\n");
    await f.connect();
    expect(f.clients).toHaveLength(1);
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "reconnect refuses magic edit mode before replacing the worker", async root => {
  const f = await createRealSession(root);
  try {
    await f.connect();
    f.session.settings.writeValue(cfgEditMode, "magic", "override");
    await f.command("remote-reconnect", "--force").catch(() => undefined);
    expect(f.clients).toHaveLength(1);
    expect(f.clients[0]!.client.isClosed).toBe(false);
  } finally { await f.dispose(); }
});

// Each step drives the session directly: a pending preview's reminder keeps a turn going, so
// replies past the tool call are spare stops.
async function step(f: Awaited<ReturnType<typeof createRealSession>>, prompt: string, command: string) {
  f.provider.replies.push(bash(command), null, null, null, null);
  await f.session.prompt(prompt);
  f.provider.replies.length = 0;
}
const rename = `ast_edit -j ${json({ ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["a.ts"] })}`;

realSessionTest(import.meta.path, "cancelling the shell that ran resolve stops an apply not yet at the worker", async root => {
  const entered = Promise.withResolvers<void>();
  let held = false;
  // Stands in for the worker's mutation slot: the apply waits until its shell is cancelled.
  const f = await createRealSession(root, { async beforeExecute(tool, args) {
    if (tool !== REMOTE_PREVIEW_RESOLVER || held) return;
    held = true;
    entered.resolve();
    const signal = args[3];
    if (signal && !signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  } });
  try {
    const source = "const value = oldApi(1);\n";
    await writeFile(join(f.remoteCwd, "a.ts"), source);
    await f.connect();
    await step(f, "Preview the rename.", rename);
    expect(f.session.toolChoiceQueue.hasPendingInvoker).toBe(true);
    f.provider.replies.push(bash(`resolve -j '{"reason":"apply"}'`), null, null, null, null);
    const applying = f.session.prompt("Apply it.");
    await entered.promise;
    await f.session.abort();
    await applying.catch(() => undefined);
    f.provider.replies.length = 0;
    expect(await readFile(join(f.remoteCwd, "a.ts"), "utf8")).toBe(source);
    expect(f.session.toolChoiceQueue.hasPendingInvoker).toBe(true);
    await step(f, "Reject it.", `reject -j '{"reason":"cancelled"}'`);
    expect(f.session.toolChoiceQueue.hasPendingInvoker).toBe(false);
    expect(await readFile(join(f.remoteCwd, "a.ts"), "utf8")).toBe(source);
    // Exit waits out native bash's 1.25 s post-cancel kill grace, which the 1 s session-shutdown
    // close does not; that pre-existing race is independent of preview resolution.
    await f.disconnect();
  } finally { await f.dispose(); }
});

// Native shells run special commands (`resolve`, `reject`, `propose`) without the tool approval
// gate. A remote shell must match the local one under the same policy, whichever way upstream goes.
realSessionTest(import.meta.path, "resolve from a remote shell meets the same approval policy as from a local one", async root => {
  const f = await createRealSession(root, { settings: { "tools.approval": { resolve: "deny" } } });
  try {
    const source = "const value = oldApi(1);\n";
    await writeFile(join(f.cwd, "a.ts"), source);
    await writeFile(join(f.remoteCwd, "a.ts"), source);
    await step(f, "Preview locally.", rename);
    await step(f, "Apply locally.", `resolve -j '{"reason":"local"}'`);
    const local = await readFile(join(f.cwd, "a.ts"), "utf8");
    await f.connect();
    await step(f, "Preview remotely.", rename);
    await step(f, "Apply remotely.", `resolve -j '{"reason":"remote"}'`);
    const remote = await readFile(join(f.remoteCwd, "a.ts"), "utf8");
    expect(remote).toBe(local);
    // SDK 19.1.1 behavior; a change here means native gating changed and the host dispatch must follow.
    expect(local).toBe("const value = newApi(1);\n");
  } finally { await f.dispose(); }
});
