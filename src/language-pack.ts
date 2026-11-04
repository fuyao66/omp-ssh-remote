import { createHash } from "node:crypto";

export const LANGUAGE_PACK_NODE_PIN = {
  version: "22.22.0",
  checksums: "https://nodejs.org/dist/v22.22.0/SHASUMS256.txt",
  sha256: {
    arm64: "1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f",
    x64: "9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37",
  },
} as const;

export type LanguagePackArchitecture = "arm64" | "x64";
export interface LanguagePackDescriptor {
  format: 1;
  platform: "linux";
  arch: LanguagePackArchitecture;
  id: string;
  archiveSha256: string;
}
export function parseLanguagePackDescriptor(value: unknown, arch: LanguagePackArchitecture, label: string): LanguagePackDescriptor {
  const descriptor = value as LanguagePackDescriptor;
  if (!descriptor || descriptor.format !== 1 || descriptor.platform !== "linux" || descriptor.arch !== arch ||
    !/^[a-f0-9]{64}$/.test(descriptor.id) || !/^[a-f0-9]{64}$/.test(descriptor.archiveSha256)) {
    throw new Error(`Invalid ${label} LSP pack descriptor`);
  }
  return descriptor;
}
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
