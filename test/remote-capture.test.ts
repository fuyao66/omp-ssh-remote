import { describe, expect, test } from "bun:test";
import { PipeTextSource } from "@oh-my-pi/pi-coding-agent/job-widgets/pipe-source";
import { JobWidgetRuntime } from "@oh-my-pi/pi-coding-agent/job-widgets/runtime";
import {
  CAPTURE_PIPE_CHUNK_BYTES,
  CAPTURE_TEXT_CHUNK_UNITS,
  OUTPUT_CAPTURE_UNITS,
  PIPE_CAPTURE_BYTES,
  type JobCapturePayload,
} from "../src/omp/job-capture.ts";
import { RemoteJobCapture } from "../src/omp/remote-capture.ts";

function pipe(
  capture: RemoteJobCapture,
  bytes: Uint8Array,
  start = 0,
  open = true,
  id = 1,
  total = start + bytes.length,
): void {
  capture.apply({
    kind: "pipe",
    info: { id, producer: "producer", consumer: "consumer", total, open },
    start,
    end: start + bytes.length,
    dataBase64: Buffer.from(bytes).toString("base64"),
  });
}

function output(capture: RemoteJobCapture, text: string, start = 0, open = true): void {
  capture.apply({ kind: "output", start, end: start + text.length, text, open });
}

function source(capture: RemoteJobCapture, id: string) {
  const found = capture.sources().find(candidate => candidate.id === id);
  if (!found) throw new Error(`Missing source ${id}`);
  return found;
}

describe("remote native job capture", () => {
  test("native PipeTextSources keep their decoder across split UTF-8 and reset at byte gaps", () => {
    const capture = new RemoteJobCapture();
    const bytes = Buffer.from("😀 café");
    pipe(capture, bytes.subarray(0, 2));
    const text = source(capture, "pipe:1");
    expect(text).toBeInstanceOf(PipeTextSource);
    expect(text.read(0)).toEqual({ start: 0, end: 2, text: "", open: true });
    pipe(capture, bytes.subarray(2), 2);
    expect(source(capture, "pipe:1")).toBe(text);
    expect(text.read(2)).toEqual({ start: 2, end: bytes.length, text: "😀 café", open: true });

    // A continuation byte after a lost interval must not complete earlier UTF-8.
    pipe(capture, Buffer.from([0xc3]), bytes.length);
    expect(text.read(bytes.length).text).toBe("");
    pipe(capture, Buffer.from([0xa9, 0x0a]), 100);
    expect(text.read(bytes.length + 1)).toEqual({ start: 100, end: 102, text: "�\n", open: true });
    expect(capture.streams.read(1, 0)?.data).toEqual(Buffer.from([0xa9, 0x0a]));
    expect(text.read(100).text).toBe("�\n");
  });

  test("an empty final pipe chunk flushes native decoder state", () => {
    const capture = new RemoteJobCapture();
    pipe(capture, Buffer.from([0xf0, 0x9f]));
    const text = source(capture, "pipe:1");
    expect(text.read(0).text).toBe("");
    pipe(capture, Buffer.alloc(0), 2, false);
    expect(text.read(2)).toEqual({ start: 2, end: 2, text: "�", open: false });
    expect(text.read(2)).toEqual({ start: 2, end: 2, text: "", open: false });
  });

  test("retains exactly the newest 256 Ki UTF-16 units with absolute cursors", () => {
    const capture = new RemoteJobCapture();
    const text = "😀abc".repeat(Math.ceil((OUTPUT_CAPTURE_UNITS + 37) / 5));
    for (let start = 0; start < text.length; start += CAPTURE_TEXT_CHUNK_UNITS) {
      output(capture, text.slice(start, start + CAPTURE_TEXT_CHUNK_UNITS), start);
    }
    const out = source(capture, "out");
    const retained = text.length - OUTPUT_CAPTURE_UNITS;
    expect(out.read(0)).toEqual({ start: retained, end: text.length, text: text.slice(retained), open: true });
    expect(out.read(retained + 3).text).toBe(text.slice(retained + 3));
    expect(out.read(text.length + 10)).toEqual({ start: text.length, end: text.length, text: "", open: true });
    expect(source(capture, "out")).toBe(out);
  });

  test("retains exactly the newest 1 MiB of real pipe bytes and implements native retained reads", () => {
    const capture = new RemoteJobCapture();
    const bytes = Buffer.alloc(PIPE_CAPTURE_BYTES + 123);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    for (let start = 0; start < bytes.length; start += CAPTURE_PIPE_CHUNK_BYTES) {
      pipe(capture, bytes.subarray(start, start + CAPTURE_PIPE_CHUNK_BYTES), start, true, 1, bytes.length);
    }
    const retained = bytes.length - PIPE_CAPTURE_BYTES;
    const chunk = capture.streams.read(1, 0);
    expect(chunk).toEqual({ start: retained, end: bytes.length, data: bytes.subarray(retained), open: true });
    expect(Buffer.isBuffer(chunk?.data)).toBe(true);
    expect(capture.streams.read(1)).toEqual(chunk);
    expect(capture.streams.read(1, null)).toEqual(chunk);
    expect(capture.streams.read(1, -100)).toEqual(chunk);
    expect(capture.streams.read(1, retained + 3.9)?.data).toEqual(bytes.subarray(retained + 3));
    expect(capture.streams.read(1, bytes.length + 50)).toEqual({
      start: bytes.length, end: bytes.length, data: Buffer.alloc(0), open: true,
    });
    expect(capture.streams.read(99, 0)).toBeNull();
    expect("pids" in capture.streams).toBe(false);
    chunk!.data.fill(0);
    expect(capture.streams.read(1, retained)?.data).toEqual(bytes.subarray(retained));
    const info = capture.streams.list()[0]!;
    info.total = 0;
    expect(capture.streams.list()[0]!.total).toBe(bytes.length);
  });

  test("forward output and pipe gaps discard only the unavailable prefix, never fill or concatenate it", () => {
    const capture = new RemoteJobCapture();
    output(capture, "old");
    output(capture, "new", 20);
    expect(source(capture, "out").read(3)).toEqual({ start: 20, end: 23, text: "new", open: true });
    output(capture, "!", 23);
    expect(source(capture, "out").read(0).text).toBe("new!");
    pipe(capture, Buffer.from("old"));
    pipe(capture, Buffer.from("new"), 20);
    pipe(capture, Buffer.from("!"), 23);
    expect(capture.streams.read(1, 3)).toEqual({ start: 20, end: 24, data: Buffer.from("new!"), open: true });
  });

  test("retained pipe snapshots remove absent streams and close their existing text sources", () => {
    const capture = new RemoteJobCapture();
    pipe(capture, Buffer.from("one"));
    pipe(capture, Buffer.from("two"), 0, true, 2);
    const one = source(capture, "pipe:1");
    const two = source(capture, "pipe:2");
    capture.apply({ kind: "pipes", ids: [2] });
    expect(capture.streams.list().map(info => info.id)).toEqual([2]);
    expect(capture.sources().map(text => text.id)).toEqual(["out", "pipe:2"]);
    expect(source(capture, "pipe:2")).toBe(two);
    expect(capture.streams.read(1, 0)).toBeNull();
    expect(one.read(3)).toEqual({ start: 3, end: 3, text: "", open: false });
    capture.apply({ kind: "pipes", ids: [] });
    expect(capture.sources().map(text => text.id)).toEqual(["out"]);
  });

  test("close freezes all real captures and ignores even malformed late updates", () => {
    const capture = new RemoteJobCapture();
    output(capture, "kept");
    pipe(capture, Buffer.from("bytes"));
    const sources = capture.sources();
    capture.close();
    capture.close();
    output(capture, "late", 4);
    pipe(capture, Buffer.from("late"), 5);
    capture.apply({ kind: "pipes", ids: [] });
    capture.apply({ kind: "invalid" } as unknown as JobCapturePayload);
    expect(capture.sources()).toEqual(sources);
    expect(sources[0]!.read(0)).toEqual({ start: 0, end: 4, text: "kept", open: false });
    expect(sources[1]!.read(0)).toEqual({ start: 0, end: 5, text: "bytes", open: false });
    expect(capture.streams.list()[0]!.open).toBe(false);
  });

  test("rejects overlapping, malformed, reopened, or backward metadata chunks without corrupting retained data", () => {
    const capture = new RemoteJobCapture();
    output(capture, "abcd");
    expect(() => output(capture, "bad", 2)).toThrow(/Nonmonotonic/);
    expect(() => capture.apply({ kind: "output", start: 4, end: 10, text: "x", open: true })).toThrow();
    expect(() => output(capture, "x".repeat(CAPTURE_TEXT_CHUNK_UNITS + 1), 4)).toThrow();
    expect(source(capture, "out").read(0).text).toBe("abcd");
    output(capture, "", 4, false);
    expect(() => output(capture, "x", 4)).toThrow(/closed/);

    pipe(capture, Buffer.from("abcd"), 0, true, 1, 10);
    expect(() => pipe(capture, Buffer.from("bad"), 2, true, 1, 10)).toThrow(/Nonmonotonic/);
    expect(() => pipe(capture, Buffer.from("x"), 4, true, 1, 5)).toThrow(/Nonmonotonic/);
    expect(() => capture.apply({ kind: "pipe", start: 4, end: 5, dataBase64: "!!!", info: {
      id: 1, producer: "producer", consumer: "consumer", total: 10, open: true,
    } })).toThrow();
    expect(() => pipe(capture, Buffer.alloc(CAPTURE_PIPE_CHUNK_BYTES + 1), 4)).toThrow();
    expect(capture.streams.read(1)?.data).toEqual(Buffer.from("abcd"));
    pipe(capture, Buffer.from("efghij"), 4, false);
    expect(() => pipe(capture, Buffer.from("x"), 10)).toThrow(/closed/);
    expect(capture.streams.read(1)?.data).toEqual(Buffer.from("abcdefghij"));
  });

  test("the native widget runtime consumes genuine incremental captures exactly once", () => {
    const capture = new RemoteJobCapture();
    const runtime = new JobWidgetRuntime(undefined, 1000, () => 2000);
    output(capture, "first\npar");
    pipe(capture, Buffer.from("piped\n"));
    expect(runtime.ingest(capture.sources(), false)).toBe(true);
    expect(runtime.totalLines).toBe(2);
    expect(runtime.ingest(capture.sources(), false)).toBe(false);
    expect(runtime.totalLines).toBe(2);
    output(capture, "tial\n", 9);
    expect(runtime.ingest(capture.sources(), false)).toBe(true);
    expect(runtime.totalLines).toBe(3);
    expect(runtime.samples().find(sample => sample.id === "out")?.head).toEqual(["first", "partial"]);
    output(capture, "torn\nretained\n", 100);
    expect(runtime.ingest(capture.sources(), false)).toBe(true);
    expect(runtime.totalLines).toBe(4);
    expect(runtime.samples().find(sample => sample.id === "out")?.head).toEqual(["first", "partial", "retained"]);
    capture.close();
    expect(runtime.ingest(capture.sources(), true)).toBe(false);
    expect(runtime.ingest(capture.sources(), true)).toBe(false);
    expect(runtime.totalLines).toBe(4);
  });
});
