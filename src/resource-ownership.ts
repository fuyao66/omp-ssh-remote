import { pathsShouldStayLocal, resourcePathOperands } from "./path-domain.ts";
import type { OmpEditMode, RemoteToolName } from "./protocol.ts";
import { validateBoundResourceOperands } from "./resource-routing.ts";
import { consumesProcessResources, processOperandExecutionTarget } from "./omp/process-routing.ts";

export type ResourceOwnershipState = {
  selected: boolean;
  binding: string;
  editMode?: OmpEditMode;
  isLocalProcessId: (id: string) => boolean;
};

/**
 * Shared host approval/dispatch ownership composition. Validate bound namespaces
 * before local-mode routing, then resolve process owners before returning a bound
 * conflict's remote owner. Undefined leaves ordinary paths and xdev policy to the
 * caller; it never means that a bound or process operand was skipped.
 */
export function resourceOwnershipTarget(
  name: RemoteToolName,
  params: Record<string, unknown>,
  state: ResourceOwnershipState,
): "local" | "remote" | undefined {
  const paths = resourcePathOperands(name, params, state.editMode);
  const bound = validateBoundResourceOperands(name, paths, state.selected ? state.binding : undefined);
  if (!state.selected) return "local";
  const process = consumesProcessResources(name) ? processOperandExecutionTarget(paths, state.isLocalProcessId) : undefined;
  if (process) return process;
  if (bound) {
    pathsShouldStayLocal(paths);
    return "remote";
  }
  return undefined;
}
