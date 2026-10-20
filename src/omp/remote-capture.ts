import type { AsyncJobProcess } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { PipeTextSources } from "@oh-my-pi/pi-coding-agent/job-widgets/pipe-source";
import type { JobTextChunk, JobTextSource } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import {
  OUTPUT_CAPTURE_UNITS,
  PIPE_CAPTURE_BYTES,
  parseJobCapturePayload,
  type JobCapturePayload,
  type RemotePipeInfo,
} from "./job-capture.ts";

type PipeStreams = NonNullable<AsyncJobProcess["streams"]>;

/** An offset-bearing tap: a missing interval is a gap, never synthetic text. */
class RemoteOutputSource implements JobTextSource {
  readonly id = "out";
  readonly label = "Command output";
  #text = "";
  #start = 0;
  #end = 0;
  #open = true;

  append(payload: Extract<JobCapturePayload, { kind: "output" }>): void {
    if (payload.start < this.#end || !this.#open) throw new Error("Nonmonotonic or closed output capture");
    if (payload.start > this.#end) this.#text = "";
    this.#text = (this.#text + payload.text).slice(-OUTPUT_CAPTURE_UNITS);
    this.#end = payload.end;
    this.#start = this.#end - this.#text.length;
    this.#open = payload.open;
  }

  close(): void {
    this.#open = false;
  }

  read(from: number): JobTextChunk {
    const start = Math.min(Math.max(from, this.#start), this.#end);
    return { start, end: this.#end, text: this.#text.slice(start - this.#start), open: this.#open };
  }
}

interface MirroredPipe {
  info: RemotePipeInfo;
  start: number;
  end: number;
  data: Buffer;
}

/** Native-readable capture for one remote job; it owns no processes or previews. */
export class RemoteJobCapture {
  readonly #output = new RemoteOutputSource();
  readonly #pipes = new Map<number, MirroredPipe>();
  readonly #pipeSources: PipeTextSources;
  #closed = false;

  /** Only the native read/list surface is mirrored; process ownership stays remote. */
  readonly streams: PipeStreams;

  constructor() {
    this.streams = {
      list: () => [...this.#pipes.values()].map(pipe => ({ ...pipe.info })),
      read: (id: number, from?: number | null) => {
        const pipe = this.#pipes.get(id);
        if (!pipe) return null;
        const requested = from == null ? pipe.start : Math.trunc(Math.max(0, Number.isNaN(from) ? 0 : from));
        const start = Math.min(Math.max(requested, pipe.start), pipe.end);
        return { start, end: pipe.end, data: Buffer.from(pipe.data.subarray(start - pipe.start)), open: pipe.info.open };
      },
    };
    this.#pipeSources = new PipeTextSources(this.streams);
  }

  apply(payload: JobCapturePayload): void {
    if (this.#closed) return;
    // The mirror is also usable directly, without the transport parser in front of it.
    payload = parseJobCapturePayload(payload);
    if (payload.kind === "output") {
      this.#output.append(payload);
      return;
    }
    if (payload.kind === "pipes") {
      const ids = new Set(payload.ids);
      for (const id of this.#pipes.keys()) {
        if (!ids.has(id)) this.#pipes.delete(id);
      }
      return;
    }
    const previous = this.#pipes.get(payload.info.id);
    if (previous && (
      payload.start < previous.end ||
      payload.info.total < previous.info.total ||
      !previous.info.open ||
      payload.info.producer !== previous.info.producer ||
      payload.info.consumer !== previous.info.consumer
    )) throw new Error("Nonmonotonic or closed pipe capture");
    const bytes = Buffer.from(payload.dataBase64, "base64");
    const retained = previous && payload.start === previous.end ? previous.data : Buffer.alloc(0);
    const length = Math.min(PIPE_CAPTURE_BYTES, retained.length + bytes.length);
    const data = Buffer.alloc(length);
    const kept = Math.min(retained.length, length - bytes.length);
    if (kept > 0) data.set(retained.subarray(retained.length - kept));
    data.set(bytes, kept);
    this.#pipes.set(payload.info.id, {
      info: { ...payload.info },
      start: payload.end - length,
      end: payload.end,
      data,
    });
  }

  sources(): readonly JobTextSource[] {
    return [this.#output, ...this.#pipeSources.list()];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#output.close();
    for (const pipe of this.#pipes.values()) pipe.info.open = false;
  }
}
