import { LANGUAGE_PACK_NODE_PIN, type LanguagePackArchitecture, type LanguagePackDescriptor } from "./language-pack.ts";

// Published TLS cli.mjs bundles all dependencies. Both npm packages have no runtime dependency edges.
export const TYPESCRIPT_LSP_PINS = {
  node: LANGUAGE_PACK_NODE_PIN,
  server: {
    version: "4.3.4",
    url: "https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-4.3.4.tgz",
    integrity: "sha512-0pQ4ffAarsf10VwFhyyyqNJhuDd4r6f4dSsQN38WdbQ3WVxqi08p/bI//v1VnOV5CSVd4AeOUY/jfJYheHTQPQ==",
  },
  typescript: {
    version: "5.8.3",
    url: "https://registry.npmjs.org/typescript/-/typescript-5.8.3.tgz",
    integrity: "sha512-p1diW6TqL9L07nNxvRMM7hMMw4c5XOo/1ibL4aAIGmSAt9slTE1Xgw5KWuof2uTOvCg9BY7ZRi+GaF+7sfgPeQ==",
  },
} as const;
export type TypescriptLspArchitecture = LanguagePackArchitecture;
export type TypescriptLspPackDescriptor = LanguagePackDescriptor;
