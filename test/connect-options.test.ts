import { describe, expect, test } from "bun:test";
import {
  mergeConfiguredSshHosts,
  parseConnectArgs,
  type ConfiguredSshHost,
} from "../src/connect-options.ts";

const modelarts: ConfiguredSshHost = {
  name: "modelarts",
  host: "remote.example.com",
  username: "developer",
  port: 2222,
  keyPath: "~/.ssh/modelarts.pem",
};

describe("remote connection aliases", () => {
  test("connects by OMP SSH host name and defaults cwd later", () => {
    expect(parseConnectArgs("modelarts", [modelarts])).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "modelarts",
      port: 2222,
      identityFile: "~/.ssh/modelarts.pem",
    });
  });

  test("accepts a project directory after the host name", () => {
    expect(
      parseConnectArgs("modelarts /srv/project", [modelarts]),
    ).toMatchObject({
      target: "developer@remote.example.com",
      displayTarget: "modelarts",
      cwd: "/srv/project",
    });
  });

  test("explicit flags override saved host settings", () => {
    expect(
      parseConnectArgs(
        "modelarts /srv/project --port 2200 --identity ~/.ssh/override --known-hosts ~/.ssh/project_hosts",
        [modelarts],
      ),
    ).toEqual({
      target: "developer@remote.example.com",
      displayTarget: "modelarts",
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

  test("project aliases override same-name user aliases", () => {
    const project = { ...modelarts, host: "project.example.com" };
    const user = { ...modelarts, host: "user.example.com" };
    expect(mergeConfiguredSshHosts([project], [user])).toEqual([project]);
  });

  test("rejects invalid positional and option shapes", () => {
    expect(() => parseConnectArgs("")).toThrow("Usage:");
    expect(() => parseConnectArgs("host /a /b")).toThrow("Usage:");
    expect(() => parseConnectArgs("host --port 0")).toThrow(
      "Invalid SSH port",
    );
    expect(() => parseConnectArgs("host --identity")).toThrow(
      "Missing value",
    );
  });
});
