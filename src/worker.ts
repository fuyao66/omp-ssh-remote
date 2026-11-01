#!/usr/bin/env bun
import { installProcessHandlers } from "@oh-my-pi/pi-utils/postmortem";
import { DAEMON_BROKER_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/launch/protocol";

const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";

// Install native signal ownership before importing any mode's implementation.
// Re-entry subprocesses must not initialize the companion's unused tool graph.
installProcessHandlers();

if (process.argv[2] === JS_EVAL_PROCESS_ARG) {
  const { runJsEvalProcessHost } = await import("./worker-js-eval.ts");
  await runJsEvalProcessHost();
} else if (process.argv[2] === DAEMON_BROKER_WORKER_ARG) {
  const { startDaemonBrokerFromEnvironment } = await import("@oh-my-pi/pi-coding-agent/launch/broker");
  await startDaemonBrokerFromEnvironment();
} else {
  const { runCompanionWorker } = await import("./worker-companion.ts");
  await runCompanionWorker();
}
