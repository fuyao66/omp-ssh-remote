import type { RemoteConnectRequest } from "../../connect-options.ts";
import { getPiRuntimeProfile } from "../profiles/index.ts";

const INHERIT_ENV = "PI_REMOTE_CONNECTION_SPEC";

export interface PiSubagentConnectionSpec {
  profileId: string;
  connectOptions: RemoteConnectRequest;
  workerPath: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPiSubagentConnectionSpec():
  PiSubagentConnectionSpec | undefined {
  const serialized = process.env[INHERIT_ENV];
  if (!serialized) return undefined;
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    typeof value.profileId !== "string" ||
    !isRecord(value.connectOptions) ||
    typeof value.connectOptions.target !== "string" ||
    typeof value.workerPath !== "string" ||
    typeof value.cwd !== "string"
  ) {
    throw new Error("Invalid inherited Pi remote connection specification");
  }
  getPiRuntimeProfile(value.profileId);
  return value as unknown as PiSubagentConnectionSpec;
}

export function publishPiSubagentConnectionSpec(
  spec: PiSubagentConnectionSpec,
): void {
  getPiRuntimeProfile(spec.profileId);
  process.env[INHERIT_ENV] = JSON.stringify(spec);
}

export function clearPiSubagentConnectionSpec(): void {
  delete process.env[INHERIT_ENV];
}
