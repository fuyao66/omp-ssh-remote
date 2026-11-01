export interface PythonServerCandidate {
  command: string;
  fileTypes: string[];
  disabled?: boolean;
  settings?: unknown;
  resolvedCommand?: string;
  isLinter?: boolean;
}

const alternativePythonServers = new Set(["basedpyright", "basedpyright-langserver", "pylsp", "pyls", "jedi", "jedi-language-server"]);
function isSemanticPythonServer(name: string, config: PythonServerCandidate): boolean {
  // Ruff is a linter/formatter, not a replacement for Pyright's semantic features.
  if (config.isLinter || /ruff/i.test(name) || /(?:^|\/)ruff(?:-lsp)?$/.test(config.command)) return false;
  return alternativePythonServers.has(name) || /(?:basedpyright|pylsp|pyls|jedi-language-server)/.test(config.command) ||
    config.fileTypes.some(type => ["py", "pyi"].includes(type.toLowerCase().replace(/^\./, "")));
}

/** Only supplies the native default Pyright's missing executable; never changes native settings or arguments. */
export function applyPythonLspFallback<T extends PythonServerCandidate>(
  candidates: Record<string, T>,
  servers: Record<string, T>,
  explicit: ReadonlyMap<string, ReadonlySet<string>>,
  rootMatches: (config: T) => boolean,
  launcher: string | undefined,
): void {
  if (!launcher) return;
  const pyright = candidates.pyright;
  if (!pyright || pyright.disabled || pyright.command !== "pyright-langserver" || servers.pyright || !rootMatches(pyright)) return;
  const intent = explicit.get("pyright");
  if (["command", "disabled", "fileTypes", "rootMarkers", "extensionToLanguage"].some(key => intent?.has(key))) return;
  for (const [name, candidate] of Object.entries(candidates)) {
    if (name === "pyright" || candidate.disabled || !isSemanticPythonServer(name, candidate)) continue;
    // Explicit alternative configuration is intent even if its executable is missing.
    if (explicit.has(name) || servers[name]) return;
  }
  servers.pyright = { ...pyright, resolvedCommand: launcher };
}
