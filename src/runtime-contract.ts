import type { ReadyMessage } from "./protocol.ts";

export type RemoteWorkerHost = "omp" | "pi";

export interface RemoteRuntimeHandshake {
  host: RemoteWorkerHost;
  hostVersion: string;
  runtimeVersion: string;
  requestedTools: readonly string[];
  validateReady(ready: ReadyMessage): void;
}

export interface RemoteCompanionArtifact {
  id: string;
  filePrefix: string;
  executableName: string;
}

export interface RemoteWorkerBundle {
  cacheNamespace: string;
  companionArtifacts: readonly RemoteCompanionArtifact[];
}
