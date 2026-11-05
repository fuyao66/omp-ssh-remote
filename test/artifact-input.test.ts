import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { fileURLToPath } from "node:url";
import { createRemoteArtifacts, mountRemoteArtifactScheme, type RemoteArtifacts } from "../src/omp/artifacts.ts";
import { resolveRemoteArtifactArgs } from "../src/omp/artifact-input.ts";

const namespaces: RemoteArtifacts[] = [];
afterEach(async () => { await Promise.all(namespaces.splice(0).map(store => store.dispose())); });
async function artifact() {
  const store = await createRemoteArtifacts({ sweep: false }); namespaces.push(store);
  const file = await store.manager.allocatePath("input");
  await writeFile(file.path, "real artifact bytes\n");
  return { ...file, uri: `remote-artifact://${store.namespace}/${file.id}` };
}

describe("artifact input boundaries", () => {
  test("read preserves immutable URLs and isolates query-specific materialization", async () => {
    const file = await artifact();
    const query = `?q=.uri==${JSON.stringify(file.uri)}`;
    const input = { path: file.uri + query, extra: file.uri };
    expect(await resolveRemoteArtifactArgs("read", input)).toEqual({ path: file.path + query, extra: file.uri });
    expect(input.path).toBe(file.uri + query);
    expect(await resolveRemoteArtifactArgs("read", { path: file.uri + ":raw:2-4" })).toEqual({ path: file.uri + ":raw:2-4" });
  });

  test("grep resolves each artifact path, never the search pattern", async () => {
    const first = await artifact(); const second = await artifact();
    expect(await resolveRemoteArtifactArgs("grep", { path: `${first.uri}; ${second.uri}`, pattern: first.uri })).toEqual({ path: `${first.path}; ${second.path}`, pattern: first.uri });
  });

  test("an ordinary path or URL with a URI literal in its query is not an artifact lookup", async () => {
    const literal = "remote-artifact://00000000-0000-4000-8000-000000000000/999";
    for (const path of [`data.json?q=.uri==${JSON.stringify(literal)}`, `https://example.invalid/?reference=${literal}`, literal + "suffix"]) {
      const input = { path };
      expect(await resolveRemoteArtifactArgs("read", input)).toBe(input);
    }
  });

  test("code, write bodies, edit replacement text and other tool arguments remain opaque", async () => {
    const literal = "remote-artifact://00000000-0000-4000-8000-000000000000/999";
    const input = { path: "/tmp/data.txt", content: literal, code: `print(${JSON.stringify(literal)})`, input: `[data.txt#ABCD]\nPUT 1.=1:\n+${literal}`, pattern: literal, args: [literal] };
    for (const name of ["write", "edit", "eval", "ast_edit", "ast_grep", "lsp", "debug", "glob"]) {
      expect(await resolveRemoteArtifactArgs(name, input)).toBe(input);
    }
  });

  test("bash commands remain opaque, including artifact operands and printed URI literals", async () => {
    const file = await artifact();
    for (const command of [`cat ${file.uri}`, `cat '${file.uri}'`, `cat "${file.uri}"`, `printf '%s' '${file.uri}'`]) {
      const input = { command, i: file.uri };
      expect(await resolveRemoteArtifactArgs("bash", input)).toBe(input);
    }
    const plain = { command: "printf plain" };
    expect(await resolveRemoteArtifactArgs("bash", plain)).toBe(plain);
  });
});

describe("native remote artifact shell filesystem", () => {
  for (const homeName of ["inert-home", "it's; touch MARKER; # home"]) {
    test(`reads unchanged approved commands with HOME=${JSON.stringify(homeName)}`, async () => {
      const temporary = await mkdtemp(join(tmpdir(), "omp-artifact-shell-"));
      const home = join(temporary, homeName);
      try {
        // Bun caches os.homedir(): HOME must be set before the worker process starts.
        const child = Bun.spawn([process.execPath, "--eval", `
          import assert from "node:assert/strict";
          import { mkdir, readFile, writeFile } from "node:fs/promises";
          import { dirname } from "node:path";
          import { createNativeWorkerRuntime } from ${JSON.stringify(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)))};
          import { mountRemoteArtifactScheme } from ${JSON.stringify(fileURLToPath(new URL("../src/omp/artifacts.ts", import.meta.url)))};
          import { resolveRemoteArtifactArgs } from ${JSON.stringify(fileURLToPath(new URL("../src/omp/artifact-input.ts", import.meta.url)))};
          await mkdir(process.env.HOME, { recursive: true });
          mountRemoteArtifactScheme();
          const runtime = await createNativeWorkerRuntime(${JSON.stringify(temporary)});
          try {
            const file = await runtime.session.getArtifactManager().allocatePath("bash");
            assert(file.path.startsWith(process.env.HOME + "/"), file.path);
            await writeFile(file.path, "real artifact bytes\\n");
            const namespace = dirname(file.path).split("/").at(-1);
            const uri = "remote-artifact://" + namespace + "/" + file.id;
            const text = value => value.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\\n");
            for (const operand of [uri, "'" + uri + "'", '"' + uri + '"']) {
              const input = { command: "cat " + operand, timeout: 10 };
              assert.equal(await resolveRemoteArtifactArgs("bash", input), input);
              const result = text(await runtime.tools.bash.execute("read-" + operand, input));
              assert.match(result, /real artifact bytes/);
              assert.doesNotMatch(result, /unterminated/);
            }
            // No-follow metadata walks the namespace parent before the leaf (native ls -l).
            const listed = text(await runtime.tools.bash.execute("ls-l", { command: "ls -l '" + uri + "'", timeout: 10 }));
            assert.doesNotMatch(listed, /Invalid remote artifact URL|No such file/);
            assert.match(listed, /20/);
            const counted = text(await runtime.tools.bash.execute("external", { command: "/usr/bin/wc -c '" + uri + "'", timeout: 10 }));
            assert.match(counted, /^20 /m);
            const missing = text(await runtime.tools.bash.execute("missing", { command: "cat 'remote-artifact://" + namespace + "/999999'", timeout: 10 }));
            assert.doesNotMatch(missing, /real artifact bytes/);
            const literal = text(await runtime.tools.bash.execute("literal", { command: "printf '%s' '" + uri + "'", timeout: 10 }));
            assert(literal.includes(uri));
            assert(!literal.includes(file.path));
            const denied = text(await runtime.tools.bash.execute("read-only", { command: "printf changed > '" + uri + "'", timeout: 10 }));
            assert.match(denied, /read.only|EROFS/i);
            assert.equal(await readFile(file.path, "utf8"), "real artifact bytes\\n");
            assert.equal(await Bun.file(${JSON.stringify(join(temporary, "MARKER"))}).exists(), false);
          } finally { await runtime.dispose(); }
          console.log("artifact-shell-ok");
        `], { cwd: temporary, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        expect(stdout).toContain("artifact-shell-ok");
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  test("a host process building a runtime for metadata fallback never mounts the remote scheme", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "omp-artifact-host-"));
    try {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
        import { createNativeWorkerRuntime } from ${JSON.stringify(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)))};
        const runtime = await createNativeWorkerRuntime(${JSON.stringify(temporary)});
        try { console.log(InternalUrlRouter.instance().getHandler("remote-artifact") === undefined ? "unmounted" : "mounted"); }
        finally { await runtime.dispose(); }
      `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: temporary }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exitCode, stderr, stdout: stdout.trim() }).toEqual({ exitCode: 0, stderr: "", stdout: "unmounted" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("native artifact lookup preserves literal filenames without interpreting shell syntax", async () => {
    mountRemoteArtifactScheme();
    const file = await artifact();
    const unsafe = join(dirname(file.path), `${file.id}.log'; touch MARKER; #`);
    await rm(file.path);
    await writeFile(unsafe, "not an artifact filename");
    expect(await resolveRemoteArtifactArgs("read", { path: file.uri })).toEqual({ path: file.uri });
    expect(await InternalUrlRouter.instance().locate(file.uri)).toBe(unsafe);
  });
});
