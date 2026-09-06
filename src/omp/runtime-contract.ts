import {
  OMP_HOST_CONTRACT_VERSION,
  REMOTE_TOOL_NAMES,
  TOOL_RUNTIME_VERSION,
  isRecord,
  type ReadyMessage,
} from "../protocol.ts";
import type {
  RemoteRuntimeHandshake,
  RemoteWorkerBundle,
} from "../runtime-contract.ts";

export interface OmpLocalToolSnapshot {
  name: string;
  parameters?: unknown;
}

export interface OmpRuntimeHandshakeOptions {
  hostVersion: string;
  localTools?: readonly OmpLocalToolSnapshot[];
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

function isObjectSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "object";
}

const HUB_LOCAL_FIELDS = new Set([
  "to", "message", "replyTo", "await", "from", "ids", "timeoutMs", "peek", "status", "limit",
]);

function executionSchema(name: string, schema: unknown): unknown {
  if (name !== "hub" || !isRecord(schema) || !isRecord(schema.properties)) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !HUB_LOCAL_FIELDS.has(key))),
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((key) => !HUB_LOCAL_FIELDS.has(String(key))) }
      : {}),
  };
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
): void {
  if (ready.host !== undefined && ready.host !== "omp") {
    throw new Error(
      `Remote runtime host mismatch: expected omp, got ${ready.host}`,
    );
  }
  if (ready.runtimeVersion !== TOOL_RUNTIME_VERSION) {
    throw new Error(
      `Remote runtime contract mismatch: protocol=${ready.protocolVersion}, runtime=${ready.runtimeVersion}`,
    );
  }
  const hostVersion = remoteHostVersion(ready);
  if (!hostVersion) {
    throw new Error("Remote OMP runtime did not report a host version");
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
    if (stableJson(executionSchema(name, remote.parameters)) !== stableJson(executionSchema(name, local.parameters))) {
      throw new Error(
        `Remote OMP tool ${name} schema is incompatible with the local tool`,
      );
    }
  }
}

export function createOmpRuntimeHandshake(
  options: OmpRuntimeHandshakeOptions,
): RemoteRuntimeHandshake {
  return {
    host: "omp",
    hostVersion: options.hostVersion,
    runtimeVersion: TOOL_RUNTIME_VERSION,
    requestedTools: REMOTE_TOOL_NAMES,
    validateReady: (ready) =>
      validateOmpReadyMessage(ready, options.localTools),
  };
}

export const OMP_RUNTIME_HANDSHAKE: RemoteRuntimeHandshake =
  createOmpRuntimeHandshake({
    hostVersion: "unspecified",
  });

export const OMP_WORKER_BUNDLE: RemoteWorkerBundle = {
  cacheNamespace: `omp-${OMP_HOST_CONTRACT_VERSION}`,
  companionArtifacts: [],
};
