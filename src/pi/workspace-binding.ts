import type { PiRemoteWorkspaceScope } from "./scope.ts";

export type WorkspacePhase = "local" | "connecting" | "remote" | "unavailable" | "closing";

export interface WorkspaceParticipant {
  suspend(): Promise<void>;
}

/** One session's execution domain. A failed transition never restores local IO. */
export class PiWorkspaceBinding {
  #phase: WorkspacePhase = "local";
  #generation = 0;
  #scope?: PiRemoteWorkspaceScope;
  #error?: Error;
  readonly #participants = new Set<WorkspaceParticipant>();

  get phase(): WorkspacePhase { return this.#phase; }
  get generation(): number { return this.#generation; }
  get selected(): boolean { return this.#phase !== "local"; }
  get scope(): PiRemoteWorkspaceScope | undefined { return this.#scope; }

  register(participant: WorkspaceParticipant): () => void {
    this.#participants.add(participant);
    return () => this.#participants.delete(participant);
  }

  async begin(): Promise<number> {
    if (this.#phase === "connecting" || this.#phase === "closing") {
      throw new Error(`Workspace transition already in progress: ${this.#phase}`);
    }
    this.#phase = "connecting";
    this.#error = undefined;
    const generation = ++this.#generation;
    try {
      await Promise.all([...this.#participants].map((participant) => participant.suspend()));
      await this.#scope?.close();
      this.#scope = undefined;
      return generation;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  commit(scope: PiRemoteWorkspaceScope, generation: number): void {
    if (generation !== this.#generation || this.#phase !== "connecting") {
      throw new Error("Remote workspace initialization belongs to an obsolete transition");
    }
    this.#scope = scope;
    this.#phase = "remote";
  }

  fail(error: unknown): void {
    this.#error = error instanceof Error ? error : new Error(String(error));
    this.#phase = "unavailable";
    ++this.#generation;
  }

  async close(force = false): Promise<void> {
    this.#phase = "closing";
    ++this.#generation;
    try {
      await this.#scope?.close(force);
      this.#scope = undefined;
      this.#error = undefined;
      this.#phase = "local";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async execute(
    tool: string,
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> {
    const scope = this.#scope;
    if (this.#phase !== "remote" || !scope || scope.isClosed) {
      throw this.#error ?? new Error("Remote workspace is unavailable; local fallback is blocked");
    }
    const generation = this.#generation;
    const result = await scope.execute(tool, toolCallId, args, signal, onUpdate);
    if (generation !== this.#generation) {
      throw new Error("Discarded a result from a previous workspace binding");
    }
    return result;
  }

  async service(plugin: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const scope = this.#scope;
    if (this.#phase !== "remote" || !scope || scope.isClosed) {
      throw this.#error ?? new Error("Remote workspace service is unavailable; local fallback is blocked");
    }
    const generation = this.#generation;
    const result = await scope.service(plugin, name, args, signal);
    if (generation !== this.#generation) {
      throw new Error("Discarded a service result from a previous workspace binding");
    }
    return result;
  }
}

const KEY = Symbol.for("pi-ssh-remote/workspace-bindings");
const globalRegistry = globalThis as typeof globalThis & {
  [KEY]?: WeakMap<object, PiWorkspaceBinding>;
};
const bindings = globalRegistry[KEY] ??= new WeakMap<object, PiWorkspaceBinding>();

export function workspaceBinding(session: object): PiWorkspaceBinding {
  let binding = bindings.get(session);
  if (!binding) {
    binding = new PiWorkspaceBinding();
    bindings.set(session, binding);
  }
  return binding;
}
