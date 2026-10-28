import {
  OMP_HOST_CONTRACT_VERSION,
  REMOTE_TOOL_NAMES,
  TOOL_RUNTIME_VERSION,
  isRecord,
  type ReadyMessage,
  type OmpEditMode,
  type ToolManifest,
} from "../protocol.ts";
import type {
  RemoteRuntimeHandshake,
  RemoteWorkerBundle,
} from "../runtime-contract.ts";

export interface OmpLocalToolSnapshot {
  name: string;
  parameters?: unknown;
  customFormat?: ToolManifest["customFormat"];
  customWireName?: string;
}

export interface OmpRuntimeHandshakeOptions {
  hostVersion: string;
  localTools?: readonly OmpLocalToolSnapshot[];
  /** Effective native edit mode resolved against the real host session/model. */
  editMode?: OmpEditMode;
}

/**
 * Names the first parameter-level difference between two object schemas so a
 * rejected handshake says *which* field drifted instead of only "incompatible".
 * Returns undefined when the schemas only differ below the property level.
 */
export function describeSchemaDrift(local: unknown, remote: unknown): string | undefined {
  const localProps = isRecord(local) && isRecord(local.properties) ? local.properties : {};
  const remoteProps = isRecord(remote) && isRecord(remote.properties) ? remote.properties : {};
  const localOnly = Object.keys(localProps).filter((key) => !(key in remoteProps));
  const remoteOnly = Object.keys(remoteProps).filter((key) => !(key in localProps));
  if (localOnly.length > 0) return `host has parameter(s) the companion lacks: ${localOnly.join(", ")}`;
  if (remoteOnly.length > 0) return `companion has parameter(s) the host lacks: ${remoteOnly.join(", ")}`;
  const changed = Object.keys(localProps).filter(
    (key) => stableJson(localProps[key]) !== stableJson(remoteProps[key]),
  );
  if (changed.length > 0) return `parameter definition changed: ${changed.join(", ")}`;
  return undefined;
}

/** One-line remediation hint appended to every version-related admission failure. */
export function versionDriftHint(localHostVersion: string | undefined, remoteHostVersion: string | undefined): string {
  const local = localHostVersion ?? "unknown";
  const remote = remoteHostVersion ?? "unknown";
  const same = localHostVersion !== undefined && localHostVersion === remoteHostVersion;
  return same
    ? `local OMP ${local}, companion built for ${remote}; rebuild the companion workers against the installed OMP (bun run build:worker:all) and reconnect`
    : `local OMP ${local}, companion built for ${remote}; update the plugin's pinned OMP dependencies to ${local}, rebuild the companion workers (bun run build:worker:all), and reconnect`;
}

type JsonSchemaConvertible = {
  toJsonSchema: () => unknown;
};

function asJsonSchemaConvertible(
  value: object | ((...args: never[]) => unknown),
): JsonSchemaConvertible | undefined {
  if (!("toJsonSchema" in value)) return undefined;
  const method = Reflect.get(value, "toJsonSchema");
  if (typeof method !== "function") return undefined;
  return { toJsonSchema: () => Reflect.apply(method, value, []) };
}

export function toolParametersToWire(parameters: unknown): unknown {
  if (
    (typeof parameters === "object" && parameters !== null) ||
    typeof parameters === "function"
  ) {
    const convertible = asJsonSchemaConvertible(parameters);
    if (convertible) return convertible.toJsonSchema();
  }
  return parameters;
}

/** Capture getters now: live native tool metadata may change with the active model. */
export function captureOmpToolSnapshot(tool: OmpLocalToolSnapshot): OmpLocalToolSnapshot {
  const customFormat = tool.customFormat;
  const customWireName = tool.customWireName;
  return {
    name: tool.name,
    parameters: toolParametersToWire(tool.parameters),
    ...(customFormat === undefined ? {} : { customFormat: { ...customFormat } }),
    ...(customWireName === undefined ? {} : { customWireName }),
  };
}


function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Only `async` is owned by the local job adapter (which removes it before
 * transport). Service name/readiness and every execution field stay exact.
 * Apply to host metadata only: companions must advertise the execution schema.
 */
export function projectOmpBashExecutionSchema(parameters: unknown): unknown {
  if (!isRecord(parameters) || !isRecord(parameters.properties) || !("async" in parameters.properties))
    return parameters;
  if (stableJson(parameters.properties.async) !== stableJson({ type: "boolean" }) ||
      (Array.isArray(parameters.required) && parameters.required.includes("async"))) {
    throw new Error("Local OMP bash async schema is incompatible with the adapter: expected an optional boolean");
  }
  return {
    ...parameters,
    properties: Object.fromEntries(Object.entries(parameters.properties).filter(([key]) => key !== "async")),
  };
}

function bashServicesFromSchema(parameters: unknown): boolean {
  const properties = isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : {};
  const name = "name" in properties;
  const ready = "ready" in properties;
  if (name !== ready)
    throw new Error("Local OMP bash service schema is incompatible: name and ready must be exposed together");
  return name;
}

function isObjectSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "object";
}

function remoteHostVersion(ready: ReadyMessage): string | undefined {
  if (typeof ready.hostVersion === "string" && ready.hostVersion)
    return ready.hostVersion;
  if (typeof ready.ompVersion === "string" && ready.ompVersion)
    return ready.ompVersion;
  return undefined;
}

export function validateOmpReadyMessage(
  ready: ReadyMessage,
  localTools?: readonly OmpLocalToolSnapshot[],
  localHostVersion?: string,
  localEditMode?: OmpEditMode,
): void {
  if (ready.host !== undefined && ready.host !== "omp") {
    throw new Error(
      `Remote runtime host mismatch: expected omp, got ${ready.host}`,
    );
  }
  const hostVersion = remoteHostVersion(ready);
  if (ready.runtimeVersion !== TOOL_RUNTIME_VERSION) {
    throw new Error(
      `Remote runtime contract mismatch: protocol=${ready.protocolVersion}, runtime=${ready.runtimeVersion} (expected ${TOOL_RUNTIME_VERSION}); ${versionDriftHint(localHostVersion, hostVersion)}`,
    );
  }
  if (!hostVersion) {
    throw new Error("Remote OMP runtime did not report a host version");
  }
  if (localEditMode !== undefined && ready.editMode !== localEditMode) {
    throw new Error(
      `Remote OMP edit mode is incompatible: host=${localEditMode}, companion=${ready.editMode ?? "unreported"}`,
    );
  }

  const available = new Map(
    ready.tools.map((tool) => [tool.name, tool] as const),
  );
  const missing = REMOTE_TOOL_NAMES.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Remote runtime is missing tools: ${missing.join(", ")}`);
  }

  if (!localTools) return;

  const expected = new Map(
    localTools
      .filter((tool) =>
        REMOTE_TOOL_NAMES.includes(
          tool.name as (typeof REMOTE_TOOL_NAMES)[number],
        ),
      )
      .map((tool) => [tool.name, tool] as const),
  );
  for (const name of REMOTE_TOOL_NAMES) {
    const local = expected.get(name);
    const remote = available.get(name);
    if (!local) {
      throw new Error(`Local OMP native tool metadata is unavailable: ${name}`);
    }
    if (!remote) {
      throw new Error(`Remote runtime is missing tools: ${name}`);
    }
    if (!isObjectSchema(remote.parameters)) {
      throw new Error(
        `Remote OMP tool ${name} has an invalid parameter schema`,
      );
    }
    const localParameters = name === "bash" ? projectOmpBashExecutionSchema(local.parameters) : local.parameters;
    if (stableJson(remote.parameters) !== stableJson(localParameters)) {
      const drift = describeSchemaDrift(
        localParameters,
        remote.parameters,
      );
      throw new Error(
        `Remote OMP tool ${name} schema is incompatible with the local tool${drift ? ` (${drift})` : ""}; ${versionDriftHint(localHostVersion, hostVersion)}`,
      );
    }
    if (name === "edit" &&
        (stableJson(local.customFormat) !== stableJson(remote.customFormat) ||
         local.customWireName !== remote.customWireName)) {
      throw new Error(
        `Remote OMP edit language is incompatible with the local tool (custom grammar or wire name changed); ${versionDriftHint(localHostVersion, hostVersion)}`,
      );
    }
  }
}

export function createOmpRuntimeHandshake(
  options: OmpRuntimeHandshakeOptions,
): RemoteRuntimeHandshake {
  const localTools = options.localTools?.map(captureOmpToolSnapshot);
  const bash = localTools?.find(tool => tool.name === "bash");
  const bashServices = bash === undefined ? undefined : bashServicesFromSchema(bash.parameters);
  return {
    host: "omp",
    hostVersion: options.hostVersion,
    runtimeVersion: TOOL_RUNTIME_VERSION,
    ...(options.editMode === undefined ? {} : { editMode: options.editMode }),
    ...(bashServices === undefined ? {} : { bashServices }),
    requestedTools: REMOTE_TOOL_NAMES,
    validateReady: (ready) =>
      validateOmpReadyMessage(ready, localTools, options.hostVersion, options.editMode),
  };
}

export const OMP_RUNTIME_HANDSHAKE: RemoteRuntimeHandshake =
  createOmpRuntimeHandshake({
    hostVersion: "unspecified",
  });

export const OMP_WORKER_BUNDLE: RemoteWorkerBundle = {
  owner: "omp-ssh-remote/native-omp",
  cacheNamespace: `omp-${OMP_HOST_CONTRACT_VERSION}`,
  companionArtifacts: [],
};
