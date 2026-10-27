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
  getSshDestination,
  quoteRemoteArgument,
} from "../src/ssh.ts";
import { parseConnectArgs } from "../src/connect-options.ts";

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
      expect(() => buildSshWorkerCommand(options)).toThrow("Unsafe SSH alias");
      expect(() => buildScpBaseCommand(options)).toThrow("Unsafe SSH alias");
    }
    expect(() => buildScpBaseCommand({ target: "host\nProxyCommand evil", sshAlias: "safe" })).toThrow("Unsafe SSH target");
  });

  test("rejects unsafe targets and multiline remote arguments", () => {
    expect(() =>
      buildSshWorkerCommand({
        target: "host;touch /tmp/pwn",
        workerPath: "/tmp/worker",
      }),
    ).toThrow("Unsafe SSH target");
    expect(() => quoteRemoteArgument("/tmp/worker\ncommand")).toThrow(
      "cannot contain",
    );
  });
});
