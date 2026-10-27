import {
  parseExecutionSettings,
  type RemoteExecutionSettings,
} from "./omp/execution-settings.ts";
import { parseJobCapturePayload, type JobCapturePayload } from "./omp/job-capture.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Protocol field ${label} must be an object`);
  }
  return value;
}
export const PROTOCOL_VERSION = 1 as const;
export const TOOL_RUNTIME_VERSION = "0.14.0" as const;
export const OMP_HOST_CONTRACT_VERSION = "1" as const;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const REMOTE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "lsp",
  "ast_grep",
  "ast_edit",
  "eval",
  "debug",
] as const;
export type RemoteToolName = (typeof REMOTE_TOOL_NAMES)[number];
export type AnyRemoteToolName = string;

export const OMP_EDIT_MODES = ["replace", "patch", "apply_patch", "hashline", "sloppy"] as const;
export type OmpEditMode = (typeof OMP_EDIT_MODES)[number];

export function parseOmpEditMode(value: unknown): OmpEditMode {
  if (typeof value !== "string" || !OMP_EDIT_MODES.includes(value as OmpEditMode))
    throw new Error("Protocol field editMode must be a supported OMP edit mode");
  return value as OmpEditMode;
}

export function parseResourceBinding(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("Protocol field resourceBinding must be a non-empty string");
  return value;
}


export type InitializeRequest = {
  type: "initialize";
  protocolVersion: number;
  host?: "omp";
  ompVersion?: string;
  hostVersion?: string;
  runtimeVersion: string;
  cwd: string;
  tools: string[];
  /** Local OMP session id; owner identity for remote supervised processes. */
  sessionId?: string;
  /** Forwarded execution-domain settings (see omp/execution-settings.ts). */
  settings?: RemoteExecutionSettings;
  /** Effective host edit language, after model/env overrides. */
  editMode?: OmpEditMode;
  /** Whether the actual host bash schema exposes remote service operations. */
  bashServices?: boolean;
  /** Workspace-owned resource namespace echoed by the worker. */
  resourceBinding?: string;
};

export type ExecuteRequest = {
  type: "execute";
  id: string;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Names of the tools active in the local session (bash interceptor input). */
  toolNames?: string[];
  /** The host can interrupt readiness without cancelling the service. */
  steering?: boolean;
  /** Job shells are isolated; session scope preserves foreground shell state. */
  bashScope?: "job" | "session";
};

export type InvokeMessage = {
  type: "invoke";
  id: string;
  parentId: string;
  resourceBinding: string;
  tool: string;
  toolCallId: string;
  args: Record<string, unknown>;
};
export type InvokeReply =
  | { type: "invoke-result" | "invoke-update"; id: string; result: unknown }
  | { type: "invoke-error"; id: string; error: { name: string; message: string } };

export type CancelRequest = { type: "cancel"; id: string };
export type ShutdownRequest = { type: "shutdown" };
export type Request =
  | InitializeRequest
  | ExecuteRequest
  | CancelRequest
  | { type: "service-stop"; id: string; name: string; instanceId: string }
  | { type: "steer"; id: string }
  | { type: "event-ack"; id: string }
  | InvokeReply
  | ShutdownRequest;

export type ToolManifest = {
  name: string;
  description: string;
  parameters?: unknown;
  customFormat?: { syntax: "lark" | "regex"; definition: string };
  customWireName?: string;
};

export type ReadyMessage = {
  type: "ready";
  protocolVersion: number;
  host?: "omp";
  ompVersion?: string;
  hostVersion?: string;
  toolRuntimeVersion?: string;
  runtimeVersion?: string;
  cwd?: string;
  editMode?: OmpEditMode;
  resourceBinding?: string;
  tools: ToolManifest[];
  capabilities?: Record<string, unknown>;
};

export type UpdateMessage = { type: "update"; id: string; result: unknown };
export type ResultMessage = { type: "result"; id: string; result: unknown };
export type CaptureMessage = { type: "capture"; id: string; capture: JobCapturePayload };
export type ErrorMessage = {
  type: "error";
  id?: string;
  error: { name: string; message: string; stack?: string };
};
/** Unsolicited worker-originated notification (no request id). */
export type EventMessage = {
  type: "event";
  event: "launch-completion";
  payload: Record<string, unknown>;
};
export type Message =
  | ReadyMessage
  | UpdateMessage
  | ResultMessage
  | CaptureMessage
  | ErrorMessage
  | InvokeMessage
  | { type: "invoke-cancel"; id: string }
  | EventMessage;

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string")
    throw new Error(`Protocol field ${key} must be a string`);
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field))
    throw new Error(`Protocol field ${key} must be a number`);
  return field;
}


export function parseRequest(raw: unknown): Request {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const value = asRecord(parsed, "Request");
  const type = value.type;
  if (type === "initialize") {
    const tools = value.tools;
    if (
      !Array.isArray(tools) ||
      !tools.every((tool) => typeof tool === "string")
    ) {
      throw new Error("Protocol field tools must be a string array");
    }
    const bashServices = value.bashServices;
    if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0))
      throw new Error("Protocol field sessionId must be a non-empty string");
    if (bashServices !== undefined && typeof bashServices !== "boolean")
      throw new Error("Protocol field bashServices must be a boolean");
    return {
      type,
      protocolVersion: numberField(value, "protocolVersion"),
      ...(typeof value.host === "string"
        ? { host: value.host as "omp" }
        : {}),
      ...(typeof value.ompVersion === "string"
        ? { ompVersion: value.ompVersion }
        : {}),
      ...(typeof value.hostVersion === "string"
        ? { hostVersion: value.hostVersion }
        : {}),
      runtimeVersion: stringField(value, "runtimeVersion"),
      cwd: stringField(value, "cwd"),
      tools,
      ...(value.editMode === undefined ? {} : { editMode: parseOmpEditMode(value.editMode) }),
      ...(bashServices === undefined ? {} : { bashServices }),
      ...(value.resourceBinding === undefined ? {} : { resourceBinding: parseResourceBinding(value.resourceBinding) }),
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
      ...(value.settings === undefined
        ? {}
        : { settings: parseExecutionSettings(value.settings) }),
    };
  }
  if (type === "execute") {
    const toolNames = value.toolNames;
    if (
      toolNames !== undefined &&
      !(Array.isArray(toolNames) && toolNames.every((name) => typeof name === "string"))
    ) {
      throw new Error("Protocol field toolNames must be a string array");
    }
    if (value.steering !== undefined && typeof value.steering !== "boolean") {
      throw new Error("Protocol field steering must be a boolean");
    }
    if (value.bashScope !== undefined) {
      const name = asRecord(value.args, "args").name;
      const named = name !== undefined && !(typeof name === "string" && name.trim() === "");
      if ((value.bashScope !== "job" && value.bashScope !== "session") || value.tool !== "bash" || named) {
        throw new Error("Protocol bashScope is only valid for unnamed bash jobs");
      }
    }
    return {
      type,
      id: stringField(value, "id"),
      toolCallId: stringField(value, "toolCallId"),
      tool: stringField(value, "tool"),
      args: asRecord(value.args, "args"),
      ...(toolNames === undefined ? {} : { toolNames: toolNames as string[] }),
      ...(value.steering === undefined ? {} : { steering: value.steering as boolean }),
      ...(value.bashScope === "job" || value.bashScope === "session" ? { bashScope: value.bashScope } : {}),
    };
  }
  if (type === "invoke-result" || type === "invoke-update") {
    if (!("result" in value)) throw new Error(`Protocol ${type} requires result`);
    return { type, id: stringField(value, "id"), result: value.result };
  }
  if (type === "invoke-error") {
    const error = asRecord(value.error, "error");
    return { type, id: stringField(value, "id"), error: { name: stringField(error, "name"), message: stringField(error, "message") } };
  }
  if (type === "service-stop") {
    const name = stringField(value, "name");
    const instanceId = stringField(value, "instanceId");
    const id = stringField(value, "id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name) || !instanceId.trim() || !id.trim())
      throw new Error("Protocol service-stop requires a service name and non-empty instanceId/id");
    return { type, id, name, instanceId };
  }
  if (type === "cancel") return { type, id: stringField(value, "id") };
  if (type === "steer") return { type, id: stringField(value, "id") };
  if (type === "event-ack") return { type, id: stringField(value, "id") };
  if (type === "shutdown") return { type };
  throw new Error(`Unknown protocol request type: ${type}`);
}

function parseToolLanguage(tool: Record<string, unknown>): Pick<ToolManifest, "customFormat" | "customWireName"> {
  const { customFormat, customWireName } = tool;
  if (customWireName !== undefined && typeof customWireName !== "string")
    throw new Error("Protocol tool customWireName must be a string");
  let language: ToolManifest["customFormat"];
  if (customFormat !== undefined) {
    if (!isRecord(customFormat))
      throw new Error("Protocol tool customFormat must be a Lark or regex grammar");
    const { syntax, definition } = customFormat;
    if ((syntax !== "lark" && syntax !== "regex") || typeof definition !== "string")
      throw new Error("Protocol tool customFormat must be a Lark or regex grammar");
    language = { syntax, definition };
  }
  return {
    ...(customWireName === undefined ? {} : { customWireName }),
    ...(language === undefined ? {} : { customFormat: language }),
  };
}

export function parseMessage(line: string): Message {
  const value = asRecord(JSON.parse(line), "Message");
  const type = stringField(value, "type");
  if (type === "ready") {
    if (!Array.isArray(value.tools))
      throw new Error("Protocol field tools must be an array");
    const tools = value.tools.map((tool) => {
      if (!isRecord(tool)) throw new Error("Invalid tool manifest");
      return {
        name: stringField(tool, "name"),
        description: stringField(tool, "description"),
        ...("parameters" in tool ? { parameters: tool.parameters } : {}),
        ...parseToolLanguage(tool),
      };
    });
    return {
      type,
      protocolVersion: numberField(value, "protocolVersion"),
      ...(typeof value.host === "string"
        ? { host: value.host as "omp" }
        : {}),
      ...(typeof value.ompVersion === "string"
        ? { ompVersion: value.ompVersion }
        : {}),
      ...(typeof value.hostVersion === "string"
        ? { hostVersion: value.hostVersion }
        : {}),
      ...(typeof value.runtimeVersion === "string"
        ? { runtimeVersion: value.runtimeVersion }
        : {}),
      ...(typeof value.toolRuntimeVersion === "string"
        ? { toolRuntimeVersion: value.toolRuntimeVersion }
        : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(value.editMode === undefined ? {} : { editMode: parseOmpEditMode(value.editMode) }),
      ...(value.resourceBinding === undefined ? {} : { resourceBinding: parseResourceBinding(value.resourceBinding) }),
      tools,
      ...(isRecord(value.capabilities)
        ? { capabilities: value.capabilities }
        : {}),
    };
  }
  if (type === "invoke") {
    return {
      type, id: stringField(value, "id"), parentId: stringField(value, "parentId"),
      resourceBinding: parseResourceBinding(value.resourceBinding),
      tool: stringField(value, "tool"), toolCallId: stringField(value, "toolCallId"),
      args: asRecord(value.args, "args"),
    };
  }
  if (type === "invoke-cancel") return { type, id: stringField(value, "id") };
  if (type === "capture") {
    return { type, id: stringField(value, "id"), capture: parseJobCapturePayload(value.capture) };
  }
  if (type === "update" || type === "result") {
    if (!("result" in value))
      throw new Error(`Protocol ${type} message is missing result`);
    return { type, id: stringField(value, "id"), result: value.result };
  }
  if (type === "event") {
    const event = stringField(value, "event");
    if (event !== "launch-completion")
      throw new Error(`Unknown protocol event: ${event}`);
    return { type, event, payload: asRecord(value.payload, "payload") };
  }
  if (type === "error") {
    if (!isRecord(value.error))
      throw new Error("Protocol field error must be an object");
    const id = value.id;
    const stack = value.error.stack;
    if (id !== undefined && typeof id !== "string")
      throw new Error("Protocol field id must be a string");
    if (stack !== undefined && typeof stack !== "string")
      throw new Error("Protocol error stack must be a string");
    return {
      type,
      ...(id === undefined ? {} : { id }),
      error: {
        name: stringField(value.error, "name"),
        message: stringField(value.error, "message"),
        ...(stack === undefined ? {} : { stack }),
      },
    };
  }
  throw new Error(`Unknown protocol message type: ${type}`);
}

export function encodeMessage(message: Request | Message): string {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    throw new Error(`Protocol frame exceeds ${MAX_FRAME_BYTES} bytes`);
  return frame;
}

export async function* decodeFrames(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  let fragments: Uint8Array[] = [];
  let size = 0;
  const append = (fragment: Uint8Array): void => {
    size += fragment.byteLength;
    if (size > MAX_FRAME_BYTES)
      throw new Error(`Protocol frame exceeds ${MAX_FRAME_BYTES} bytes`);
    if (fragment.byteLength > 0) fragments.push(fragment);
  };
  const finish = (): string => {
    const line = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(fragments, size),
    );
    fragments = [];
    size = 0;
    return line;
  };

  for await (const chunk of chunks) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 0x0a) continue;
      append(chunk.subarray(start, index));
      yield finish();
      start = index + 1;
    }
    append(chunk.subarray(start));
  }
  if (size > 0) yield finish();
}
