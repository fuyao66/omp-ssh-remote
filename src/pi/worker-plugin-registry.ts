/**
 * Default (source/dev) registry. The Pi worker compile step replaces this
 * module with a selected-only graph so unselected plugin packages are not
 * imported into the binary.
 */
import type { PiWorkerPluginAdapter } from "./worker-plugins.ts";
import { createAftWorkerPluginAdapter } from "./plugins/aft-worker.ts";
import { createFffWorkerPluginAdapter } from "./plugins/fff-worker.ts";
import { createRtkWorkerPluginAdapter } from "./plugins/rtk-worker.ts";

export const PI_WORKER_PLUGIN_ADAPTERS: readonly PiWorkerPluginAdapter[] = [
  createAftWorkerPluginAdapter(),
  createFffWorkerPluginAdapter(),
  createRtkWorkerPluginAdapter(),
];
