import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "@oh-my-pi/omptype/zod";

const responseSchema = z.object({ id: z.string(), type: z.string(), success: z.boolean().optional(), data: z.unknown().optional(), agentInvoked: z.boolean().optional(), status: z.string().optional() });
const snapshotSchema = z.object({ file: z.string(), cached: z.string(), same: z.boolean(), grammar: z.boolean() });
type Response = z.infer<typeof responseSchema>;

test("bundled native host retains edit grammar after new_session and fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-live-owner-"));
  const output = join(root, "snapshots.jsonl");
  const fixture = join(root, "extension.ts");
  const cli = resolve(dirname(Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir)), "../dist/cli.js");
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "config.yml"), "astGrep:\n  enabled: true\n");
  await writeFile(fixture, `
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { appendFileSync } from "node:fs";
export default async function(pi) {
  pi.registerCommand("owner-probe", { handler: async (_args, ctx) => {
    try {
      const ref = AgentRegistry.global().get(ctx.agent.id);
      const live = ref.session;
      const tools = ["read", "write", "edit", "bash", "grep", "glob", "lsp", "ast_grep", "ast_edit", "eval", "debug"].map(name => {
        const t = live.getToolByName(name);
        if (!t) throw new Error("Missing host tool: " + name);
        const parameters = structuredClone(t.parameters.toJsonSchema?.() ?? t.parameters);
        if (name === "bash") delete parameters.properties.async;
        return {name, description:t.description, parameters, customFormat:t.customFormat, customWireName:t.customWireName};
      });
      appendFileSync(${JSON.stringify(output)}, JSON.stringify({file:ctx.sessionManager.getSessionFile(),cached:ref.sessionFile,same:live.sessionManager===ctx.sessionManager,grammar:!!tools.find(t=>t.name==="edit").customFormat})+"\\n");
    } catch (error) { appendFileSync(${JSON.stringify(output)}, JSON.stringify({error:String(error),stack:error?.stack})+"\\n"); throw error; }
  }});
}`);
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-ui", "--model", "openai/gpt-4o-mini", "--trusted-extension", resolve(import.meta.dir, "../packages/omp/dist/extension.js"), "--trusted-extension", fixture, "--session-dir", join(root, "sessions")], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), OPENAI_API_KEY: "unused-local-command-only", PI_EDIT_VARIANT: "hashline" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = Promise.withResolvers<void>();
  child.once("exit", () => exited.resolve());
  child.once("error", error => { for (const call of pending.values()) call.reject(error); exited.resolve(); });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const pending = new Map<string, { resolve: (value: Response) => void; reject: (error: Error) => void; prompt: boolean }>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let decoded: unknown;
    try { decoded = JSON.parse(line); } catch { return; }
    const parsed = responseSchema.safeParse(decoded);
    if (!parsed.success) return;
    const value = parsed.data;
    const call = pending.get(value.id);
    if (!call) return;
    if (value.type === "response" && !value.success) { pending.delete(value.id); call.reject(new Error(JSON.stringify(value))); }
    else if ((!call.prompt && value.type === "response") || value.type === "prompt_result") { pending.delete(value.id); call.resolve(value); }
  });
  child.on("exit", code => { for (const call of pending.values()) call.reject(new Error(`Host exited ${code}: ${stderr}`)); pending.clear(); });
  let nextId = 0;
  const call = (command: Record<string, unknown>) => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const id = String(++nextId);
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC command ${command.type} timed out: ${stderr}`)); }, 10_000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); }, prompt: command.type === "prompt" });
    child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    return promise;
  };
  try {
    await call({type:"get_state"});
    for (const transition of [undefined, "new_session", "fork"]) {
      if (transition) expect(z.object({ cancelled: z.boolean() }).parse((await call({type:transition})).data).cancelled).toBe(false);
      const result = await call({type:"prompt",message:"/owner-probe"});
      expect(result).toMatchObject({ agentInvoked: false, status: "completed" });
    }
    const snapshots = (await readFile(output, "utf8")).trim().split("\n").map(line => {
      const decoded: unknown = JSON.parse(line);
      const parsed = snapshotSchema.safeParse(decoded);
      if (!parsed.success) throw new Error(`Probe failed: ${line}; stderr: ${stderr}`);
      return parsed.data;
    });
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].file).toBe(snapshots[0].cached);
    for (const snapshot of snapshots) expect(snapshot, stderr).toMatchObject({ same: true, grammar: true });
    for (const snapshot of snapshots.slice(1)) expect(snapshot.file).not.toBe(snapshot.cached);
  } finally {
    child.kill("SIGKILL");
    await exited.promise;
    lines.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
