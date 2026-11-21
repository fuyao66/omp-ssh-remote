import { expect, spyOn } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionApprovalAnswer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { createRealSession, fixtureFile, localText, realSessionTest, remoteText } from "./fixtures/real-session.ts";

const read = { name: "read", arguments: { path: fixtureFile } };
const evalRead = { name: "eval", arguments: {
  language: "js", title: "Read via native host approval", code: `print((await tool.read({path:${JSON.stringify(fixtureFile)}})).text)`,
} };

function observeNativeReads() {
  const execute = ReadTool.prototype.execute;
  return spyOn(ReadTool.prototype, "execute").mockImplementation(function (this: ReadTool, ...args) {
    return execute.apply(this, args);
  });
}

realSessionTest(import.meta.path, "wrapper-installation-and-delegation: native registry barrier installs a single delegating wrapper", async root => {
  let original!: AgentTool;
  const nativeCalls = observeNativeReads();
  const f = await createRealSession(root, { beforeStart(session) {
    original = session.getToolByName("read")!;
  } });
  try {
    // session_start includes the plugin's mutation barrier; don't add a wait
    // here that could hide registration that escaped it.
    expect(f.session.getToolByName("read")).not.toBe(original);
    const local = await f.turn("Read the local sentinel.", read);
    expect(JSON.stringify(local[1]!.messages)).toContain(localText);
    expect(nativeCalls).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);

    await f.connect();
    const remote = await f.turn("Read it again in the remote workspace.", read);
    expect(JSON.stringify(remote[1]!.messages.at(-1))).toContain(remoteText);
    expect(JSON.stringify(remote[1]!.messages.at(-1))).not.toContain(localText);
    expect(nativeCalls).toHaveBeenCalledTimes(1);
    expect(f.calls.map(([name]) => name)).toEqual(["read"]);

    const replacement = "remote-only replacement";
    await f.turn("Overwrite the sentinel only in the remote workspace.", {
      name: "write", arguments: { path: fixtureFile, content: replacement },
    });
    expect(await readFile(join(f.cwd, fixtureFile), "utf8")).toBe(localText);
    expect(await readFile(join(f.remoteCwd, fixtureFile), "utf8")).toBe(replacement);
    expect(f.calls.map(([name]) => name)).toEqual(["read", "write"]);
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "wrapper-live-metadata: native presentation keeps live schema, grammar, and approval without speculation", async root => {
  let revision = 1;
  let original!: AgentTool;
  let originalRead!: AgentTool;
  const f = await createRealSession(root, { settings: { "edit.mode": "replace" }, beforeStart(session) {
    original = session.getToolByName("edit")!;
    originalRead = session.getToolByName("read")!;
    const parameters = original.parameters;
    Object.defineProperties(original, {
      parameters: { configurable: true, get: () => ({ ...parameters, description: `fixture-schema-${revision}` }) },
      customFormat: { configurable: true, get: () => ({ syntax: "lark", definition: `start: \"revision-${revision}\"` }) },
    });
  } });
  try {
    const wrapper = f.session.getToolByName("edit")!;
    const wrappedRead = f.session.getToolByName("read")!;
    expect(wrapper).not.toBe(original);
    expect(wrapper.loadMode).toBe(original.loadMode ?? "essential");
    const args = { path: fixtureFile, old_string: "before", new_string: "after" };
    expect(typeof wrapper.approval).toBe("function");
    expect((wrapper.approval as (args: unknown) => unknown)(args)).toEqual((original.approval as (args: unknown) => unknown)(args));
    expect(wrappedRead.approvalCacheTargets?.(args)).toEqual(originalRead.approvalCacheTargets?.(args));
    expect(originalRead.speculation).toBeDefined();
    expect(wrappedRead.speculation).toBeUndefined();

    const first = await f.turn("Inspect the first tool presentation.");
    expect(first[0]!.tools.find(tool => tool.name === "edit")).toMatchObject({
      parameters: { description: "fixture-schema-1" }, customFormat: { syntax: "lark", definition: 'start: "revision-1"' },
    });
    revision = 2;
    const second = await f.turn("Inspect the second tool presentation.");
    expect(second[0]!.tools.find(tool => tool.name === "edit")).toMatchObject({
      parameters: { description: "fixture-schema-2" }, customFormat: { syntax: "lark", definition: 'start: "revision-2"' },
    });
  } finally { await f.dispose(); }
});

realSessionTest(import.meta.path, "host-eval-context: nested calls re-enter enabled lookup, rewritten-input policy and approval", async root => {
  const deniedPath = "denied-by-native-policy.txt";
  let rewrite = false;
  let innerAnswer: ExtensionApprovalAnswer = "deny";
  const hooks: string[] = [], approvals: [string, boolean][] = [];
  const nativeCalls = observeNativeReads();
  const f = await createRealSession(root, {
    settings: { "tools.approvalMode": "yolo", "tools.approval": { eval: "prompt", read: "prompt" } },
    // Respond at the real wrapper's UI boundary, once per tool call.
    approve: async () => approvals.at(-1)?.[0] === "read" ? innerAnswer : "once",
    beforeStart(session) {
      const native = session.getToolByName("read")!;
      const original = native.approval;
      if (typeof original !== "function") throw new Error("Native read lacks an input-sensitive approval decision");
      Object.defineProperty(native, "approval", { configurable: true, value: (input: { path: string }) =>
        input.path === deniedPath ? { tier: "read", policy: "deny", reason: "fixture path denied" } : original.call(native, input),
      });
    },
    afterRemote: [pi => {
      pi.on("tool_approval_requested", event => { approvals.push([event.toolName, false]); });
      pi.on("tool_approval_resolved", event => { approvals.at(-1)![1] = event.approved; });
      pi.on("tool_call", event => {
        if (event.toolName !== "read") return;
        hooks.push(String(event.input.path));
        if (rewrite) return { input: { ...event.input, path: deniedPath } };
      });
    }],
  });
  try {
    await f.connect();
    const enabled = f.session.getEnabledToolNames();
    await f.session.setActiveToolsByName(enabled.filter(name => name !== "read"));
    const disabled = await f.turn("Try an Eval callback to a disabled tool.", evalRead);
    expect(JSON.stringify(disabled[1]!.messages.at(-1))).toContain("not enabled by the host");
    expect(f.calls.map(([name]) => name)).toEqual(["eval"]);
    expect(hooks).toEqual([]);
    expect(approvals.splice(0)).toEqual([["eval", true]]);

    await f.session.setActiveToolsByName(enabled);
    rewrite = true;
    const rewritten = await f.turn("Try an Eval callback whose hook rewrites the input.", evalRead);
    expect(JSON.stringify(rewritten[1]!.messages.at(-1))).toContain("fixture path denied");
    expect(f.calls.splice(0).map(([name]) => name)).toEqual(["eval", "eval"]);
    expect(hooks.splice(0)).toEqual([fixtureFile]);
    expect(approvals.splice(0)).toEqual([["eval", true]]);

    rewrite = false;
    const rejected = await f.turn("Approve the outer call but reject the inner read.", evalRead);
    expect(JSON.stringify(rejected[1]!.messages.at(-1))).toContain("Tool call denied by user: read");
    expect(f.calls.splice(0).map(([name]) => name)).toEqual(["eval"]);
    expect(hooks.splice(0)).toEqual([fixtureFile]);
    expect(approvals.splice(0)).toEqual([["eval", true], ["read", false]]);

    innerAnswer = "once";
    const accepted = await f.turn("Approve both outer Eval and nested read.", evalRead);
    const result = JSON.stringify(accepted[1]!.messages.at(-1));
    expect(result).toContain(remoteText);
    expect(result).not.toContain(localText);
    expect(f.calls.map(([name]) => name)).toEqual(["eval", "read"]);
    expect(hooks).toEqual([fixtureFile]);
    expect(approvals).toEqual([["eval", true], ["read", true]]);
    expect(nativeCalls).not.toHaveBeenCalled();
    expect(await readFile(join(f.cwd, fixtureFile), "utf8")).toBe(localText);
    expect(await readFile(join(f.remoteCwd, fixtureFile), "utf8")).toBe(remoteText);
  } finally { await f.dispose(); }
});
