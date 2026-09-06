declare module "omp-rtk-entry" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  const extension: (pi: ExtensionAPI) => void;
  export default extension;
}
declare module "omp-rtk-config-store" {
  export function loadRtkIntegrationConfig(): { config: Record<string, unknown> };
  export function saveRtkIntegrationConfig(config: Record<string, unknown>): { success: boolean; error?: string };
  export function getRtkIntegrationConfigPath(): string;
}
declare module "omp-rtk-output-metrics" {
  export function getOutputMetricsSummary(): string;
  export function clearOutputMetrics(): void;
}
declare module "omp-rtk-executable-resolver" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  export function resolveRtkExecutable(pi: ExtensionAPI): Promise<{ command: string; resolvedPath?: string; resolver: string; warning?: string }>;
}
