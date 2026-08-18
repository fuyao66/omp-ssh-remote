import { describe, expect, test } from "bun:test";
import { SUPPORTED_PLATFORMS } from "../src/deploy.ts";

describe("remote worker platform mapping", () => {
  test("maps Linux/aarch64 to arm64 worker", () => {
    expect(SUPPORTED_PLATFORMS["Linux/aarch64"]).toBe("arm64");
  });

  test("maps Linux/x86_64 to x64 worker", () => {
    expect(SUPPORTED_PLATFORMS["Linux/x86_64"]).toBe("x64");
  });

  test("rejects unsupported platforms", () => {
    expect(SUPPORTED_PLATFORMS["Darwin/arm64"]).toBeUndefined();
    expect(SUPPORTED_PLATFORMS["Linux/riscv64"]).toBeUndefined();
  });
});
