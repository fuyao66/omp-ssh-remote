import type { RemoteConnectRequest } from "../../connect-options.ts";
import type { RuntimeAssemblyRequest } from "../../protocol.ts";
import type { PiAssemblyTool } from "../assembly.ts";

// ponytail: process-global owner slot; session-scoped spec if tintin exposes a public child context
const INHERIT_ENV = "PI_REMOTE_CONNECTION_SPEC";
const OWNER_ENV = "PI_REMOTE_CONNECTION_OWNER";

export interface PiTintinSubagentConnectionSpec {
  ownerToken: string;
  assembly: RuntimeAssemblyRequest;
  tools: readonly PiAssemblyTool[];
  connectOptions: RemoteConnectRequest;
  workerPath: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssemblyTool(value: unknown): value is PiAssemblyTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.owner === "string" &&
    isRecord(value.parameters)
  );
}

function isRuntimeAssemblyRequest(
  value: unknown,
): value is RuntimeAssemblyRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.components) &&
    value.components.length > 0 &&
    value.components.every(
      (component) =>
        isRecord(component) &&
        typeof component.id === "string" &&
        (component.kind === "host" || component.kind === "plugin") &&
        typeof component.contractVersion === "string" &&
        typeof component.version === "string",
    ) &&
    Array.isArray(value.tools) &&
    value.tools.length > 0 &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        typeof tool.owner === "string",
    )
  );
}

export function hasPiTintinSubagentConnectionSpec(): boolean {
  return process.env[INHERIT_ENV] !== undefined;
}

export function readPiTintinSubagentConnectionSpec():
  PiTintinSubagentConnectionSpec | undefined {
  const serialized = process.env[INHERIT_ENV];
  if (serialized === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Invalid inherited Pi remote connection specification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(value) ||
    typeof value.ownerToken !== "string" ||
    value.ownerToken.length === 0 ||
    !isRuntimeAssemblyRequest(value.assembly) ||
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    !value.tools.every(isAssemblyTool) ||
    !isRecord(value.connectOptions) ||
    typeof value.connectOptions.target !== "string" ||
    typeof value.connectOptions.displayTarget !== "string" ||
    typeof value.workerPath !== "string" ||
    typeof value.cwd !== "string"
  ) {
    throw new Error("Invalid inherited Pi remote connection specification");
  }
  if (process.env[OWNER_ENV] !== value.ownerToken) {
    throw new Error("Invalid inherited Pi remote connection specification");
  }
  return value as unknown as PiTintinSubagentConnectionSpec;
}

export function claimPiTintinSubagentConnectionSpec(
  ownerToken: string,
): void {
  const existingOwner = process.env[OWNER_ENV];
  if (existingOwner !== undefined && existingOwner !== ownerToken) {
    throw new Error(
      "Another Pi root session already owns the inherited remote connection specification",
    );
  }
  if (existingOwner === undefined && process.env[INHERIT_ENV] !== undefined) {
    throw new Error(
      "An inherited Pi remote connection specification exists without a root owner",
    );
  }
  process.env[OWNER_ENV] = ownerToken;
}

export function publishPiTintinSubagentConnectionSpec(
  spec: PiTintinSubagentConnectionSpec,
): void {
  claimPiTintinSubagentConnectionSpec(spec.ownerToken);
  process.env[INHERIT_ENV] = JSON.stringify(spec);
}

export function clearPiTintinSubagentConnectionSpec(
  ownerToken?: string,
): void {
  if (ownerToken === undefined || process.env[OWNER_ENV] !== ownerToken) return;
  delete process.env[INHERIT_ENV];
  delete process.env[OWNER_ENV];
}
