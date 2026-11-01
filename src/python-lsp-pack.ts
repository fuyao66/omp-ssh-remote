import { parseLanguagePackDescriptor, type LanguagePackArchitecture, type LanguagePackDescriptor } from "./language-pack.ts";
export { sha256 } from "./language-pack.ts";
export type PythonLspArchitecture = LanguagePackArchitecture;
export const PYTHON_LSP_PINS = {
  node: {
    version: "22.22.0",
    checksums: "https://nodejs.org/dist/v22.22.0/SHASUMS256.txt",
    sha256: {
      arm64: "1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f",
      x64: "9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37",
    },
  },
  pyright: {
    version: "1.1.407",
    url: "https://registry.npmjs.org/pyright/-/pyright-1.1.407.tgz",
    integrity: "sha512-zU+peTFEVUdokNQyUBhGQYt+NWI/3aiNlvBbDBSsn5Ti334XElFUs+GDjQzCbchYfkT+DvMAT3OkMcV4CuEfDg==",
  },
} as const;

export type PythonLspPackDescriptor = LanguagePackDescriptor;

export function parsePythonLspPackDescriptor(value: unknown, arch: PythonLspArchitecture): PythonLspPackDescriptor {
  return parseLanguagePackDescriptor(value, arch, "Python");
}
