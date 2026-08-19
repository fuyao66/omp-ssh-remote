import { readFile } from "node:fs/promises";
import { join } from "node:path";

function getSSHConfigPath(scope: "project" | "user", cwd = process.cwd()): string {
  const home = process.env.HOME || "/root";
  return scope === "project"
    ? join(cwd, ".omp/ssh.json")
    : join(home, ".omp/agent/ssh.json");
}
export type RemoteConnectRequest = {
  target: string;
  displayTarget: string;
  cwd?: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
  workerPath?: string;
};

export type ConfiguredSshHost = {
  name: string;
  host: string;
  username?: string;
  port?: number;
  keyPath?: string;
};

type RawSshHost = {
  host?: unknown;
  username?: unknown;
  port?: unknown;
  key?: unknown;
  keyPath?: unknown;
};

const USAGE =
  "Usage: /remote-connect <ssh-name|user@host> [remote-cwd] [--port N] [--identity path] [--known-hosts path] [--worker path]";

function tokenize(args: string): string[] {
  return (
    args
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((token) => token.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")) ?? []
  );
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeHost(
  name: string,
  value: unknown,
  sourcePath: string,
): ConfiguredSshHost {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid SSH host ${JSON.stringify(name)} in ${sourcePath}`);
  }
  const raw = value as RawSshHost;
  const host = optionalString(raw.host);
  if (!host) {
    throw new Error(
      `SSH host ${JSON.stringify(name)} in ${sourcePath} is missing host`,
    );
  }
  const port = parsePort(raw.port);
  if (raw.port !== undefined && port === undefined) {
    throw new Error(
      `SSH host ${JSON.stringify(name)} in ${sourcePath} has an invalid port`,
    );
  }
  return {
    name,
    host,
    ...(optionalString(raw.username)
      ? { username: optionalString(raw.username) }
      : {}),
    ...(port ? { port } : {}),
    ...(optionalString(raw.keyPath ?? raw.key)
      ? { keyPath: optionalString(raw.keyPath ?? raw.key) }
      : {}),
  };
};

async function readHostFile(path: string): Promise<ConfiguredSshHost[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse OMP SSH config JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON root in OMP SSH config: ${path}`);
  }
  const hosts = (parsed as { hosts?: unknown }).hosts;
  if (hosts === undefined) return [];
  if (typeof hosts !== "object" || hosts === null || Array.isArray(hosts)) {
    throw new Error(`Invalid hosts object in OMP SSH config: ${path}`);
  }
  return Object.entries(hosts).map(([name, value]) =>
    normalizeHost(name, value, path),
  );
}
async function readSshConfigFile(configPath: string): Promise<ConfiguredSshHost[]> {
  try {
    const text = await readFile(configPath, "utf8");
    const hosts: ConfiguredSshHost[] = [];
    let currentHost: Partial<ConfiguredSshHost> | null = null;

    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      const key = parts[0]?.toLowerCase();
      const val = parts.slice(1).join(" ");

      if (key === "host") {
        if (currentHost?.name && currentHost.host) {
          hosts.push(currentHost as ConfiguredSshHost);
        }
        if (val && !val.includes("*") && !val.includes("?")) {
          currentHost = { name: val, host: val };
        } else {
          currentHost = null;
        }
      } else if (currentHost) {
        if (key === "hostname") currentHost.host = val;
        else if (key === "user") currentHost.username = val;
        else if (key === "port") currentHost.port = parsePort(val);
        else if (key === "identityfile") currentHost.keyPath = val.replace(/^~/, process.env.HOME || "");
      }
    }
    if (currentHost?.name && currentHost.host) {
      hosts.push(currentHost as ConfiguredSshHost);
    }
    return hosts;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return [];
  }
}

export function mergeConfiguredSshHosts(
  projectHosts: readonly ConfiguredSshHost[],
  userHosts: readonly ConfiguredSshHost[],
  sshConfigHosts: readonly ConfiguredSshHost[] = [],
): ConfiguredSshHost[] {
  const merged = new Map<string, ConfiguredSshHost>();
  for (const host of [...projectHosts, ...userHosts, ...sshConfigHosts]) {
    if (!merged.has(host.name)) merged.set(host.name, host);
  }
  return [...merged.values()];
}

export async function loadConfiguredSshHosts(
  cwd: string,
): Promise<ConfiguredSshHost[]> {
  const home = process.env.HOME || "/root";
  const [projectHosts, userHosts, sshConfigHosts] = await Promise.all([
    readHostFile(getSSHConfigPath("project", cwd)),
    readHostFile(getSSHConfigPath("user", cwd)),
    readSshConfigFile(`${home}/.ssh/config`),
  ]);
  return mergeConfiguredSshHosts(projectHosts, userHosts, sshConfigHosts);
}

export function parseConnectArgs(
  args: string,
  configuredHosts: readonly ConfiguredSshHost[] = [],
): RemoteConnectRequest {
  const tokens = tokenize(args);
  const positionals: string[] = [];
  let port: number | undefined;
  let identityFile: string | undefined;
  let knownHostsFile: string | undefined;
  let workerPath: string | undefined;

  while (tokens.length > 0) {
    const token = tokens.shift()!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const value = tokens.shift();
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    if (token === "--port") {
      port = parsePort(value);
      if (port === undefined) throw new Error(`Invalid SSH port: ${value}`);
    } else if (token === "--identity") identityFile = value;
    else if (token === "--known-hosts") knownHostsFile = value;
    else if (token === "--worker") workerPath = value;
    else throw new Error(`Unknown option: ${token}`);
  }

  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error(USAGE);
  }
  const requestedTarget = positionals[0]!;
  const cwd = positionals[1];
  const configured = configuredHosts.find(
    (host) => host.name === requestedTarget,
  );
  const target = configured
    ? `${configured.username ? `${configured.username}@` : ""}${configured.host}`
    : requestedTarget;

  return {
    target,
    displayTarget: configured?.name ?? requestedTarget,
    ...(cwd ? { cwd } : {}),
    ...(port ?? configured?.port
      ? { port: port ?? configured?.port }
      : {}),
    ...(identityFile ?? configured?.keyPath
      ? { identityFile: identityFile ?? configured?.keyPath }
      : {}),
    ...(knownHostsFile ? { knownHostsFile } : {}),
    ...(workerPath ? { workerPath } : {}),
  };
}
