import type { PiPluginAdapter } from "../assembly.ts";
import { AFT_PLUGIN_ADAPTER } from "./aft.ts";
import { FFF_PLUGIN_ADAPTER } from "./fff.ts";
import { RTK_PLUGIN_ADAPTER } from "./rtk.ts";

export const PI_PLUGIN_ADAPTERS: readonly PiPluginAdapter[] = [
  AFT_PLUGIN_ADAPTER,
  FFF_PLUGIN_ADAPTER,
  RTK_PLUGIN_ADAPTER,
];

export { AFT_PLUGIN_ADAPTER } from "./aft.ts";
export { RTK_PLUGIN_ADAPTER } from "./rtk.ts";
export {
  FFF_PLUGIN_ADAPTER,
  FFF_PLUGIN_ID,
  FFF_PLUGIN_CONTRACT_VERSION,
  FFF_PLUGIN_TOOLS,
  FFF_DEFAULT_TOOLS,
  FFF_OPTIONAL_TOOLS,
  FFF_OVERRIDE_TOOLS,
  FFF_WORKSPACE_SERVICES,
  FFF_ASSEMBLY_MODES,
  resolveFffAssemblyConfig,
  validateFffAssemblyConfig,
} from "./fff.ts";
export type { FffAssemblyConfig, FffAssemblyMode } from "./fff.ts";
