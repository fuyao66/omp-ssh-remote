import { resolve } from "node:path";

export type NativeMutationModule = "write" | "ast-edit" | "writethrough";

/** Exact worker-only SDK adaptation: cancellation still propagates, but cannot abandon a mutating thunk. */
export function adaptNativeMutationSettlement(source: string, sdkVersion: string, module: NativeMutationModule, helper: string): string {
  if (sdkVersion !== "18.15.0") throw new Error(`Native mutation settlement adapter requires SDK 18.15.0, got ${sdkVersion}`);
  const anchor = module === "writethrough"
    ? "\t\tawait untilAborted(operationSignal, async () => {"
    : "\t\treturn untilAborted(signal, async () => {";
  if (source.split(anchor).length !== 2) throw new Error(`Native mutation settlement adapter anchor drift: ${module}`);
  source = source.replace(anchor, anchor.replace("untilAborted", "awaitMutationSettled"));
  if (module === "writethrough") {
    // SDK 18.15 synthesizes an unverified diagnostics object to carry formatter
    // status after a late handoff. That placeholder must not abort the waiter.
    for (const result of ["diag", "diagnostics"]) {
      const finalize = `bundle?.finalize(${result}.diagnostics);`;
      if (source.split(finalize).length !== 2) throw new Error(`Native deferred diagnostics finalize anchor drift: ${result}`);
      source = source.replace(finalize, `bundle?.finalize(${result}.diagnostics && !isUnverifiedOnly(${result}.diagnostics) ? ${result}.diagnostics : undefined);`);
    }
  }
  return `import { awaitMutationSettled } from ${JSON.stringify(resolve(helper))};\n` + source;
}
