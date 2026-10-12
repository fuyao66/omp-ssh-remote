import { test, expect } from 'bun:test';
import { AsyncJobManager } from '@oh-my-pi/pi-coding-agent/async/job-manager';
import { RemoteRuntimeClient } from '../src/client.ts';
import { completeService, startRemoteService } from '../src/omp/service-jobs.ts';
const ok = { content: [{ type: 'text' as const, text: 'ready' }] };

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
