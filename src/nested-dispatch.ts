import { AsyncLocalStorage } from "node:async_hooks";
import { REMOTE_TOOL_NAMES, type RemoteToolName } from "./protocol.ts";
import { pathShouldStayLocal } from "./path-domain.ts";
import { resourceExecutionTarget } from "./resource-routing.ts";
import type { OmpEditMode } from "./protocol.ts";

export const NESTED_TOOL_NAMES = REMOTE_TOOL_NAMES.filter(name => name !== "eval" && name !== "ast_edit");

/** Domain constraints are additional to, never a substitute for, host authorization. */
export function assertNestedRemoteTool(name: string, args: Record<string, unknown>, binding: string, editMode: OmpEditMode): asserts name is RemoteToolName {
  if (!NESTED_TOOL_NAMES.includes(name as (typeof NESTED_TOOL_NAMES)[number])) {
    throw new Error(`Eval tool.${name} is unavailable in the remote runtime`);
  }
  const resource = resourceExecutionTarget(name as RemoteToolName, args, binding);
  if (!resource && pathShouldStayLocal(name as RemoteToolName, args, editMode)) {
    throw new Error(`Eval tool.${name} cannot access local internal URIs from the remote runtime`);
  }
}

export type NestedDispatchScope = { assertCurrent(): void };
/** Retained through the native permission/tool_call chain, including rewritten arguments. */
export const nestedDispatchScope = new AsyncLocalStorage<NestedDispatchScope>();
