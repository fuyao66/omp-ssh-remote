import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runScenario(scenario: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-narrow-"));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const temp = join(root, "tmp");
    await Promise.all([home, cwd, temp].map(path => mkdir(path)));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/native-narrow.ts"), scenario], {
      cwd,
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, "agent"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        TMPDIR: temp,
        PATH: process.env.PATH,
        OMP_DAEMON_DIR: join(home, ".cache/omp-ssh-remote-daemon"),
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(40_000),
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${scenario} failed:\n${stdout}${stderr}`).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("renders native proc job and daemon rows after merging listings", () => runScenario("proc-list"), 45_000);
test("recovers and deduplicates images from an async native Bash job", () => runScenario("capture-images"), 45_000);
test("rejects service launch at native job capacity and settles only the matching proc stop generation", () => runScenario("service-stop"), 45_000);
test("uses forwarded direnv mode and timeout in a fresh companion despite project settings", () => runScenario("shell-settings"), 45_000);
