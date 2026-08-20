import {
  OMP_VERSION,
  REMOTE_TOOL_NAMES,
  TOOL_RUNTIME_VERSION,
  type ReadyMessage,
} from "../protocol.ts";
import type {
  RemoteRuntimeHandshake,
  RemoteWorkerBundle,
} from "../runtime-contract.ts";

function validateOmpReadyMessage(ready: ReadyMessage): void {
  if (
    ready.ompVersion !== OMP_VERSION ||
    ready.runtimeVersion !== TOOL_RUNTIME_VERSION
  ) {
    throw new Error(
      `Remote runtime version mismatch: protocol=${ready.protocolVersion}, OMP=${ready.ompVersion}, runtime=${ready.runtimeVersion}`,
    );
  }
  const available = new Set(ready.tools.map((tool) => tool.name));
  const missing = REMOTE_TOOL_NAMES.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Remote runtime is missing tools: ${missing.join(", ")}`);
  }
}

export const OMP_RUNTIME_HANDSHAKE: RemoteRuntimeHandshake = {
  host: "omp",
  hostVersion: OMP_VERSION,
  runtimeVersion: TOOL_RUNTIME_VERSION,
  requestedTools: REMOTE_TOOL_NAMES,
  validateReady: validateOmpReadyMessage,
};

export const OMP_WORKER_BUNDLE: RemoteWorkerBundle = {
  cacheNamespace: OMP_VERSION,
  companionArtifacts: [],
};
