import type {
  RemoteRuntimeHandshake,
  RemoteWorkerBundle,
} from "../runtime-contract.ts";

export interface PiRuntimeToolGroup {
  id: string;
  displayName: string;
  tools: ReadonlySet<string>;
}

export interface PiRuntimeProfile {
  id: string;
  version: string;
  displayName: string;
  handshake: RemoteRuntimeHandshake;
  workerBundle: RemoteWorkerBundle;
  knownWorkspaceTools: ReadonlySet<string>;
  toolGroups: readonly PiRuntimeToolGroup[];
  executionRuntime: {
    local: string;
    remote: string;
  };
}
