import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createNativeWorkerRuntime, type NativeWorkerRuntime } from "../src/runtime.ts";
import { REMOTE_PREVIEWS_KEY } from "../src/protocol.ts";
import { dropRemotePreviews, mirrorRemotePreview, takeRemotePreviews, type RemotePreviewMirror } from "../src/omp/remote-previews.ts";

const rename = (from: string, to: string, file: string) =>
  ({ ops: [{ pat: `${from}($$$ARGS)`, out: `${to}($$$ARGS)` }], paths: [file] });

async function withRuntime(run: (runtime: NativeWorkerRuntime, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "remote-previews-"));
  const runtime = await createNativeWorkerRuntime(cwd);
  try { await run(runtime, cwd); } finally {
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("a worker preview is reported once, then applied by id exactly once", async () => {
  await withRuntime(async (runtime, cwd) => {
    await writeFile(join(cwd, "a.ts"), "const value = oldApi(1);\n");
    const result = await runtime.tools.ast_edit.execute("preview", rename("oldApi", "newApi", "a.ts")) as AgentToolResult;
    const staged = takeRemotePreviews(result);
    expect(staged).toEqual([{ id: expect.any(String), sourceToolName: "ast_edit" }]);
    expect(REMOTE_PREVIEWS_KEY in result).toBe(false);
    expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("const value = oldApi(1);\n");

    const applied = await runtime.resolvePreview.execute("apply", { id: staged[0]!.id, action: "apply", reason: "rename" }) as AgentToolResult;
    expect(applied.isError).not.toBe(true);
    expect(takeRemotePreviews(applied)).toEqual([]);
    expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("const value = newApi(1);\n");
    await expect(runtime.resolvePreview.execute("again", { id: staged[0]!.id, action: "apply", reason: "again" }))
      .rejects.toThrow("no longer pending");
  });
});

test("a stale apply is a native business error that still consumes its preview", async () => {
  await withRuntime(async (runtime, cwd) => {
    await writeFile(join(cwd, "stale.ts"), "const value = oldApi(1);\n");
    const [preview] = takeRemotePreviews(await runtime.tools.ast_edit.execute("preview", rename("oldApi", "newApi", "stale.ts")));
    await writeFile(join(cwd, "stale.ts"), "const value = unrelated(2);\n");
    const applied = await runtime.resolvePreview.execute("stale", { id: preview!.id, action: "apply", reason: "stale" }) as AgentToolResult;
    expect(applied.isError).toBe(true);
    await expect(runtime.resolvePreview.execute("again", { id: preview!.id, action: "discard", reason: "gone" }))
      .rejects.toThrow("no longer pending");
    expect(await readFile(join(cwd, "stale.ts"), "utf8")).toBe("const value = unrelated(2);\n");
  });
});

test("host mirrors resolve newest first, each reaching its own worker preview", async () => {
  await withRuntime(async (runtime, cwd) => {
    await writeFile(join(cwd, "a.ts"), "first(1);\n");
    await writeFile(join(cwd, "b.ts"), "second(2);\n");
    const host = new ToolChoiceQueue();
    const mirrors: RemotePreviewMirror[] = [];
    const resolver = () => (resolution: { action: string; reason: string }, id: string) =>
      runtime.resolvePreview.execute("resolve", { id, ...resolution });
    for (const [from, file] of [["first", "a.ts"], ["second", "b.ts"]] as const) {
      for (const preview of takeRemotePreviews(await runtime.tools.ast_edit.execute(file, rename(from, `${from}Done`, file))))
        mirrorRemotePreview(mirrors, host, preview, () => resolution => resolver()(resolution, preview.id));
    }
    expect(mirrors).toHaveLength(2);

    await host.peekPendingInvoker()!({ action: "discard", reason: "not this one" });
    expect(await readFile(join(cwd, "b.ts"), "utf8")).toBe("second(2);\n");
    expect(mirrors).toHaveLength(1);
    await host.peekPendingInvoker()!({ action: "apply", reason: "first rename" });
    expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("firstDone(1);\n");
    expect(host.hasPendingInvoker).toBe(false);
    expect(mirrors).toHaveLength(0);
  });
});

test("a preview lost with its runtime cannot apply, can be discarded, and is withdrawn on reconnect", async () => {
  const host = new ToolChoiceQueue();
  const mirrors: RemotePreviewMirror[] = [];
  mirrorRemotePreview(mirrors, host, { id: "w-1", sourceToolName: "ast_edit" }, () => undefined);
  await expect(Promise.resolve(host.peekPendingInvoker()!({ action: "apply", reason: "apply" }))).rejects.toThrow("lost with its remote runtime");
  expect(host.hasPendingInvoker).toBe(true);
  const discarded = await host.peekPendingInvoker()!({ action: "discard", reason: "gone" }) as AgentToolResult;
  expect(discarded.content[0]).toMatchObject({ text: expect.stringContaining("Discarded") });
  expect(host.hasPendingInvoker).toBe(false);

  mirrorRemotePreview(mirrors, host, { id: "w-2", sourceToolName: "ast_edit" }, () => undefined);
  expect(dropRemotePreviews(mirrors)).toBe(1);
  expect(host.hasPendingInvoker).toBe(false);
});

test("a failed remote apply keeps the mirror pending for reject or retry", async () => {
  const host = new ToolChoiceQueue();
  const mirrors: RemotePreviewMirror[] = [];
  let fail = true;
  mirrorRemotePreview(mirrors, host, { id: "w-1", sourceToolName: "ast_edit" }, () => async () => {
    if (fail) throw new Error("overlapping replacements");
    return { content: [{ type: "text", text: "applied" }] };
  });
  await expect(Promise.resolve(host.peekPendingInvoker()!({ action: "apply", reason: "try" }))).rejects.toThrow("overlapping");
  expect(mirrors).toHaveLength(1);
  fail = false;
  await host.peekPendingInvoker()!({ action: "apply", reason: "retry" });
  expect(host.hasPendingInvoker).toBe(false);
  expect(mirrors).toHaveLength(0);
});

test("a mirror is claimed before it awaits the worker, so an overlapping resolution cannot reach it", async () => {
  const host = new ToolChoiceQueue();
  const mirrors: RemotePreviewMirror[] = [];
  let release!: () => void;
  const calls: string[] = [];
  mirrorRemotePreview(mirrors, host, { id: "w-1", sourceToolName: "ast_edit" }, () => async ({ action }) => {
    calls.push(action);
    await new Promise<void>(resolve => { release = resolve; });
    return { content: [{ type: "text", text: action }] };
  });
  const applying = Promise.resolve(host.peekPendingInvoker()!({ action: "apply", reason: "first" }));
  expect(host.hasPendingInvoker).toBe(false);
  release();
  await applying;
  expect(calls).toEqual(["apply"]);
  expect(mirrors).toHaveLength(0);
});

test("a mirror withdrawn while its apply is in flight stays withdrawn when the apply fails", async () => {
  const host = new ToolChoiceQueue();
  const mirrors: RemotePreviewMirror[] = [];
  let fail!: (error: Error) => void;
  mirrorRemotePreview(mirrors, host, { id: "w-1", sourceToolName: "ast_edit" }, () => () =>
    new Promise((_resolve, reject) => { fail = reject; }));
  const applying = Promise.resolve(host.peekPendingInvoker()!({ action: "apply", reason: "try" }));
  expect(dropRemotePreviews(mirrors)).toBe(1);
  fail(new Error("worker closed"));
  await expect(applying).rejects.toThrow("worker closed");
  expect(host.hasPendingInvoker).toBe(false);
  expect(mirrors).toHaveLength(0);
});
