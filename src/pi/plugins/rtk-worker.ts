import { RTK_PLUGIN_ADAPTER } from "./rtk.ts";
import type { PiWorkerPluginAdapter } from "../worker-plugins.ts";

export function createRtkWorkerPluginAdapter(): PiWorkerPluginAdapter {
  return {
    id: RTK_PLUGIN_ADAPTER.id,
    packageName: RTK_PLUGIN_ADAPTER.packageName,
    contractVersion: RTK_PLUGIN_ADAPTER.contractVersion,
    remoteTools: RTK_PLUGIN_ADAPTER.remoteTools,
    validateConfig: RTK_PLUGIN_ADAPTER.validateConfig,
    workspaceServices: RTK_PLUGIN_ADAPTER.workspaceServices,
    matchesSource: (sourceInfo) => RTK_PLUGIN_ADAPTER.matchesSource(sourceInfo),
    companionArtifactIds: [],
    bundledVersion: process.env.PI_BUNDLED_RTK_VERSION,
    createFactory(input) {
      if (!input.onHandle) {
        throw new Error("RTK worker factory requires onHandle to own service dispatch");
      }
      const onHandle = input.onHandle;
      return async (pi) => {
        // Defer upstream module evaluation until the worker selects its private agent directory.
        const { createWorkerManagedRtkFactory } = await import("./rtk-capture.ts");
        await createWorkerManagedRtkFactory(input.config, onHandle)(pi);
      };
    },
  };
}
