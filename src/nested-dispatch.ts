import { AsyncLocalStorage } from "node:async_hooks";
import { REMOTE_TOOL_NAMES, type RemoteToolName } from "./protocol.ts";
import { pathShouldStayLocal } from "./path-domain.ts";
import { resourceExecutionTarget } from "./resource-routing.ts";
import type { OmpEditMode } from "./protocol.ts";
import { isReplyWrite } from "@oh-my-pi/pi-tui/chat/reply-write";

export const NESTED_TOOL_NAMES = REMOTE_TOOL_NAMES.filter(name => name !== "eval" && name !== "ast_edit");

/** The reply device carries prose, never a host file or remote filesystem path. */
export function isOutReplyWrite(name: string, args: Record<string, unknown>): boolean {
  return isReplyWrite(name, args) === true && typeof args.path === "string" && /^out:\/\//i.test(args.path);
}

/** Domain constraints are additional to, never a substitute for, host authorization. */
export function assertNestedRemoteTool(name: string, args: Record<string, unknown>, binding: string, editMode: OmpEditMode): asserts name is RemoteToolName {
  if (!NESTED_TOOL_NAMES.includes(name as (typeof NESTED_TOOL_NAMES)[number])) {
    throw new Error(`Eval tool.${name} is unavailable in the remote runtime`);
  }
  if (isOutReplyWrite(name, args)) return;
  const resource = resourceExecutionTarget(name as RemoteToolName, args, binding);
  if (!resource && pathShouldStayLocal(name as RemoteToolName, args, editMode)) {
    throw new Error(`Eval tool.${name} cannot access local internal URIs: host resource unavailable from the remote runtime; use a top-level host tool instead`);
  }
}

export type NestedDispatchScope = { assertCurrent(): void };
/** Retained through the native permission/tool_call chain, including rewritten arguments. */
export const nestedDispatchScope = new AsyncLocalStorage<NestedDispatchScope>();
