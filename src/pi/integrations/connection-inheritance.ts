import type { RemoteConnectRequest } from "../../connect-options.ts";
import type { RuntimeAssemblyRequest } from "../../protocol.ts";
import type { PiAssemblyTool } from "../assembly.ts";

/**
 * Host-neutral Pi remote connection inheritance payload.
 * Integrations serialize/restore this across parent/child sessions.
 */
export interface PiRemoteConnectionInheritanceSpec {
  ownerToken: string;
  assembly: RuntimeAssemblyRequest;
  tools: readonly PiAssemblyTool[];
  connectOptions: RemoteConnectRequest;
  workerPath: string;
  cwd: string;
}

/**
 * Optional session-family inheritance backend.
 * Absent on installPiRemoteExtension options means the host must not call
 * inheritance APIs (optional chaining / no disabled no-op object).
 */
export interface PiRemoteConnectionInheritance {
  hasSpec(): boolean;
  hasRootOwner(): boolean;
  read(): PiRemoteConnectionInheritanceSpec | undefined;
  claim(ownerToken: string): void;
  publish(spec: PiRemoteConnectionInheritanceSpec): void;
  clear(ownerToken?: string): void;
}
