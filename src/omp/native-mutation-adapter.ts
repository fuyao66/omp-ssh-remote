import { resolve } from "node:path";

import { SDK_ADAPTATIONS, assertSdkAdaptationVersion, replaceSdkAnchor, type NativeMutationModule } from "./sdk-contract.ts";
export type { NativeMutationModule } from "./sdk-contract.ts";

/** Exact worker-only SDK adaptation: cancellation still propagates, but cannot abandon a mutating thunk. */
export function adaptNativeMutationSettlement(source: string, sdkVersion: string, module: NativeMutationModule, helper: string): string {
  const adaptation = module === "write" ? SDK_ADAPTATIONS.write
    : module === "ast-edit" ? SDK_ADAPTATIONS.astEdit : SDK_ADAPTATIONS.writethrough;
  assertSdkAdaptationVersion(adaptation, sdkVersion);
  source = replaceSdkAnchor(adaptation, source, "settlement",
    adaptation.anchors.settlement.text.replace("untilAborted", "awaitMutationSettled"));
  if (module === "writethrough") {
    // SDK 18.15 synthesizes an unverified diagnostics object to carry formatter
    // status after a late handoff. That placeholder must not abort the waiter.
    for (const [anchorId, result] of [["finalizeSingle", "diag"], ["finalizeBatch", "diagnostics"]] as const) {
      source = replaceSdkAnchor(adaptation, source, anchorId,
        `bundle?.finalize(${result}.diagnostics && !isUnverifiedOnly(${result}.diagnostics) ? ${result}.diagnostics : undefined);`);
    }
  }
  return `import { awaitMutationSettled } from ${JSON.stringify(resolve(helper))};\n` + source;
}
