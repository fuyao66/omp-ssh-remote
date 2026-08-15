function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export const PROTOCOL_VERSION = 1 as const;
export const TOOL_RUNTIME_VERSION = "0.3.0" as const;
export const OMP_VERSION = "17.3.3" as const;
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

export type InitializeRequest = {
  type: "initialize";
  protocolVersion: number;
  ompVersion: string;
  runtimeVersion: string;
  cwd: string;
  tools: string[];
};

export type ExecuteRequest = {
  type: "execute";
  id: string;
  toolCallId: string;
  tool: RemoteToolName;
  args: Record<string, unknown>;
};

export type CancelRequest = { type: "cancel"; id: string };
export type ShutdownRequest = { type: "shutdown" };
export type Request =
  InitializeRequest | ExecuteRequest | CancelRequest | ShutdownRequest;

export type ToolManifest = {
  name: string;
  description: string;
  parameters?: unknown;
};

export type ReadyMessage = {
  type: "ready";
  protocolVersion: number;
  ompVersion: string;
  runtimeVersion: string;
  cwd: string;
  tools: ToolManifest[];
};

export type UpdateMessage = { type: "update"; id: string; result: unknown };
export type ResultMessage = { type: "result"; id: string; result: unknown };
export type ErrorMessage = {
  type: "error";
  id?: string;
  error: { name: string; message: string; stack?: string };
};
export type Message =
  ReadyMessage | UpdateMessage | ResultMessage | ErrorMessage;

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

function parseJsonObject(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("Protocol message must be an object");
  return value;
}

export function parseRequest(line: string): Request {
  const value = parseJsonObject(line);
  const type = stringField(value, "type");
  if (type === "initialize") {
    const tools = value.tools;
    if (
      !Array.isArray(tools) ||
      !tools.every((tool) => typeof tool === "string")
    ) {
      throw new Error("Protocol field tools must be a string array");
    }
    return {
      type,
      protocolVersion: numberField(value, "protocolVersion"),
      ompVersion: stringField(value, "ompVersion"),
      runtimeVersion: stringField(value, "runtimeVersion"),
      cwd: stringField(value, "cwd"),
      tools,
    };
  }
  if (type === "execute") {
    const tool = stringField(value, "tool");
    if (!REMOTE_TOOL_NAMES.includes(tool as RemoteToolName))
      throw new Error(`Unknown remote tool: ${tool}`);
    if (!isRecord(value.args))
      throw new Error("Protocol field args must be an object");
    return {
      type,
      id: stringField(value, "id"),
      toolCallId: stringField(value, "toolCallId"),
      tool: tool as RemoteToolName,
      args: value.args,
    };
  }
  if (type === "cancel") return { type, id: stringField(value, "id") };
  if (type === "shutdown") return { type };
  throw new Error(`Unknown protocol request type: ${type}`);
}

export function parseMessage(line: string): Message {
  const value = parseJsonObject(line);
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
      };
    });
    return {
      type,
      protocolVersion: numberField(value, "protocolVersion"),
      ompVersion: stringField(value, "ompVersion"),
      runtimeVersion: stringField(value, "runtimeVersion"),
      cwd: stringField(value, "cwd"),
      tools,
    };
  }
  if (type === "update" || type === "result") {
    if (!("result" in value))
      throw new Error(`Protocol ${type} message is missing result`);
    return { type, id: stringField(value, "id"), result: value.result };
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
