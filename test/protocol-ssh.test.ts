import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrames,
  parseMessage,
  parseRequest,
  type Request,
} from "../src/protocol.ts";
import {
  buildSshBaseCommand,
  buildScpBaseCommand,
  buildSshWorkerCommand,
  getScpDestination,
  getSshDestination,
  quoteRemoteArgument,
} from "../src/ssh.ts";
import { discoverSshConfigAliases, parseConnectArgs, parseConnectOptions } from "../src/connect-options.ts";

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

describe("protocol boundaries", () => {
  test("decodes frames across arbitrary chunks", async () => {
    const frames: string[] = [];
    for await (const frame of decodeFrames(
      chunks('{"type":"shutdown"', "}\n", '{"type":"cancel","id":"1"}\n'),
    )) {
      frames.push(frame);
    }
    expect(frames.map(parseRequest)).toEqual([
      { type: "shutdown" },
      { type: "cancel", id: "1" },
    ]);
  });

  test("rejects oversized unterminated frames", async () => {
    const consume = async () => {
      for await (const _frame of decodeFrames(
        chunks("x".repeat(MAX_FRAME_BYTES + 1)),
      )) {
        // No complete frame is expected.
      }
    };
    await expect(consume()).rejects.toThrow("exceeds");
  });

  test("rejects malformed request and response shapes", () => {
    expect(() => parseRequest('{"type":"execute","id":1}')).toThrow();
    expect(() => parseMessage('{"type":"result","id":"1"}')).toThrow(
      "missing result",
    );

  });
  test("readiness steering is distinct from cancellation and validated", () => {
    expect(parseRequest({ type: "steer", id: "service-call" })).toEqual({ type: "steer", id: "service-call" });
    const execute = { type: "execute" as const, id: "service-call", toolCallId: "call", tool: "bash", args: {}, steering: true };
    expect(parseRequest(execute)).toEqual(execute);
    expect(() => parseRequest({ ...execute, steering: "true" })).toThrow("steering must be a boolean");
    expect(() => parseRequest({ type: "steer", id: 1 })).toThrow();
  });
  test("instance-scoped service stops require explicit identities", () => {
    const request = { type: "service-stop", id: "stop-1", name: "service-1", instanceId: "generation-1" } satisfies Request;
    expect(parseRequest(request)).toEqual(request);
    for (const patch of [{ name: "" }, { name: "../wrong" }, { instanceId: "" }, { instanceId: " " }, { instanceId: 1 }, { id: "" }, { id: undefined }])
      expect(() => parseRequest({ ...request, ...patch })).toThrow();
  });
  test("session owner is optional, nonblank when explicit, and preserved verbatim", () => {
    const request = { type: "initialize", protocolVersion: PROTOCOL_VERSION, runtimeVersion: "test", cwd: "/tmp", tools: [] };
    expect(parseRequest(request)).not.toHaveProperty("sessionId");
    expect(parseRequest({ ...request, sessionId: " owner " })).toHaveProperty("sessionId", " owner ");
    for (const sessionId of ["", " ", 7, null])
      expect(() => parseRequest({ ...request, sessionId })).toThrow("sessionId");
  });
});

describe("SSH command safety", () => {
  test("quotes remote worker paths as one shell argument", () => {
    expect(quoteRemoteArgument("/tmp/worker path'quoted")).toBe(
      "'/tmp/worker path'\"'\"'quoted'",
    );
  });

  test("forces strict non-forwarding SSH options", () => {
    const ssh = buildSshWorkerCommand({
      target: "user@example.com",
      workerPath: "/srv/worker",
    });
    const scp = buildScpBaseCommand({ target: "user@example.com" });
    for (const command of [ssh, scp]) {
      expect(command).toContain("StrictHostKeyChecking=yes");
      expect(command).toContain("BatchMode=yes");
      expect(command).toContain("IdentitiesOnly=yes");
      expect(command).toContain("ForwardAgent=no");
      expect(command).toContain("ClearAllForwardings=yes");
    }
  });

  test("uses alias matching while pinning the resolved host and explicit options", () => {
    const request = parseConnectArgs("gpu-box /srv/project --port 2200 --identity /keys/override", [{
      name: "gpu-box", host: "resolved.example.com", username: "developer", port: 2222, keyPath: "/keys/configured",
    }]);
    const connection = { ...request, workerPath: "/srv/worker" };
    const ssh = buildSshWorkerCommand(connection);
    const scp = buildScpBaseCommand(connection);
    expect(request.target).toBe("developer@resolved.example.com");
    expect(request.cwd).toBe("/srv/project");
    expect(ssh.at(-2)).toBe("developer@gpu-box");
    expect(getSshDestination(connection)).toBe("developer@gpu-box");
    for (const command of [ssh, scp]) {
      expect(command).toContain("HostName=resolved.example.com");
      expect(command).toContain("/keys/override");
      expect(command).not.toContain("/keys/configured");
      expect(command[command.indexOf("-i") + 1]).toBe("/keys/override");
    }
    expect(ssh[ssh.indexOf("-p") + 1]).toBe("2200");
    expect(scp[scp.indexOf("-P") + 1]).toBe("2200");
    expect(getSshDestination({ target: "resolved.example.com", sshAlias: "gpu-box" })).toBe("gpu-box");
  });

  test.skipIf(!Bun.which("ssh"))("OpenSSH resolves Include, Match, and multi-pattern aliases without plugin overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-native-alias-"));
    try {
      const config = join(directory, "config");
      const included = join(directory, "included.conf");
      await writeFile(included, [
        "Host include-box included-only",
        "  HostName included.example.com",
        "  User include-user",
        "  Port 2201",
        "  IdentityFile /keys/included",
        "  ProxyJump relay.example.com",
      ].join("\n"));
      const text = [
        `Include "${included}"`,
        'Host include-box "match-box" multi-box *.example.com !excluded',
        "  ProxyJump relay.example.com",
        "Match originalhost match-box,multi-box",
        "  HostName matched.example.com",
        "  User match-user",
        "  Port 2202",
        "  IdentityFile /keys/matched",
        "Host *",
        "  HostName fallback.example.com",
      ].join("\n");
      await writeFile(config, text);
      const aliases = discoverSshConfigAliases(text);
      expect(aliases).toEqual([{ name: "include-box" }, { name: "match-box" }, { name: "multi-box" }]);
      for (const name of ["include-box", "match-box", "multi-box", "included-only"]) {
        const request = parseConnectArgs(name, aliases);
        expect(request).toEqual({ target: name, displayTarget: name });
        const ssh = buildSshWorkerCommand({ ...request, workerPath: "/srv/worker" });
        const scp = buildScpBaseCommand(request);
        expect(ssh.at(-2)).toBe(name);
        expect(getScpDestination(request)).toBe(name);
        for (const command of [ssh, scp]) {
          expect(command.some(argument => /^(HostName|User|Port|IdentityFile)=/.test(argument))).toBe(false);
          for (const flag of ["-p", "-P", "-i"]) expect(command).not.toContain(flag);
        }
        const result = spawnSync("ssh", ["-G", "-F", config, ...buildSshBaseCommand(request).slice(1), getSshDestination(request)], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        const isIncluded = name === "include-box" || name === "included-only";
        expect(result.stdout).toContain(`hostname ${isIncluded ? "included" : "matched"}.example.com\n`);
        expect(result.stdout).toContain(`user ${isIncluded ? "include" : "match"}-user\n`);
        expect(result.stdout).toContain(`port ${isIncluded ? 2201 : 2202}\n`);
        expect(result.stdout).toContain(`identityfile /keys/${isIncluded ? "included" : "matched"}\n`);
        expect(result.stdout).toContain("proxyjump relay.example.com\n");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("shares target grammar and formats IPv6 separately for SSH and SCP argv", () => {
    for (const [target, sshDestination, scpDestination] of [
      ["developer+ci@example.com", "developer+ci@example.com", "developer+ci@example.com"],
      ["192.0.2.10", "192.0.2.10", "192.0.2.10"],
      ["[2001:db8::1]", "2001:db8::1", "[2001:db8::1]"],
      ["2001:db8::1", "2001:db8::1", "[2001:db8::1]"],
      ["developer+ci@[2001:db8::1]", "developer+ci@2001:db8::1", "developer+ci@[2001:db8::1]"],
      ["developer+ci@2001:db8::1", "developer+ci@2001:db8::1", "developer+ci@[2001:db8::1]"],
    ] as const) {
      const request = parseConnectOptions({ target });
      expect(parseConnectArgs(target)).toEqual(request);
      const ssh = buildSshWorkerCommand({ ...request, workerPath: "/srv/worker" });
      const scp = [...buildScpBaseCommand(request), "/local/worker", `${getScpDestination(request)}:${quoteRemoteArgument("/remote/worker")}`];
      expect(ssh.at(-2)).toBe(sshDestination);
      expect(scp.at(-1)).toBe(`${scpDestination}:'/remote/worker'`);
      expect(ssh.some(argument => argument.startsWith("HostName="))).toBe(false);
    }
    const request = parseConnectArgs("ipv6-box", [{ name: "ipv6-box", host: "[2001:db8::1]", username: "developer+ci" }]);
    expect(buildSshWorkerCommand({ ...request, workerPath: "/srv/worker" })).toContain("HostName=2001:db8::1");
    expect(getScpDestination(request)).toBe("developer+ci@ipv6-box");
  });

  test("rejects the same injection and malformed targets at parse and transport boundaries", () => {
    for (const target of ["", "-host", "user@-host", "-user@host", "host --port 22", "host\nother", "host\0other", "host\x7fother", "host;command", "host|command", "$(command)", "`command`", "host/path", "host:22", "user@@host", "[example.com]", "[192.0.2.10]", "[::1", "::1]", "user@", "@host"]) {
      const message = `Invalid SSH target: ${target}`;
      expect(() => parseConnectOptions({ target })).toThrow(message);
      expect(() => buildSshWorkerCommand({ target, workerPath: "/srv/worker" })).toThrow(message);
      expect(() => buildScpBaseCommand({ target })).toThrow(message);
      expect(() => getScpDestination({ target })).toThrow(message);
    }
  });

  test.skipIf(!Bun.which("ssh"))("retains native ProxyCommand and ProxyJump with configured destination precedence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-alias-config-"));
    try {
      const config = join(directory, "config");
      const identity = join(directory, "identity");
      await writeFile(identity, "", { mode: 0o600 });
      await writeFile(config, [
        "Host proxy-box",
        "  ProxyCommand nc -x 127.0.0.1:1080 %h %p",
        "Host jump-box",
        "  ProxyJump relay.example.com",
        "Host *",
        "  HostName ssh-config.example.com",
        "  User ssh-config-user",
        "  Port 2222",
        "",
      ].join("\n"));
      for (const name of ["proxy-box", "jump-box"]) {
        const request = parseConnectArgs(`${name} --port 2200 --identity ${identity}`, [{
          name, host: "resolved.example.com", username: "developer",
        }]);
        const result = spawnSync("ssh", [
          "-G", "-F", config, ...buildSshBaseCommand(request).slice(1), getSshDestination(request),
        ], { encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("hostname resolved.example.com\n");
        expect(result.stdout).toContain("user developer\n");
        expect(result.stdout).toContain("port 2200\n");
        expect(result.stdout).toContain(`identityfile ${identity}\n`);
        expect(result.stdout).toContain(name === "proxy-box"
          ? "proxycommand nc -x 127.0.0.1:1080 %h %p\n"
          : "proxyjump relay.example.com\n");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("leaves raw SSH targets unchanged without adding HostName overrides", () => {
    for (const target of ["developer@host", "192.0.2.10", "unconfigured-alias"]) {
      const ssh = buildSshWorkerCommand({ target, workerPath: "/srv/worker" });
      expect(ssh.at(-2)).toBe(target);
      expect(ssh.some(argument => argument.startsWith("HostName="))).toBe(false);
    }
  });

  test("rejects aliases that can change SSH destination or options", () => {
    for (const sshAlias of ["", "-oProxyCommand=evil", "other@host", "host;touch /tmp/pwn", "host\nHostName other"]) {
      const options = { target: "developer@resolved.example.com", sshAlias, workerPath: "/srv/worker" };
      expect(() => buildSshWorkerCommand(options)).toThrow("Invalid SSH");
      expect(() => buildScpBaseCommand(options)).toThrow("Invalid SSH");
    }
    expect(() => buildScpBaseCommand({ target: "host\nProxyCommand evil", sshAlias: "safe" })).toThrow("Invalid SSH target");
  });

  test("rejects unsafe targets and multiline remote arguments", () => {
    expect(() =>
      buildSshWorkerCommand({
        target: "host;touch /tmp/pwn",
        workerPath: "/tmp/worker",
      }),
    ).toThrow("Invalid SSH target");
    expect(() => quoteRemoteArgument("/tmp/worker\ncommand")).toThrow(
      "cannot contain",
    );
  });
});
