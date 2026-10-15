/** The public session surface needed to observe, never consume, pending work. */
export interface ReadinessSession {
  readonly interruptMode: "immediate" | "wait";
  readonly agent: {
    peekSteeringQueue(): readonly unknown[];
    hasIrcInterrupts?: () => boolean | Promise<boolean>;
  };
  subscribe(listener: (event: { type: string }) => void): () => void;
}

/**
 * Registered tools do not receive native toolCall.steeringSignal. Observe the
 * owning session only during readiness. Follow-ups are not steering; IRC events
 * are emitted before enqueue, so inspect the actual queues on a microtask.
 */
export async function withReadinessSteering<T>(
  session: ReadinessSession | undefined,
  execute: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!session || session.interruptMode === "wait") return execute();
  const controller = new AbortController();
  let disposed = false;
  const check = async () => {
    if (disposed || controller.signal.aborted) return;
    const pending = session.agent.peekSteeringQueue().length > 0 || await session.agent.hasIrcInterrupts?.();
    if (!disposed && pending) controller.abort(new Error("Host message queued"));
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "queue_update" && event.type !== "irc_message") return;
    queueMicrotask(() => { void check().catch((error) => { if (!disposed) controller.abort(error); }); });
  });
  try {
    await check();
    return await execute(controller.signal);
  } finally {
    disposed = true;
    unsubscribe();
  }
}
