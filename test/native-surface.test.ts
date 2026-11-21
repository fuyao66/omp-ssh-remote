import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

const classification = `Classify each delta before updating test/fixtures/native-surface.json: add workspace operations to the remote tool set, block local execution in src/omp/input-policy.ts, or confirm the entry does not affect the remote workspace boundary. Do not accept the snapshot change alone.`;

async function collectSurface(): Promise<Record<string, string[]>> {
  // Load native modules only in the collector subprocess: some install process-global hooks on import.
  const { BUILTIN_TOOLS, HIDDEN_TOOLS } = await import("@oh-my-pi/pi-coding-agent/tools");
  const { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
  const { InternalUrlRouter } = await import("@oh-my-pi/pi-coding-agent/internal-urls/router");
  const { lspSchema } = await import("@oh-my-pi/pi-coding-agent/lsp/types");
  const { createAutoresearchExtension } = await import("@oh-my-pi/pi-coding-agent/autoresearch");
  type ExtensionApi = Parameters<typeof createAutoresearchExtension>[0];
  const autoresearchTools: string[] = [];
  const autoresearchCommands: string[] = [];
  const autoresearchShortcuts: string[] = [];
  // Run the native registration factory, not its handlers. A new API call must
  // be audited rather than silently ignored by a catch-all proxy.
  const registration = {
    registerTool: (tool: { name: string }) => { autoresearchTools.push(tool.name); },
    registerCommand: (name: string) => { autoresearchCommands.push(name); },
    registerShortcut: (key: string) => { autoresearchShortcuts.push(key); },
    on() {},
  } satisfies Pick<ExtensionApi, "registerTool" | "registerCommand" | "registerShortcut" | "on">;
  await createAutoresearchExtension(registration as unknown as ExtensionApi);

  const schema = lspSchema.toJsonSchema() as { properties?: { action?: { enum?: unknown } } };
  const lspActions = schema.properties?.action?.enum;
  if (!Array.isArray(lspActions) || !lspActions.length || lspActions.some(action => typeof action !== "string")) {
    throw new Error("Native LSP action schema is no longer a string enum; audit and update its collector.");
  }
  return {
    builtinTools: Object.keys(BUILTIN_TOOLS).sort(),
    hiddenTools: Object.keys(HIDDEN_TOOLS).sort(),
    builtinSlashCommands: [...BUILTIN_SLASH_COMMAND_RESERVED_NAMES].sort(),
    internalUrlSchemes: [...new InternalUrlRouter().specs().keys()].sort(),
    lspActions: lspActions.sort(),
    autoresearchTools: autoresearchTools.sort(),
    autoresearchCommands: autoresearchCommands.sort(),
    autoresearchShortcuts: autoresearchShortcuts.sort(),
  };
}

if (import.meta.main && process.argv.includes("--collect")) {
  console.log(JSON.stringify(await collectSurface()));
} else {
  test("native execution surface matches the classified snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-native-surface-"));
    try {
      const child = Bun.spawn([process.execPath, import.meta.path, "--collect"], {
        cwd: directory, env: { HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PATH: Bun.env.PATH },
        stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(`Could not collect native execution surfaces (${exitCode}):\n${stderr}\n${classification}`);
      const actual = JSON.parse(stdout) as Record<string, string[]>;
      const expected = JSON.parse(await readFile(join(import.meta.dir, "fixtures/native-surface.json"), "utf8")) as Record<string, string[]>;
      const deltas: string[] = [];
      for (const surface of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const before = expected[surface];
        const after = actual[surface];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const added = (after ?? []).filter(name => !before?.includes(name));
        const removed = (before ?? []).filter(name => !after?.includes(name));
        const change = [...added.map(name => `  + ${name}`), ...removed.map(name => `  - ${name}`)];
        deltas.push(`${surface}:\n${change.join("\n") || "  snapshot category, order, or multiplicity differs"}`);
      }
      if (deltas.length) throw new Error(`Unclassified native execution surface changes:\n${deltas.join("\n")}\n${classification}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
