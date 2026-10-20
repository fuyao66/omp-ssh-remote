import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createRemoteArtifacts, type RemoteArtifacts } from "../src/omp/artifacts.ts";
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
  test("read resolves only its leading resource and preserves selector/query literals", async () => {
    const file = await artifact();
    const query = `?q=.uri==${JSON.stringify(file.uri)}`;
    const input = { path: file.uri + query, extra: file.uri };
    expect(await resolveRemoteArtifactArgs("read", input)).toEqual({ path: file.path + query, extra: file.uri });
    expect(input.path).toBe(file.uri + query);
    expect(await resolveRemoteArtifactArgs("read", { path: file.uri + ":raw:2-4" })).toEqual({ path: file.path + ":raw:2-4" });
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

  test("preserves the established bash artifact-operand shorthand", async () => {
    const file = await artifact();
    expect(await resolveRemoteArtifactArgs("bash", { command: `cat '${file.uri}'`, i: file.uri })).toEqual({ command: `cat '${file.path}'`, i: file.uri });
    const plain = { command: "printf plain" };
    expect(await resolveRemoteArtifactArgs("bash", plain)).toBe(plain);
  });
});
