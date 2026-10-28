import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildPruneAndAuditWorkersCommand, describeRemoteWorkerCacheAudit, parseRemoteWorkerCacheAudit, SUPPORTED_PLATFORMS } from "../src/deploy.ts";

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
  else if (script.startsWith("timeout ") && home.includes("'")) { console.error("forced audit failure"); process.exit(1); }
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
const prepared = await prepareRemoteWorker(options, bundle);
if (prepared.cacheAudit.available || !prepared.cacheAudit.warning.includes("unavailable")) throw new Error("Malformed audit must not fail connection or report zero usage");
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

describe("remote deployment audit transport", () => {
  test("production deployment quotes and executes the bounded audit script through SSH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-audit-transport-"));
    try {
      const home = join(directory, "home ' spaces; literal");
      const version = "a".repeat(64);
      const worker = join(directory, "worker-linux-x64");
      const namespace = join(home, ".cache", "omp-ssh-remote", "omp-1");
      await mkdir(join(namespace, version), { recursive: true });
      await writeFile(join(namespace, version, "worker-linux-x64"), "cached worker fixture");
      await writeFile(worker, "local worker fixture");
      await writeFile(`${worker}.sha256`, version);
      await writeFile(join(directory, "ssh"), `#!${process.execPath}
import { spawnSync } from "node:child_process";
const script = process.argv.at(-1);
if (script.includes("uname -s")) console.log("Linux\\nx86_64\\n" + ${JSON.stringify(home)});
else if (script.startsWith("test -x ")) console.log("present");
else if (script.startsWith("timeout ")) {
  if (script.includes("\\n")) throw new Error("Audit transport command must be single-line");
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 10000 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
} else throw new Error("Unexpected SSH script: " + script);
`, { mode: 0o700 });
      const runner = join(directory, "runner.ts");
      await writeFile(runner, `
import { prepareRemoteWorker } from ${JSON.stringify(new URL("../src/deploy.ts", import.meta.url).href)};
const result = await prepareRemoteWorker({ target: "fixture.example", localWorkerPath: ${JSON.stringify(worker)} });
if (!result.cacheAudit.available) throw new Error(JSON.stringify(result.cacheAudit));
console.log(JSON.stringify(result.cacheAudit));
`);
      const result = spawnSync(process.execPath, ["run", runner], { encoding: "utf8", timeout: 20000, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({ available: true, current: { namespace: "omp-1", versions: 1, binaryFiles: 1, allocatedBytes: (await stat(join(namespace, version, "worker-linux-x64"))).blocks * 512 }, retainedOld: { versions: 0, binaryFiles: 0, allocatedBytes: 0 }, legacy: [] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("remote worker cache audit", () => {
  const hash = (character: string) => character.repeat(64);
  test("prunes only unprotected stale builds and accounts shallow allocated binaries in current and legacy namespaces", async () => {
    const base = await mkdtemp(join(tmpdir(), "worker audit ' spaces "));
    const ns = join(base, "omp-1");
    let holder: ReturnType<typeof Bun.spawn> | undefined;
    try {
      for (const character of ["a", "b", "c", "d"]) {
        await mkdir(join(ns, hash(character)), { recursive: true });
        await writeFile(join(ns, hash(character), "worker-linux-x64"), character.repeat(8192));
      }
      const sparse = join(ns, hash("d"), "worker-linux-x64");
      await truncate(sparse, 64 * 1024 * 1024);
      const legacy = join(base, "17.3.3", hash("e"));
      await mkdir(legacy, { recursive: true });
      for (const binary of ["worker", "worker-linux-x64"]) await writeFile(join(legacy, binary), binary.repeat(1024));
      await symlink("worker", join(legacy, "worker-linux-arm64"));
      await mkdir(join(base, "omp-old", hash("f")), { recursive: true });
      await writeFile(join(base, "omp-old", hash("f"), "worker-linux-arm64"), "old companion");
      await mkdir(join(base, "pi", hash("a")), { recursive: true });
      await writeFile(join(base, "pi", hash("a"), "worker"), "not OMP");
      await mkdir(join(ns, "shared-assets"), { recursive: true });
      await writeFile(join(ns, "shared-assets", "worker"), "not a worker version");
      holder = Bun.spawn(["flock", "-F", "-s", join(ns, hash("a"), ".worker.lock"), "sh", "-c", "printf READY; read line"], { stdin: "pipe", stdout: "pipe" });
      const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("READY");
      for (const [index, character] of ["a", "b", "c", "d"].entries()) {
        await utimes(join(ns, hash(character)), new Date(1000 * (index + 1)), new Date(1000 * (index + 1)));
      }
      const result = spawnSync("sh", ["-c", buildPruneAndAuditWorkersCommand(ns, hash("d"))], { encoding: "utf8", timeout: 10_000 });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      const audit = parseRemoteWorkerCacheAudit(result.stdout.trim(), "omp-1");
      expect(audit.available).toBe(true);
      if (!audit.available) throw new Error(audit.warning);
      const allocated = async (paths: string[]) => (await Promise.all(paths.map(async path => (await stat(path)).blocks * 512))).reduce((sum, bytes) => sum + bytes, 0);
      const oldPaths = ["a", "c"].map(character => join(ns, hash(character), "worker-linux-x64"));
      expect(audit.current).toEqual({ namespace: "omp-1", versions: 3, binaryFiles: 3, allocatedBytes: await allocated([...oldPaths, sparse]) });
      expect(audit.retainedOld).toEqual({ versions: 2, binaryFiles: 2, allocatedBytes: await allocated(oldPaths) });
      expect(audit.current.allocatedBytes).toBeLessThan((await stat(sparse)).size);
      expect(audit.legacy).toEqual([
        { namespace: "17.3.3", versions: 1, binaryFiles: 2, allocatedBytes: await allocated([join(legacy, "worker"), join(legacy, "worker-linux-x64")]) },
        { namespace: "omp-old", versions: 1, binaryFiles: 1, allocatedBytes: await allocated([join(base, "omp-old", hash("f"), "worker-linux-arm64")]) },
      ]);
      expect((await readdir(ns)).sort()).toEqual([hash("a"), hash("c"), hash("d"), "shared-assets"]);
      expect((await readdir(legacy)).sort()).toEqual(["worker", "worker-linux-arm64", "worker-linux-x64"]);
      expect(describeRemoteWorkerCacheAudit(audit)).toContain("not total cache usage");
      expect(describeRemoteWorkerCacheAudit(audit)).toContain("may still be in use");
    } finally {
      holder?.kill();
      if (holder) await holder.exited;
      await rm(base, { recursive: true, force: true });
    }
  });

  test("missing cache reports an empty scoped snapshot", async () => {
    const base = await mkdtemp(join(tmpdir(), "worker-audit-missing-"));
    try {
      const result = spawnSync("sh", ["-c", buildPruneAndAuditWorkersCommand(join(base, "absent", "omp-1"), hash("a"))], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(parseRemoteWorkerCacheAudit(result.stdout.trim(), "omp-1")).toMatchObject({ available: true, current: { versions: 0, binaryFiles: 0, allocatedBytes: 0 }, retainedOld: { versions: 0, binaryFiles: 0, allocatedBytes: 0 }, legacy: [] });
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  test("stat failure cannot become a successful zero usage report", async () => {
    const base = await mkdtemp(join(tmpdir(), "worker-audit-failed-"));
    try {
      const ns = join(base, "omp-1");
      await mkdir(join(ns, hash("a")), { recursive: true });
      await writeFile(join(ns, hash("a"), "worker"), "fixture");
      await writeFile(join(base, "stat"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const result = spawnSync("sh", ["-c", buildPruneAndAuditWorkersCommand(ns, hash("a"))], { encoding: "utf8", env: { ...process.env, PATH: `${base}:${process.env.PATH}` } });
      expect(result.status).not.toBe(0);
      expect(() => parseRemoteWorkerCacheAudit(result.stdout.trim(), "omp-1")).toThrow();
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  test.each(["", "current\tomp-1\t1\t1\tgarbage\t0\t0\t0", "current\tomp-1\t0\t0\t0\t1\t0\t0", "current\tother\t0\t0\t0\t0\t0\t0", "current\tomp-1\t0\t0\t9007199254740992\t0\t0\t0"])("rejects incomplete or invalid audit output %s", output => {
    expect(() => parseRemoteWorkerCacheAudit(output, "omp-1")).toThrow();
  });
});
