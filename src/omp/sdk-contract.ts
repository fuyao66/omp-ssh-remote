/** Build-time SDK contract; companion admission uses runtime version and wire schemas instead. */
export const SUPPORTED_SDK_VERSION = "18.20.0";

export const SDK_ADAPTATIONS = {
  lspConfig: {
    id: "native-lsp-config",
    sdkModule: "@oh-my-pi/pi-coding-agent/lsp/config",
    upstreamPath: "packages/coding-agent/src/lsp/config.ts",
    purpose: "Apply private language-pack fallbacks without overriding explicit server fields",
    kind: "lsp-config",
    expectedBuildCount: 1,
    anchors: {
      imports: { text: 'import * as fs from "node:fs";', expectedCount: 1 },
      explicitFields: { text: "\tlet mergedServers = coerceServerConfigs(DEFAULTS);", expectedCount: 1 },
      merge: { text: "\t\tmergedServers = mergeServers(mergedServers, parsed.servers);", expectedCount: 1 },
      fallback: { text: "\tselectTypescriptServer(servers, cwd);", expectedCount: 1 },
    },
  },
  write: {
    id: "native-write-settlement",
    sdkModule: "@oh-my-pi/pi-coding-agent/tools/write",
    upstreamPath: "packages/coding-agent/src/tools/write.ts",
    purpose: "Propagate cancellation without abandoning an in-flight filesystem mutation",
    kind: "mutation",
    module: "write",
    expectedBuildCount: 1,
    anchors: {
      settlement: { text: "\t\treturn untilAborted(signal, async () => {", expectedCount: 1 },
    },
  },
  astEdit: {
    id: "native-ast-edit-settlement",
    sdkModule: "@oh-my-pi/pi-coding-agent/tools/ast-edit",
    upstreamPath: "packages/coding-agent/src/tools/ast-edit.ts",
    purpose: "Keep AST mutation ownership until the native operation settles after cancellation",
    kind: "mutation",
    module: "ast-edit",
    expectedBuildCount: 1,
    anchors: {
      settlement: { text: "\t\treturn untilAborted(signal, async () => {", expectedCount: 1 },
    },
  },
  writethrough: {
    id: "native-lsp-writethrough-settlement",
    sdkModule: "@oh-my-pi/pi-coding-agent/lsp/writethrough",
    upstreamPath: "packages/coding-agent/src/lsp/writethrough.ts",
    purpose: "Await mutating thunks and keep formatter-only placeholders from cancelling late diagnostics",
    kind: "mutation",
    module: "writethrough",
    expectedBuildCount: 1,
    anchors: {
      settlement: { text: "\t\tawait untilAborted(operationSignal, async () => {", expectedCount: 1 },
      finalizeSingle: { text: "bundle?.finalize(diag.diagnostics);", expectedCount: 1 },
      finalizeBatch: { text: "bundle?.finalize(diagnostics.diagnostics);", expectedCount: 1 },
    },
  },
} as const;

export type SdkAdaptation = (typeof SDK_ADAPTATIONS)[keyof typeof SDK_ADAPTATIONS];
export const SDK_SOURCE_ADAPTATIONS = Object.values(SDK_ADAPTATIONS);
export type NativeMutationModule = Extract<SdkAdaptation, { kind: "mutation" }>["module"];

export function sdkAdaptationLabel(adaptation: SdkAdaptation): string {
  return `${adaptation.id} (${adaptation.sdkModule}; upstream ${adaptation.upstreamPath})`;
}

export function assertSdkAdaptationVersion(adaptation: SdkAdaptation, sdkVersion: string): void {
  if (sdkVersion !== SUPPORTED_SDK_VERSION) {
    throw new Error(`${sdkAdaptationLabel(adaptation)} requires SDK ${SUPPORTED_SDK_VERSION}, got ${sdkVersion}; run bun run check:sdk and follow README's Upgrading OMP procedure`);
  }
}

/** Validate before replacing: missing and duplicate anchors both indicate unsupported upstream drift. */
export function replaceSdkAnchor(adaptation: SdkAdaptation, source: string, anchorId: string, replacement: string): string {
  const anchors: Readonly<Record<string, { readonly text: string; readonly expectedCount: number }>> = adaptation.anchors;
  const anchor = anchors[anchorId];
  if (!anchor) throw new Error(`${sdkAdaptationLabel(adaptation)} has no registered anchor ${anchorId}`);
  const count = source.split(anchor.text).length - 1;
  if (count !== anchor.expectedCount) {
    throw new Error(`${sdkAdaptationLabel(adaptation)} anchor drift at ${anchorId}: expected ${anchor.expectedCount}, got ${count}; review the installed upstream source before updating the adaptation`);
  }
  return source.replaceAll(anchor.text, replacement);
}

export function assertSdkBuildAdaptations(counts: ReadonlyMap<string, number>): void {
  for (const adaptation of SDK_SOURCE_ADAPTATIONS) {
    const count = counts.get(adaptation.id) ?? 0;
    if (count !== adaptation.expectedBuildCount) {
      throw new Error(`${sdkAdaptationLabel(adaptation)} build coverage: expected ${adaptation.expectedBuildCount} adapted module, got ${count}; check worker imports and adaptation plumbing`);
    }
  }
}
