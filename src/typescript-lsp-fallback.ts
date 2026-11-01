import type { PythonServerCandidate } from "./python-lsp-fallback.ts";

export interface TypescriptServerCandidate extends PythonServerCandidate {
  initOptions?: Record<string, unknown>;
}
const fileTypes = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);
const supplementalServers = new Set(["tailwindcss", "tailwindcss-language-server", "vscode-html-language-server", "vscode-css-language-server", "vscode-json-language-server", "emmet-language-server"]);
function isSemanticTypescriptServer(name: string, config: TypescriptServerCandidate): boolean {
  if (supplementalServers.has(name) || supplementalServers.has(config.command.split("/").at(-1)!)) return false;
  if (config.isLinter || /eslint|biome|oxlint|quick-lint/i.test(name) || /eslint|biome|oxlint|quick-lint/.test(config.command)) return false;
  return /typescript|tsserver|tsgo|vtsls|deno/.test(name + " " + config.command) ||
    config.fileTypes.some(type => fileTypes.has(type.toLowerCase().replace(/^\./, "")));
}

/** Supply only the unresolved native TLS default; native TS7/project selection still runs afterward. */
export function applyTypescriptLspFallback<T extends TypescriptServerCandidate>(
  candidates: Record<string, T>,
  servers: Record<string, T>,
  explicit: ReadonlyMap<string, ReadonlySet<string>>,
  rootMatches: (config: T) => boolean,
  launcher: string | undefined,
): void {
  if (!launcher) return;
  const name = "typescript-language-server";
  const candidate = candidates[name];
  if (!candidate || candidate.command !== name || candidate.disabled || servers[name] || !rootMatches(candidate)) return;
  const intent = explicit.get(name);
  if (["command", "disabled", "fileTypes", "rootMarkers", "extensionToLanguage"].some(key => intent?.has(key))) return;
  for (const [otherName, other] of Object.entries(candidates)) {
    if (otherName === name || other.disabled || !isSemanticTypescriptServer(otherName, other)) continue;
    // Native selection probes tsc's version: TS5 tsc is not an LSP, TS7 tsc wins over TLS.
    if (otherName === "typescript-native" && !explicit.has(otherName)) continue;
    if (explicit.has(otherName) || servers[otherName]) return;
  }
  // Avoid unsolicited npm acquisition; an explicit project initialization option still wins.
  servers[name] = { ...candidate, initOptions: { disableAutomaticTypingAcquisition: true, ...candidate.initOptions }, resolvedCommand: launcher };
}
