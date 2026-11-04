import { LANGUAGE_PACK_NODE_PIN, type LanguagePackArchitecture, type LanguagePackDescriptor } from "./language-pack.ts";
export { sha256 } from "./language-pack.ts";
export type PythonLspArchitecture = LanguagePackArchitecture;
export const PYTHON_LSP_PINS = {
  node: LANGUAGE_PACK_NODE_PIN,
  pyright: {
    version: "1.1.407",
    url: "https://registry.npmjs.org/pyright/-/pyright-1.1.407.tgz",
    integrity: "sha512-zU+peTFEVUdokNQyUBhGQYt+NWI/3aiNlvBbDBSsn5Ti334XElFUs+GDjQzCbchYfkT+DvMAT3OkMcV4CuEfDg==",
  },
} as const;

export type PythonLspPackDescriptor = LanguagePackDescriptor;
