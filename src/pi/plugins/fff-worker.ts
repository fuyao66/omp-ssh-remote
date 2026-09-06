import { FFF_PLUGIN_ADAPTER } from "./fff.ts";
import {
  createWorkerManagedFffFactory,
  type ManagedFffOptions,
} from "./fff-capture.ts";
import type { PiWorkerPluginAdapter } from "../worker-plugins.ts";

export function createFffWorkerPluginAdapter(): PiWorkerPluginAdapter {
  return {
    id: FFF_PLUGIN_ADAPTER.id,
    packageName: FFF_PLUGIN_ADAPTER.packageName,
    contractVersion: FFF_PLUGIN_ADAPTER.contractVersion,
    remoteTools: FFF_PLUGIN_ADAPTER.remoteTools,
    matchesSource: (sourceInfo) => FFF_PLUGIN_ADAPTER.matchesSource(sourceInfo),
    validateConfig: FFF_PLUGIN_ADAPTER.validateConfig,
    workspaceServices: FFF_PLUGIN_ADAPTER.workspaceServices,
    companionArtifactIds: [],
    bundledVersion: process.env.PI_BUNDLED_FFF_VERSION,
    createFactory(input) {
      if (!input.onHandle) {
        throw new Error(
          "FFF worker factory requires onHandle to own service dispatch",
        );
      }
      const options: ManagedFffOptions = {
        config: input.config,
        getRoute: () => "local",
        mutateEnv: true,
      };
      return createWorkerManagedFffFactory(options, input.onHandle);
    },
  };
}
