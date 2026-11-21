import { test, expect } from 'bun:test';
import { AsyncJobManager } from '@oh-my-pi/pi-coding-agent/async/job-manager';
import { RemoteRuntimeClient } from '../src/client.ts';
import { completeService, completeProcReceipt, startRemoteService } from '../src/omp/service-jobs.ts';
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core';
const ok = { content: [{ type: 'text' as const, text: 'ready' }], details: { service: { ownership: 'owned', id: 'fixture-instance' } } };
/** A daemon completion event for one generation; `unit.generation` identifies the instance. */
const exit = (key: string, generation = 'fixture-instance', exitCode = 0) => ({ unit: { key, generation, exitCode } });
const routed = () => { const calls: unknown[] = []; return { calls, to: () => calls.push(1) }; };

test('service reserves capacity before launch, retains early completion, and fails on disconnect', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    await startRemoteService(client, 'fast', 'Main', manager, async () => {
      completeService(client, 'fast', exit('fast', 'fixture-instance', 7), () => { throw new Error('unmatched'); }); return ok;
    });
    const first = manager.getAllJobs()[0]!;
    await first.promise;
    expect(first.resultText).toContain('"exitCode":7');
    await startRemoteService(client, 'live', 'Main', manager, async () => ok);
    let launched = false;
    await expect(startRemoteService(client, 'excess', 'Main', manager, async () => { launched = true; return ok; })).rejects.toThrow('limit');
    expect(launched).toBe(false);
    const excess = routed(); completeService(client, 'excess', exit('excess'), excess.to);
    expect(excess.calls).toHaveLength(1);
    const second = manager.getAllJobs().find(job => job.id !== first.id)!;
    client.kill(); await second.promise;
    expect(second.status).toBe('failed');
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('failed launch releases its name and capacity for a later attempt', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    await expect(startRemoteService(client, 'retry', 'Main', manager, async () => { throw Error('launch failed'); })).rejects.toThrow('launch failed');
    await manager.getAllJobs()[0]!.promise;
    await startRemoteService(client, 'retry', 'Main', manager, async () => { completeService(client, 'retry', exit('retry'), () => { throw new Error('unmatched'); }); return ok; });
    await Promise.all(manager.getAllJobs().map(j => j.promise));
    expect(manager.getAllJobs().map(j => j.status)).toEqual(['failed', 'completed']);
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('a retried name never settles on the earlier instance exit', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    // The first launch failed after the daemon acknowledged it (e.g. re-exec during readiness).
    await expect(startRemoteService(client, 'svc', 'Main', manager, async () => { throw Error('Daemon connection closed'); })).rejects.toThrow('closed');
    await manager.getAllJobs()[0]!.promise;
    const stale = routed();
    const retryLaunch = Promise.withResolvers<typeof ok>();
    const retry = startRemoteService(client, 'svc', 'Main', manager, () => retryLaunch.promise);
    // The orphaned first instance exits while the retry is still in flight.
    completeService(client, 'svc', exit('svc', 'first-instance', 9), stale.to);
    expect(stale.calls).toHaveLength(0);
    retryLaunch.resolve({ ...ok, details: { service: { ownership: 'owned', id: 'retry-instance' } } });
    await retry;
    expect(stale.calls).toHaveLength(1);
    const job = manager.getAllJobs().at(-1)!;
    expect(job.status).toBe('running');
    completeService(client, 'svc', exit('svc', 'retry-instance', 0), () => { throw new Error('unmatched'); });
    await job.promise;
    expect(job.resultText).toContain('retry-instance');
    expect(job.resultText).not.toContain('first-instance');
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('launch signal expires without stopping service; job cancellation owns its lifetime', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  const launch = new AbortController();
  try {
    await startRemoteService(client, 'running', 'Main', manager, async () => ok, launch.signal);
    launch.abort();
    completeService(client, 'running', exit('running'), () => { throw new Error('unmatched'); });
    const job = manager.getAllJobs()[0]!;
    await job.promise;
    expect(job.status).toBe('completed');
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('successful explicit stop releases coordination without a completion event', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    await startRemoteService(client, 'manual', 'Main', manager, async () => ok);
    const job = manager.getAllJobs()[0]!;
    const receipt = { content: [{ type: 'text' as const, text: 'manual stopped' }], details: { proc: { action: 'stop', daemon: { key: 'manual', state: 'exited', generation: 'fixture-instance' } } } };
    expect(completeProcReceipt(client, { ...receipt, isError: true })).toBe(false);
    expect(completeProcReceipt(client, ok)).toBe(false);
    expect(completeProcReceipt(client, { ...receipt, details: { proc: { action: 'mode', daemon: { key: 'manual' } } } })).toBe(false);
    expect(completeProcReceipt(client, { ...receipt, details: { proc: { action: 'stop', daemon: { key: 'other', generation: 'fixture-instance' } } } })).toBe(false);
    // Stopping another generation under the same name never settles this job.
    expect(completeProcReceipt(client, { ...receipt, details: { proc: { action: 'stop', daemon: { key: 'manual', generation: 'older' } } } })).toBe(false);
    expect(job.status).toBe('running');
    expect(completeProcReceipt(client, receipt)).toBe(true);
    await job.promise;
    expect(job.status).toBe('completed');
    expect(job.resultText).toContain('"operation":"stop"');
    expect(job.resultText).not.toContain('exitCode');
    const late = routed(); completeService(client, 'manual', exit('manual'), late.to);
    expect(late.calls).toHaveLength(1);
    await startRemoteService(client, 'manual', 'Main', manager, async () => {
      completeService(client, 'manual', exit('manual'), () => { throw new Error('unmatched'); }); return ok;
    });
    await Promise.all(manager.getAllJobs().map(j => j.promise));
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('a mode change that relaunches the service settles the tracked job and frees the name', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    await startRemoteService(client, 'svc', 'Main', manager, async () => ok);
    const job = manager.getAllJobs()[0]!;
    const mode = (generation: string) => ({ content: [{ type: 'text' as const, text: 'mode' }], details: { proc: { action: 'mode', mode: 'detached', daemon: { key: 'svc', generation } } } });
    // Same generation: the hold changed in place; the tracked instance still runs.
    expect(completeProcReceipt(client, mode('fixture-instance'))).toBe(false);
    expect(job.status).toBe('running');
    // Relaunched under a new generation: the tracked instance is gone without a completion event.
    expect(completeProcReceipt(client, mode('detached-instance'))).toBe(true);
    await job.promise;
    expect(job.resultText).toContain('"operation":"mode"');
    await startRemoteService(client, 'svc', 'Main', manager, async () => ok);
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('a terminal retry forwards an earlier instance exit instead of dropping it', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    const stale = routed();
    const terminal = { ...ok, details: { service: { name: 'svc', state: 'exited', ownership: 'terminal' } } };
    await startRemoteService(client, 'svc', 'Main', manager, async () => {
      completeService(client, 'svc', exit('svc', 'first-instance', 9), stale.to);
      return terminal;
    });
    expect(stale.calls).toHaveLength(1);
    await manager.getAllJobs()[0]!.promise;
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('cancellation waits for scoped cleanup and preserves cleanup failure', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  const executing = Promise.withResolvers<void>();
  const launchResult = Promise.withResolvers<typeof ok & { details: { service: { id: string; ownership: string } } }>();
  const cleaning = Promise.withResolvers<void>();
  const cleanupResult = Promise.withResolvers<void>();
  const stops: unknown[] = [];
  client.stopService = async (name, id) => {
    stops.push({ name, id }); cleaning.resolve(); await cleanupResult.promise;
    throw new Error('broker stop failed');
  };
  try {
    const started = startRemoteService(client, 'cancelled', 'Main', manager, async () => {
      executing.resolve(); return await launchResult.promise;
    });
    void started.catch(() => {});
    await executing.promise;
    const job = manager.getAllJobs()[0]!;
    job.abortController.abort(new Error('cancel during launch'));
    launchResult.resolve({ ...ok, details: { service: { id: 'instance-1', ownership: 'owned' } } });
    await cleaning.promise;
    let settled = false;
    void started.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanupResult.resolve();
    await expect(started).rejects.toThrow('cancel during launch; remote service cancelled cleanup failed: broker stop failed');
    await job.promise;
    expect(stops).toEqual([{ name: 'cancelled', id: 'instance-1' }]);
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('missing ownership and invalid owned IDs fail promptly without name-only cleanup', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  let stops = 0;
  client.stopService = async () => { stops++; throw new Error('unexpected cleanup'); };
  const invalid = [
    { content: [] },
    { content: [], details: { service: { ownership: 'unknown', id: 'instance' } } },
    { content: [], details: { service: { ownership: 'owned' } } },
    { content: [], details: { service: { ownership: 'owned', id: '' } } },
    { content: [], details: { service: { ownership: 'owned', id: ' ' } } },
    { content: [], details: { service: { ownership: 'owned', id: 7 } } },
  ] satisfies AgentToolResult[];
  try {
    for (const [index, receipt] of invalid.entries()) {
      const name = `invalid-${index}`;
      await expect(startRemoteService(client, name, 'Main', manager, async () => receipt)).rejects.toThrow('receipt');
      const job = manager.getAllJobs().at(-1)!;
      await job.promise;
      expect(job.status).toBe('failed');
      const stray = routed(); completeService(client, name, exit(name), stray.to);
      expect(stray.calls).toHaveLength(1);
    }
    const rejected = { content: [{ type: 'text' as const, text: 'native business rejection' }], isError: true };
    expect(await startRemoteService(client, 'rejected', 'Main', manager, async () => rejected)).toBe(rejected);
    await manager.getAllJobs().at(-1)!.promise;
    expect(stops).toBe(0);
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});
