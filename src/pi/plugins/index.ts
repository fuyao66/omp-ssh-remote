import type { PiPluginAdapter } from "../assembly.ts";
import { AFT_PLUGIN_ADAPTER } from "./aft.ts";

export const PI_PLUGIN_ADAPTERS: readonly PiPluginAdapter[] = [
  AFT_PLUGIN_ADAPTER,
];

export { AFT_PLUGIN_ADAPTER } from "./aft.ts";
