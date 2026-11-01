import { createHash } from "node:crypto";

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
