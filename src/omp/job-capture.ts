/** Mirrors native OMP retention; offsets are UTF-16 units for text and bytes for pipes. */
export const OUTPUT_CAPTURE_UNITS = 256 * 1024;
export const PIPE_CAPTURE_BYTES = 1024 * 1024;
export const CAPTURE_TEXT_CHUNK_UNITS = 32 * 1024;
export const CAPTURE_PIPE_CHUNK_BYTES = 64 * 1024;
export const CAPTURE_STAGE_LABEL_UNITS = 4096;

export interface RemotePipeInfo {
  id: number;
  producer: string;
  consumer: string;
  total: number;
  open: boolean;
  file?: false;
  modified: number;
  node?: string;
}

export type JobCapturePayload =
  | { kind: "output"; start: number; end: number; text: string; open: boolean }
  | { kind: "pipe"; info: RemotePipeInfo; start: number; end: number; dataBase64: string }
  | { kind: "pipes"; ids: number[] };

/** Awaiting this callback applies transport backpressure; never fire-and-forget raw data. */
export type JobCaptureSender = (capture: JobCapturePayload) => Promise<void>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capture object");
  return value as Record<string, unknown>;
}

function offset(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid capture offset or id");
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid capture open flag");
  return value;
}

/** Validate the external transport boundary, including decoded byte lengths. */
export function parseJobCapturePayload(value: unknown): JobCapturePayload {
  const data = record(value);
  if (data.kind === "pipes") {
    if (!Array.isArray(data.ids)) throw new Error("Invalid capture pipe list");
    const ids = data.ids.map(id => offset(id, 1));
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate capture pipe id");
    return { kind: "pipes", ids };
  }
  const start = offset(data.start);
  const end = offset(data.end);
  if (end < start) throw new Error("Invalid capture interval");
  if (data.kind === "output") {
    if (typeof data.text !== "string" || data.text.length > CAPTURE_TEXT_CHUNK_UNITS || data.text.length !== end - start) throw new Error("Invalid capture text length");
    return { kind: "output", start, end, text: data.text, open: flag(data.open) };
  }
  if (data.kind === "pipe") {
    const info = record(data.info);
    if (typeof info.producer !== "string" || typeof info.consumer !== "string" || info.producer.length > CAPTURE_STAGE_LABEL_UNITS || info.consumer.length > CAPTURE_STAGE_LABEL_UNITS) throw new Error("Invalid capture stage label");
    if (info.file !== undefined && info.file !== false) throw new Error("Invalid capture pipe file flag");
    if (typeof info.modified !== "number" || !Number.isFinite(info.modified)) throw new Error("Invalid capture pipe modified time");
    if (info.node !== undefined && typeof info.node !== "string") throw new Error("Invalid capture pipe node");
    if (typeof data.dataBase64 !== "string" || data.dataBase64.length > 4 * Math.ceil(CAPTURE_PIPE_CHUNK_BYTES / 3)) throw new Error("Invalid capture byte payload");
    const bytes = Buffer.from(data.dataBase64, "base64");
    if (bytes.length > CAPTURE_PIPE_CHUNK_BYTES || bytes.length !== end - start || bytes.toString("base64") !== data.dataBase64) throw new Error("Invalid capture base64 or byte length");
    const total = offset(info.total);
    if (total < end) throw new Error("Invalid capture pipe total");
    return { kind: "pipe", start, end, dataBase64: data.dataBase64, info: {
      id: offset(info.id, 1), producer: info.producer, consumer: info.consumer, total, open: flag(info.open),
      ...(info.file !== undefined ? { file: info.file } : {}),
      modified: info.modified,
      ...(info.node !== undefined ? { node: info.node } : {}),
    } };
  }
  throw new Error("Unknown capture kind");
}
