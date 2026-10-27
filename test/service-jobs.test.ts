import { test, expect } from 'bun:test';
import { AsyncJobManager } from '@oh-my-pi/pi-coding-agent/async/job-manager';
import { RemoteRuntimeClient } from '../src/client.ts';
import { completeService, completeStoppedService, startRemoteService } from '../src/omp/service-jobs.ts';
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core';
const ok = { content: [{ type: 'text' as const, text: 'ready' }], details: { service: { ownership: 'owned', id: 'fixture-instance' } } };

test('service reserves capacity before launch, retains early completion, and fails on disconnect', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    await startRemoteService(client, 'fast', 'Main', manager, async () => {
      completeService(client, 'fast', { exitCode: 7 }); return ok;
    });
    const first = manager.getAllJobs()[0]!;
    await first.promise;
    expect(first.resultText).toContain('"exitCode":7');
    await startRemoteService(client, 'live', 'Main', manager, async () => ok);
    let launched = false;
    await expect(startRemoteService(client, 'excess', 'Main', manager, async () => { launched = true; return ok; })).rejects.toThrow('limit');
    expect(launched).toBe(false);
    expect(completeService(client, 'excess', {})).toBe(false);
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
    await startRemoteService(client, 'retry', 'Main', manager, async () => { completeService(client, 'retry', { exitCode: 0 }); return ok; });
    await Promise.all(manager.getAllJobs().map(j => j.promise));
    expect(manager.getAllJobs().map(j => j.status)).toEqual(['failed', 'completed']);
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});

test('launch signal expires without stopping service; job cancellation owns its lifetime', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 1 });
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  const launch = new AbortController();
  try {
    await startRemoteService(client, 'running', 'Main', manager, async () => ok, launch.signal);
    launch.abort();
    completeService(client, 'running', { exitCode: 0 });
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
    const receipt = { content: [{ type: 'text' as const, text: 'manual stopped' }], details: { proc: { action: 'stop', daemon: { name: 'manual', state: 'exited' } } } };
    expect(completeStoppedService(client, { ...receipt, isError: true })).toBe(false);
    expect(completeStoppedService(client, ok)).toBe(false);
    expect(completeStoppedService(client, { ...receipt, details: { proc: { action: 'mode', daemon: { name: 'manual' } } } })).toBe(false);
    expect(completeStoppedService(client, { ...receipt, details: { proc: { action: 'stop', daemon: { name: 'other' } } } })).toBe(false);
    expect(job.status).toBe('running');
    expect(completeStoppedService(client, receipt)).toBe(true);
    await job.promise;
    expect(job.status).toBe('completed');
    expect(job.resultText).toContain('"operation":"stop"');
    expect(job.resultText).not.toContain('exitCode');
    expect(completeService(client, 'manual', {})).toBe(false);
    await startRemoteService(client, 'manual', 'Main', manager, async () => {
      completeService(client, 'manual', { exitCode: 0 }); return ok;
    });
    await Promise.all(manager.getAllJobs().map(j => j.promise));
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
      expect(completeService(client, name, {})).toBe(false);
    }
    const rejected = { content: [{ type: 'text' as const, text: 'native business rejection' }], isError: true };
    expect(await startRemoteService(client, 'rejected', 'Main', manager, async () => rejected)).toBe(rejected);
    await manager.getAllJobs().at(-1)!.promise;
    expect(stops).toBe(0);
  } finally { client.kill(); await manager.dispose({ timeoutMs: 1000 }); }
});
