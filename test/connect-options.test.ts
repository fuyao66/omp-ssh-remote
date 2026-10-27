import { describe, expect, test } from "bun:test";
import {
  mergeConfiguredSshHosts,
  parseConnectArgs,
  parseConnectOptions,
  type ConfiguredSshHost,
} from "../src/connect-options.ts";

const gpuBox: ConfiguredSshHost = {
  name: "gpu-box",
  host: "remote.example.com",
  username: "developer",
  port: 2222,
  keyPath: "~/.ssh/gpu-box.pem",
};

describe("remote connection aliases", () => {
  test("connects by OMP SSH host name and defaults cwd later", () => {
    expect(parseConnectArgs("gpu-box", [gpuBox])).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "gpu-box",
      sshAlias: "gpu-box",
      port: 2222,
      identityFile: "~/.ssh/gpu-box.pem",
    });
  });

  test("accepts a project directory after the host name", () => {
    expect(parseConnectArgs("gpu-box /srv/project", [gpuBox])).toMatchObject({
      target: "developer@remote.example.com",
      displayTarget: "gpu-box",
      sshAlias: "gpu-box",
      cwd: "/srv/project",
    });
  });

  test("explicit flags override saved host settings", () => {
    expect(
      parseConnectArgs(
        "gpu-box /srv/project --port 2200 --identity ~/.ssh/override --known-hosts ~/.ssh/project_hosts",
        [gpuBox],
      ),
    ).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "gpu-box",
      sshAlias: "gpu-box",
      cwd: "/srv/project",
      port: 2200,
      identityFile: "~/.ssh/override",
      knownHostsFile: "~/.ssh/project_hosts",
    });
  });

  test("preserves the explicit legacy connection form", () => {
    expect(
      parseConnectArgs(
        "developer@remote.example.com /srv/project --port 2222 --identity ~/.ssh/key",
      ),
    ).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "developer@remote.example.com",
      cwd: "/srv/project",
      port: 2222,
      identityFile: "~/.ssh/key",
    });
  });

  test("does not reinterpret explicit targets as configured alias names", () => {
    for (const requestedTarget of ["developer@remote.example.com", "192.0.2.10"]) {
      const misleadingAlias = { ...gpuBox, name: requestedTarget };
      expect(parseConnectArgs(requestedTarget, [misleadingAlias])).toEqual({
        target: requestedTarget,
        displayTarget: requestedTarget,
      });
    }
    expect(parseConnectArgs("remote.example.com", [gpuBox])).toEqual({
      target: "remote.example.com",
      displayTarget: "remote.example.com",
    });
  });

  test("keeps the configured destination when an OMP alias overrides SSH config", () => {
    const project = { ...gpuBox, host: "project.example.com", username: "project-user" };
    const sshConfig = { ...gpuBox, host: "ssh-config.example.com", username: "ssh-user" };
    const configured = mergeConfiguredSshHosts([project], [], [sshConfig]);
    expect(parseConnectArgs("gpu-box", configured)).toMatchObject({
      target: "project-user@project.example.com",
      sshAlias: "gpu-box",
    });
  });

  test("project aliases override same-name user aliases", () => {
    const project = { ...gpuBox, host: "project.example.com" };
    const user = { ...gpuBox, host: "user.example.com" };
    expect(mergeConfiguredSshHosts([project], [user])).toEqual([project]);
  });

  test("rejects invalid positional and option shapes", () => {
    expect(() => parseConnectArgs("")).toThrow("Usage:");
    expect(() => parseConnectArgs("host /a /b")).toThrow("Usage:");
    expect(() => parseConnectArgs("host --port 0")).toThrow("Invalid SSH port");
    expect(() => parseConnectArgs("host --identity")).toThrow("Missing value");
  });

  test("keeps slash-command parsing for quoted paths and explicit flags", () => {
    expect(parseConnectArgs(
      `gpu-box "/srv/my project" --identity '/keys/my key' --port 2200`,
      [gpuBox],
    )).toMatchObject({
      target: "developer@remote.example.com",
      cwd: "/srv/my project",
      identityFile: "/keys/my key",
      port: 2200,
    });
  });
});

describe("structured remote connection options", () => {
  test("uses configured target, identity, and port defaults", () => {
    expect(parseConnectOptions({ target: "gpu-box" }, [gpuBox])).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "gpu-box",
      sshAlias: "gpu-box",
      port: 2222,
      identityFile: "~/.ssh/gpu-box.pem",
    });
  });

  test("preserves spaces and literal quotes in each path field", () => {
    const options = {
      target: "gpu-box",
      cwd: `/srv/a "quoted" project/it's here`,
      identity: `/keys/my "private" key's file`,
      knownHosts: `/keys/known "hosts" file`,
      worker: `/srv/worker's "entry" file`,
    };
    expect(parseConnectOptions(options, [gpuBox])).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "gpu-box",
      sshAlias: "gpu-box",
      cwd: options.cwd,
      port: 2222,
      identityFile: options.identity,
      knownHostsFile: options.knownHosts,
      workerPath: options.worker,
    });
  });

  test("does not interpret CLI-looking path values as options", () => {
    expect(parseConnectOptions({
      target: "gpu-box",
      cwd: "--port 1 --identity /injected/key",
      identity: "--port 2 --worker /injected/worker",
      knownHosts: "--identity",
      worker: "--known-hosts",
    }, [gpuBox])).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "gpu-box",
      sshAlias: "gpu-box",
      cwd: "--port 1 --identity /injected/key",
      port: 2222,
      identityFile: "--port 2 --worker /injected/worker",
      knownHostsFile: "--identity",
      workerPath: "--known-hosts",
    });
  });

  test("retains configured defaults when cwd resembles flags", () => {
    const configured = {
      ...gpuBox,
      keyPath: `/keys/default "key" --port 1`,
    };
    expect(parseConnectOptions({
      target: "gpu-box",
      cwd: "--identity /replacement --port 1",
    }, [configured])).toMatchObject({
      cwd: "--identity /replacement --port 1",
      identityFile: configured.keyPath,
      port: 2222,
    });
  });

  test("overrides configured defaults only with explicit fields", () => {
    expect(parseConnectOptions({
      target: "gpu-box",
      port: 65535,
      identity: "/keys/my key",
    }, [gpuBox])).toMatchObject({
      target: "developer@remote.example.com",
      port: 65535,
      identityFile: "/keys/my key",
    });
    expect(parseConnectOptions({ target: "host", port: 1 }).port).toBe(1);
  });

  test("does not resolve explicit user and IP targets through aliases", () => {
    for (const target of ["developer@remote.example.com", "192.0.2.10", "::1"]) {
      expect(parseConnectOptions({ target }, [{ ...gpuBox, name: target }]))
        .toEqual({ target, displayTarget: target });
    }
    for (const target of ["user@[2001:db8::1]", "user@2001:db8::1"]) {
      expect(parseConnectOptions({ target })).toEqual({
        target,
        displayTarget: target,
      });
    }
  });

  test("rejects invalid targets rather than parsing embedded flags", () => {
    for (const target of [
      undefined, null, 42, "", " ", "--port", "-host", "host --port 22",
      '"host"', "user@", "@host", "user@@host", "user@-host",
      "host:22", "host/path", "host\nother", "host\0other", "host;command",
    ]) {
      expect(() => parseConnectOptions({ target }, [gpuBox]))
        .toThrow("Invalid SSH target");
    }
    expect(() => parseConnectArgs('"host --port 22"'))
      .toThrow("Invalid SSH target");
  });

  test("rejects invalid ports without falling back to configured defaults", () => {
    for (const port of [
      0, -1, 65536, 1.5, NaN, Infinity, null, true, [], {},
      "", " ", "22junk", "1.5", "--identity",
    ]) {
      expect(() => parseConnectOptions({ target: "gpu-box", port }, [gpuBox]))
        .toThrow("Invalid SSH port");
    }
    expect(() => parseConnectArgs("gpu-box --port 65536", [gpuBox]))
      .toThrow("Invalid SSH port");
  });

  test("validates resolved configured destinations and ports", () => {
    expect(() => parseConnectOptions(
      { target: "gpu-box" },
      [{ ...gpuBox, host: "-bad-host" }],
    )).toThrow("Invalid SSH target");
    expect(() => parseConnectOptions(
      { target: "gpu-box" },
      [{ ...gpuBox, port: 65536 }],
    )).toThrow("Invalid SSH port");
  });

  test("rejects non-string path fields", () => {
    for (const field of ["cwd", "identity", "knownHosts", "worker"]) {
      expect(() => parseConnectOptions({ target: "host", [field]: 123 }))
        .toThrow("expected a string");
    }
  });
});
