import type { PythonServerCandidate } from "./python-lsp-fallback.ts";

/** Supply only the missing native default executable; native arguments and project intent win. */
export function applyCppLspFallback<T extends PythonServerCandidate>(
  candidates: Record<string, T>, servers: Record<string, T>,
  explicit: ReadonlyMap<string, ReadonlySet<string>>,
  rootMatches: (config: T) => boolean, launcher: string | undefined,
): void {
  if (!launcher) return;
  const clangd = candidates.clangd;
  if (!clangd || clangd.disabled || clangd.command !== "clangd" || servers.clangd || !rootMatches(clangd)) return;
  const intent = explicit.get("clangd");
  if (["command", "disabled", "fileTypes", "rootMarkers", "extensionToLanguage"].some(key => intent?.has(key))) return;
  const normalizeType = (type: string) => type.replace(/^\./, "").toLowerCase();
  const clangdTypes = new Set(clangd.fileTypes.map(normalizeType));
  for (const [name, candidate] of Object.entries(candidates)) {
    if (name === "clangd" || candidate.disabled || candidate.isLinter) continue;
    const semantic = name === "ccls" || /(?:^|\/)ccls$/.test(candidate.command) ||
      candidate.fileTypes.some(type => clangdTypes.has(normalizeType(type)));
    if (semantic && (explicit.has(name) || servers[name])) return;
  }
  servers.clangd = { ...clangd, resolvedCommand: launcher };
}
