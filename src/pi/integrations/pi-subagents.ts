import type { RemoteConnectRequest } from "../../connect-options.ts";
import type { RuntimeAssemblyRequest } from "../../protocol.ts";

const INHERIT_ENV = "PI_REMOTE_CONNECTION_SPEC";

export interface PiSubagentConnectionSpec {
  assembly: RuntimeAssemblyRequest;
  connectOptions: RemoteConnectRequest;
  workerPath: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeAssemblyRequest(
  value: unknown,
): value is RuntimeAssemblyRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.components) &&
    value.components.every(
      (component) =>
        isRecord(component) &&
        typeof component.id === "string" &&
        (component.kind === "host" || component.kind === "plugin") &&
        typeof component.contractVersion === "string" &&
        typeof component.version === "string",
    ) &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        typeof tool.owner === "string",
    )
  );
}

export function readPiSubagentConnectionSpec():
  | PiSubagentConnectionSpec
  | undefined {
  const serialized = process.env[INHERIT_ENV];
  if (!serialized) return undefined;
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    !isRuntimeAssemblyRequest(value.assembly) ||
    !isRecord(value.connectOptions) ||
    typeof value.connectOptions.target !== "string" ||
    typeof value.workerPath !== "string" ||
    typeof value.cwd !== "string"
  ) {
    throw new Error("Invalid inherited Pi remote connection specification");
  }
  return value as unknown as PiSubagentConnectionSpec;
}

export function publishPiSubagentConnectionSpec(
  spec: PiSubagentConnectionSpec,
): void {
  process.env[INHERIT_ENV] = JSON.stringify(spec);
}

export function clearPiSubagentConnectionSpec(): void {
  delete process.env[INHERIT_ENV];
}
