import { describe, expect, test } from "bun:test";
import { withReadinessSteering, type ReadinessSession } from "../src/omp/readiness-steering.ts";

function fixture() {
  const listeners = new Set<(event: { type: string }) => void>();
  const state = { steering: false, irc: false };
  const session: ReadinessSession = {
    interruptMode: "immediate",
    agent: { peekSteeringQueue: () => state.steering ? ["message"] : [], hasIrcInterrupts: () => state.irc },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { session, state, listeners, emit(type: string) { for (const fn of listeners) fn({ type }); } };
}

describe("remote readiness steering", () => {
  test("a message already queued interrupts readiness", async () => {
    const f = fixture(); f.state.steering = true;
    await withReadinessSteering(f.session, async (signal) => { expect(signal?.aborted).toBe(true); });
    expect(f.listeners.size).toBe(0);
  });

  test("new steering interrupts but follow-ups and relay-only IRC do not", async () => {
    const f = fixture();
    const result = await withReadinessSteering(f.session, async (signal) => {
      f.emit("queue_update"); // Follow-up only: no entry in steering queue.
      f.emit("irc_message"); // Relay observation: no interrupt queued.
      await new Promise<void>(resolve => queueMicrotask(resolve));
      expect(signal?.aborted).toBe(false);
      const interrupted = new Promise<string>(resolve => signal!.addEventListener("abort", () => resolve("service still running"), { once: true }));
      f.state.steering = true; f.emit("queue_update");
      return interrupted;
    });
    expect(result).toBe("service still running");
    expect(f.listeners.size).toBe(0);
  });

  test("IRC is inspected after its event enqueues the interrupt", async () => {
    const f = fixture();
    await withReadinessSteering(f.session, async (signal) => {
      const interrupted = new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      f.emit("irc_message");
      f.state.irc = true;
      await interrupted;
      expect(signal?.aborted).toBe(true);
    });
  });

  test("wait mode and absent sessions do not invent steering", async () => {
    const f = fixture(); f.session = { ...f.session, interruptMode: "wait" }; f.state.steering = true;
    for (const session of [undefined, f.session]) {
      await withReadinessSteering(session, async signal => { expect(signal).toBeUndefined(); });
    }
    expect(f.listeners.size).toBe(0);
  });

  test("failed calls remove observers and scheduled checks cannot affect later calls", async () => {
    const f = fixture(); let oldSignal: AbortSignal | undefined;
    await expect(withReadinessSteering(f.session, async signal => {
      oldSignal = signal; f.emit("irc_message"); throw new Error("transport lost");
    })).rejects.toThrow("transport lost");
    f.state.irc = true;
    f.emit("irc_message");
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(f.listeners.size).toBe(0);
    expect(oldSignal?.aborted).toBe(false);
  });
});
