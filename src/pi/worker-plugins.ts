import aftExtension from "@cortexkit/aft-pi";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { AFT_PLUGIN_ADAPTER } from "./plugins/aft.ts";

export interface PiWorkerPluginAdapter {
  id: string;
  packageName: string;
  contractVersion: string;
  remoteTools: ReadonlySet<string>;
  factory: ExtensionFactory;
  bundledVersion?: string;
}

export const PI_WORKER_PLUGIN_ADAPTERS: readonly PiWorkerPluginAdapter[] = [
  {
    id: AFT_PLUGIN_ADAPTER.id,
    packageName: AFT_PLUGIN_ADAPTER.packageName,
    contractVersion: AFT_PLUGIN_ADAPTER.contractVersion,
    remoteTools: AFT_PLUGIN_ADAPTER.remoteTools,
    factory: aftExtension,
    bundledVersion: process.env.PI_BUNDLED_AFT_VERSION,
  },
];
