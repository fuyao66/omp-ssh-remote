import { createHash } from "node:crypto";
import type { ToolApproval } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { RemoteConnectRequest } from "../connect-options.ts";
import { normalizePathArgument, pathShouldStayLocal } from "../path-domain.ts";
import type { RemoteToolName } from "../protocol.ts";
import { resolveLocalAsyncJobManager } from "./async-bash.ts";
import { processExecutionTarget } from "./process-routing.ts";

export type ApprovalTargetState = {
  selected: boolean;
  binding: string;
  remoteCwd?: string;
  sessionFile?: string;
  proposalSources: readonly ("local" | "remote")[];
  family?: { connection: RemoteConnectRequest };
};

type CacheTargets = (args: unknown) => readonly string[] | undefined;

function localTargets(name: RemoteToolName, args: Record<string, unknown>, state: ApprovalTargetState): boolean {
  if (!state.selected) return true;
  const processTarget = processExecutionTarget(name, args, id =>
    AgentRegistry.global().list().some(agent => agent.id === id)
      || (resolveLocalAsyncJobManager(state.sessionFile)?.getAllJobs().some(job => job.id === id) ?? false));
  if (processTarget) return processTarget === "local";
  if (name === "write") {
    const device = /^xd:\/\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(normalizePathArgument(args.path))?.[1]?.toLowerCase();
    if (device === "resolve" || device === "reject") return (state.proposalSources.at(-1) ?? "local") === "local";
    if (device && ["lsp", "ast_grep", "ast_edit", "debug"].includes(device)) {
      let inner: unknown;
      try { inner = typeof args.content === "string" ? JSON.parse(args.content) : undefined; } catch { return true; }
      // Actual dispatch also checks device availability asynchronously. A possible
      // remote dispatch must not reuse a local grant, even if it later stays local.
      return inner === null || typeof inner !== "object" || Array.isArray(inner)
        || pathShouldStayLocal(device as RemoteToolName, inner as Record<string, unknown>);
    }
    if (device) return true;
  }
  return pathShouldStayLocal(name, args);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

/**
 * Keep native local file/folder grants. Remote grants deliberately cover only an
 * exact request in one workspace binding: native target derivation stats the local
 * filesystem, so even namespacing its result can conflate remote literal paths and
 * selectors. A non-path key also prevents upstream from offering local folders.
 * Persisted remote grants do not survive reconnects or workspace switches.
 */
export function remoteWrapperApproval(
  name: RemoteToolName,
  nativeApproval: ToolApproval,
  nativeTargets: CacheTargets | undefined,
  getState: () => ApprovalTargetState,
): { approval: ToolApproval; approvalCacheTargets: CacheTargets; assertBinding: (args: unknown) => void } {
  const bindings = new WeakMap<object, string>();
  const assertBinding = (args: unknown): void => {
    if (args === null || typeof args !== "object") throw new Error("Workspace tool approval requires object arguments");
    const state = getState();
    const binding = `${state.binding}:${localTargets(name, args as Record<string, unknown>, state) ? "local" : "remote"}`;
    const previous = bindings.get(args);
    if (previous !== undefined && previous !== binding) {
      throw new Error("Workspace binding changed while this call was awaiting approval; execution was not retried in the new workspace. Recheck the current workspace before continuing.");
    }
    bindings.set(args, binding);
  };
  return {
    assertBinding,
    approval(args) {
      assertBinding(args);
      return typeof nativeApproval === "function" ? nativeApproval(args) : nativeApproval;
    },
    approvalCacheTargets(args) {
      assertBinding(args);
      const params = args as Record<string, unknown>;
      const state = getState();
      if (localTargets(name, params, state)) return nativeTargets?.(args);
      const connection = state.family?.connection;
      const { i: _intent, ...request } = params;
      // NUL makes this opaque key disjoint from filesystem paths and normal URLs.
      // Never return no targets for a remote read: cached mode would allow it.
      const scope = JSON.stringify([
        state.binding,
        connection?.target ?? null,
        connection?.port ?? null,
        connection?.identityFile ?? null,
        state.remoteCwd ?? null,
        name,
        stableValue(request),
      ]);
      return [`remote-request\0${createHash("sha256").update(scope).digest("hex")}`];
    },
  };
}
