import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SUPPORTED_PLATFORMS } from "../src/deploy.ts";

describe("remote worker platform mapping", () => {
  test("maps Linux/aarch64 to arm64 worker", () => {
    expect(SUPPORTED_PLATFORMS["Linux/aarch64"]).toBe("arm64");
  });

  test("maps Linux/x86_64 to x64 worker", () => {
    expect(SUPPORTED_PLATFORMS["Linux/x86_64"]).toBe("x64");
  });

  test("rejects unsupported platforms", () => {
    expect(SUPPORTED_PLATFORMS["Darwin/arm64"]).toBeUndefined();
    expect(SUPPORTED_PLATFORMS["Linux/riscv64"]).toBeUndefined();
  });
});

describe("remote deployment alias transport", () => {
  test.each(["/home/developer", "/home/developer's workspace; literal"])("uses the selected alias and shell-quoted SCP paths (%s)", async (home) => {
    const directory = await mkdtemp(join(tmpdir(), "omp-deploy-alias-"));
    try {
      const log = join(directory, "commands.jsonl");
      const failActivation = join(directory, "fail-activation");
      const worker = join(directory, "worker-linux-x64");
      await writeFile(worker, "fixture worker");
      await writeFile(join(directory, "companion-x64"), "fixture companion");
      const fakeTransport = `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, ...args]) + "\\n");
const home = ${JSON.stringify(home)};
if (command === "ssh") {
  const script = args.at(-1);
  if (script.includes("uname -s")) console.log("Linux\\nx86_64\\n" + home);
  else if (script.includes('printf') && script.includes('"$HOME"')) console.log(home);
  else if (script.startsWith("test -x ")) console.log("missing");
  else if (script.startsWith("set -eu; actual=") && existsSync(${JSON.stringify(failActivation)})) {
    console.error("forced activation failure");
    process.exit(1);
  }
}
if (command === "scp") {
  const remotePath = args.at(-1).slice(args.at(-1).indexOf(":") + 1);
  // Model the protocol boundary: SFTP keeps quotes literal; SCP invokes a shell.
  const parsed = args.includes("-O")
    ? spawnSync("/bin/sh", ["-c", 'printf "%s" ' + remotePath], { encoding: "utf8" })
    : { status: 0, stdout: remotePath };
  if (parsed.status !== 0 || !parsed.stdout.startsWith(home + "/.cache/omp-ssh-remote/alias-test/")) {
    console.error("Upload path did not survive the selected transfer protocol: " + remotePath);
    process.exit(1);
  }
}
`;
      for (const command of ["ssh", "scp"]) {
        const path = join(directory, command);
        await writeFile(path, fakeTransport);
        await chmod(path, 0o700);
      }
      const options = {
        target: "developer@resolved.example.com", sshAlias: "gpu-box", port: 2200,
        identityFile: "/keys/override", localWorkerPath: worker, localArtifactDir: directory,
      };
      const runner = join(directory, "runner.ts");
      await writeFile(runner, `
import { prepareRemoteWorker, resolveRemoteHome } from ${JSON.stringify(new URL("../src/deploy.ts", import.meta.url).href)};
import { writeFile } from "node:fs/promises";
const options = ${JSON.stringify(options)};
const bundle = { cacheNamespace: "alias-test", companionArtifacts: [{ id: "fixture", filePrefix: "companion", executableName: "fixture" }] };
const home = await resolveRemoteHome(options);
if (home !== ${JSON.stringify(home)}) throw new Error("Unexpected home: " + home);
await prepareRemoteWorker(options, bundle);
await writeFile(${JSON.stringify(failActivation)}, "fail");
let rejected = false;
try { await prepareRemoteWorker(options, bundle); }
catch (error) {
  if (!String(error).includes("Worker activation failed")) throw error;
  rejected = true;
}
if (!rejected) throw new Error("Expected worker activation to fail");
`);
      // Isolate PATH in the child so no other test can use the fake transports.
      const result = spawnSync(process.execPath, ["run", runner], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        encoding: "utf8", timeout: 30_000,
      });
      expect({ status: result.status, stderr: result.stderr, error: result.error?.message }).toEqual({
        status: 0, stderr: "", error: undefined,
      });
      const commands = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
      expect(commands.length).toBeGreaterThan(15);
      expect(commands.filter(command => command[0] === "scp")).toHaveLength(3);
      for (const command of commands) {
        expect(command[command.indexOf("HostName=resolved.example.com") - 1]).toBe("-o");
        expect(command[command.indexOf("-i") + 1]).toBe("/keys/override");
        if (command[0] === "ssh") {
          expect(command.at(-2)).toBe("developer@gpu-box");
          expect(command[command.indexOf("-p") + 1]).toBe("2200");
        } else {
          expect(command.at(-1)).toStartWith("developer@gpu-box:");
          expect(command[command.indexOf("-P") + 1]).toBe("2200");
          expect(command).toContain("-O");
        }
      }
      expect(commands.some(command => command.at(-1)?.startsWith("rm -f -- "))).toBe(true);
      expect(commands.some(command => command.at(-1)?.startsWith("ln -sf "))).toBe(true);
      expect(commands.some(command => command.at(-1)?.includes(".worker.lock"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
