import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { ReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "../src/file-hash.ts";

let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "file hash ")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });

test("file SHA256 matches known empty and binary digests", async () => {
  const empty = join(work, "empty");
  const binary = join(work, "binary");
  await writeFile(empty, "");
  await writeFile(binary, Buffer.from([0, 1, 2, 255]));
  expect(await sha256File(empty)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(await sha256File(binary)).toBe(createHash("sha256").update(Buffer.from([0, 1, 2, 255])).digest("hex"));
});

test("hashes more than two chunks through bounded stream reads", async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 257);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const path = join(work, "chunk boundary");
  await writeFile(path, bytes);
  const reads: number[] = [];
  const original = ReadStream.prototype._read;
  const instrument = spyOn(ReadStream.prototype, "_read").mockImplementation(function (this: ReadStream, size: number) {
    reads.push(size);
    return original.call(this, size);
  });
  try {
    expect(await sha256File(path)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.every(size => size > 0 && size <= 1024 * 1024)).toBe(true);
  } finally {
    instrument.mockRestore();
  }
});

test("missing file preserves filesystem error code and pathname", async () => {
  const path = join(work, "missing");
  await expect(sha256File(path)).rejects.toMatchObject({ code: "ENOENT", path });
});
