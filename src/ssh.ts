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

export type SshWorkerOptions = SshConnectionOptions & { workerPath: string };

function validateTarget(target: string): void {
  if (!/^[A-Za-z0-9_.@-]+$/.test(target) || target.startsWith("-")) {
    throw new Error(`Unsafe SSH target: ${target}`);
  }
}

export function getSshDestination(options: SshConnectionOptions): string {
  validateTarget(options.target);
  if (options.sshAlias === undefined) return options.target;
  if (!/^[A-Za-z0-9_.-]+$/.test(options.sshAlias) || options.sshAlias.startsWith("-")) {
    throw new Error("Unsafe SSH alias");
  }
  const userPrefix = options.target.slice(0, options.target.lastIndexOf("@") + 1);
  return `${userPrefix}${options.sshAlias}`;
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
    // Match the original Host alias without allowing its HostName to replace
    // the resolved destination (including higher-priority OMP host settings).
    command.push("-o", `HostName=${options.target.slice(options.target.lastIndexOf("@") + 1)}`);
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
  return [
    ...buildSshBaseCommand(options),
    getSshDestination(options),
    `set -eu; d=${quoteRemoteArgument(posix.dirname(options.workerPath))}; root=${quoteRemoteArgument(posix.dirname(posix.dirname(posix.dirname(options.workerPath))))}; locked=0; if test -f "$root/.native-cache.lock" && test ! -L "$root/.native-cache.lock"; then exec 8>"$root/.native-cache.lock"; flock -w 8 -x 8; locked=1; fi; test -d "$d" && test ! -L "$d"; test ! -L "$d/.worker.lock"; exec 9>"$d/.worker.lock"; flock -s 9; test -x ${quoteRemoteArgument(options.workerPath)}; if test "$locked" -eq 1; then flock -u 8; fi; exec flock --shared "$d/.worker.lock" ${quoteRemoteArgument(options.workerPath)}`,
  ];
}
