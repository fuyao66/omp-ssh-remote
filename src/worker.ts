#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_DIR_ENV, DAEMON_TCP_ENV, DAEMON_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { installProcessHandlers } from "@oh-my-pi/pi-utils/postmortem";
import { declareWorkerHostEntry, installWorkerInbox, SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils/worker-host";
import { isMainThread, parentPort } from "node:worker_threads";

const selector = process.argv[2];
if (isMainThread) {
  // Set before loading any native client; workers and daemon re-exec inherit it.
  process.env[DAEMON_DIR_ENV] = join(homedir(), ".cache", "omp-ssh-remote-daemon");
  delete process.env[DAEMON_TCP_ENV];
  declareWorkerHostEntry();
  installProcessHandlers();
} else if (parentPort) {
  installWorkerInbox(parentPort);
}

// Re-entry subprocesses must not initialize the companion's unused tool graph.
if (selector === "__omp_worker_js_eval_process") {
  const { runJsEvalProcessHost } = await import("./worker-js-eval.ts");
  await runJsEvalProcessHost();
} else if (selector === "__omp_worker_js_eval") {
  await import("@oh-my-pi/pi-coding-agent/eval/js/worker-entry");
} else if (selector === DAEMON_WORKER_ARG) {
  const { startDaemonFromEnvironment } = await import("@oh-my-pi/pi-coding-agent/daemon/server");
  await startDaemonFromEnvironment();
} else if (selector === SHELL_PROCESS_SELECTOR) {
  const { runShellProcess } = await import("@oh-my-pi/pi-coding-agent/exec/shell-process-worker");
  await runShellProcess(process.argv.slice(3));
} else if (selector === undefined && isMainThread) {
  const { runCompanionWorker } = await import("./worker-companion.ts");
  await runCompanionWorker();
} else {
  throw new Error(`Unsupported remote worker selector: ${selector}`);
}
