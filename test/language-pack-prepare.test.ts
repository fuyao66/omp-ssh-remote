import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadPinned } from "../scripts/prepare-language-pack.ts";

let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "pack source cache ")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });

test("shared preparation verifies and reuses legacy source in place without download or duplicate", async () => {
  const shared = join(work, "shared"); const legacy = join(work, "python legacy");
  await mkdir(shared); await mkdir(legacy);
  const bytes = Buffer.from("pinned Node source fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const original = join(legacy, "node.tar.xz"); await writeFile(original, bytes);
  const inode = (await stat(original)).ino;
  const result = await downloadPinned(shared, "https://invalid.invalid/node.tar.xz", "node.tar.xz", "sha256", digest, [legacy]);
  expect(result).toBe(original); expect((await stat(result)).ino).toBe(inode);
  expect(await readFile(result)).toEqual(bytes);
  expect(await stat(join(shared, "node.tar.xz")).catch(() => undefined)).toBeUndefined();
});

test("legacy cache corruption fails closed rather than downloading or trusting the filename", async () => {
  const shared = join(work, "corrupt shared"); const legacy = join(work, "corrupt legacy");
  await mkdir(shared); await mkdir(legacy); await writeFile(join(legacy, "node.tar.xz"), "corrupt");
  await expect(downloadPinned(shared, "https://invalid.invalid/node.tar.xz", "node.tar.xz", "sha256", "0".repeat(64), [legacy])).rejects.toThrow("Cached upstream checksum mismatch");
});
