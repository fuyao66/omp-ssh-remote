import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { posix } from "node:path";

export type SshConnectionOptions = {
  target: string;
  sshAlias?: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
};

export type SshWorkerOptions = SshConnectionOptions & { workerPath: string; pythonLspPack?: string; typescriptLspPack?: string; cppLspPack?: string };

function parseSshTarget(value: unknown): { username?: string; host: string } {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.+@:\[\]-]+$/.test(value) || value.startsWith("-")) {
    throw new Error(`Invalid SSH target: ${String(value)}`);
  }
  const parts = value.split("@");
  const host = parts.at(-1)!;
  const username = parts.length === 2 ? parts[0] : undefined;
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const address = bracketed ? host.slice(1, -1) : host;
  if (parts.length > 2 ||
    (username !== undefined && !/^[A-Za-z0-9_.+][A-Za-z0-9_.+-]*$/.test(username)) ||
    (bracketed ? isIP(address) !== 6 : !isIP(address) && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(address))) {
    throw new Error(`Invalid SSH target: ${value}`);
  }
  return { username, host: address };
}

export function validateSshTarget(value: unknown): string {
  parseSshTarget(value);
  return value as string;
}

export function getSshDestination(options: SshConnectionOptions): string {
  const { username, host } = parseSshTarget(options.target);
  if (options.sshAlias === undefined) return `${username ? `${username}@` : ""}${host}`;
  const alias = parseSshTarget(options.sshAlias);
  if (alias.username !== undefined) throw new Error("Invalid SSH alias: username is not allowed");
  return `${username ? `${username}@` : ""}${alias.host}`;
}

export function getScpDestination(options: SshConnectionOptions): string {
  const { username, host } = parseSshTarget(getSshDestination(options));
  return `${username ? `${username}@` : ""}${isIP(host) === 6 ? `[${host}]` : host}`;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function quoteRemoteArgument(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Remote shell arguments cannot contain NUL or newlines");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function appendCommonOptions(
  command: string[],
  options: SshConnectionOptions,
): void {
  getSshDestination(options);
  if (options.sshAlias !== undefined) {
    // OMP hosts explicitly override HostName while retaining native alias matching.
    command.push("-o", `HostName=${parseSshTarget(options.target).host}`);
  }
  command.push(
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
  );
  if (options.identityFile)
    command.push("-i", expandHome(options.identityFile));
  if (options.knownHostsFile)
    command.push(
      "-o",
      `UserKnownHostsFile=${expandHome(options.knownHostsFile)}`,
    );
}

export function buildSshBaseCommand(options: SshConnectionOptions): string[] {
  const command = ["ssh", "-T"];
  appendCommonOptions(command, options);
  command.push(
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=60",
    "-o",
    "ControlPath=~/.ssh/omp-remote-%C",
  );
  if (options.port) command.push("-p", String(options.port));
  return command;
}

export function buildScpBaseCommand(options: SshConnectionOptions): string[] {
  // Destinations are shell-quoted: pin SCP rather than the SFTP default in OpenSSH 9+.
  const command = ["scp", "-O"];
  appendCommonOptions(command, options);
  command.push(
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=60",
    "-o",
    "ControlPath=~/.ssh/omp-remote-%C",
  );
  if (options.port) command.push("-P", String(options.port));
  return command;
}

export function buildSshWorkerCommand(options: SshWorkerOptions): string[] {
  for (const [label, path] of [["Python", options.pythonLspPack], ["TypeScript", options.typescriptLspPack], ["C/C++", options.cppLspPack]]) {
    if (path !== undefined && (!path.startsWith("/") || /[\0\r\n]/.test(path))) {
      throw new Error(`${label} LSP pack path must be a remote absolute path`);
    }
  }
  const packEnvironment = [
    options.pythonLspPack ? `OMP_REMOTE_PYTHON_LSP_PACK=${quoteRemoteArgument(options.pythonLspPack)}` : "",
    options.typescriptLspPack ? `OMP_REMOTE_TYPESCRIPT_LSP_PACK=${quoteRemoteArgument(options.typescriptLspPack)}` : "",
    options.cppLspPack ? `OMP_REMOTE_CPP_LSP_PACK=${quoteRemoteArgument(options.cppLspPack)}` : "",
  ].filter(Boolean).join(" ");
  return [
    ...buildSshBaseCommand(options),
    getSshDestination(options),
    `set -eu; unset OMP_REMOTE_PYTHON_LSP_PACK OMP_REMOTE_TYPESCRIPT_LSP_PACK OMP_REMOTE_CPP_LSP_PACK; d=${quoteRemoteArgument(posix.dirname(options.workerPath))}; root=${quoteRemoteArgument(posix.dirname(posix.dirname(posix.dirname(options.workerPath))))}; locked=0; if test -f "$root/.native-cache.lock" && test ! -L "$root/.native-cache.lock"; then exec 8>"$root/.native-cache.lock"; flock -w 8 -x 8; locked=1; fi; test -d "$d" && test ! -L "$d"; test ! -L "$d/.worker.lock"; exec 9>"$d/.worker.lock"; flock -s 9; test -x ${quoteRemoteArgument(options.workerPath)}; if test "$locked" -eq 1; then flock -u 8; fi; ${packEnvironment} exec flock --shared "$d/.worker.lock" ${quoteRemoteArgument(options.workerPath)}`,
  ];
}
