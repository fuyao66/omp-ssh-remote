import aftExtension from "@cortexkit/aft-pi";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { AFT_PLUGIN_ADAPTER } from "./aft.ts";
import type { PiWorkerPluginAdapter } from "../worker-plugins.ts";

export function createAftWorkerPluginAdapter(): PiWorkerPluginAdapter {
  return {
    id: AFT_PLUGIN_ADAPTER.id,
    packageName: AFT_PLUGIN_ADAPTER.packageName,
    contractVersion: AFT_PLUGIN_ADAPTER.contractVersion,
    remoteTools: AFT_PLUGIN_ADAPTER.remoteTools,
    matchesSource: (sourceInfo) => AFT_PLUGIN_ADAPTER.matchesSource(sourceInfo),
    companionArtifactIds: AFT_PLUGIN_ADAPTER.companionArtifacts.map(
      (artifact) => artifact.id,
    ),
    optional: true,
    bundledVersion: process.env.PI_BUNDLED_AFT_VERSION,
    createFactory() {
      return aftExtension as ExtensionFactory;
    },
  };
}
