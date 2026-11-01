/** Cooperative cancellation must not publish completion while native mutation work is still running. */
export async function awaitMutationSettled<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const result = await work();
  signal?.throwIfAborted();
  return result;
}
