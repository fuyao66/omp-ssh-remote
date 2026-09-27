import { test, expect } from 'bun:test';
import { AsyncJobManager } from '@oh-my-pi/pi-coding-agent/async/job-manager';
import { RemoteRuntimeClient } from '../src/client.ts';
import { prepareService, completeService, trackService } from '../src/omp/service-jobs.ts';

test('service completion before registration is retained and transport loss fails wait jobs', async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 4 });
  const previous = AsyncJobManager.instance();
  AsyncJobManager.setInstance(manager);
  const client = new RemoteRuntimeClient({ command: ['bun', '-e', 'setInterval(()=>{},1000)'] });
  try {
    prepareService(client, 'fast');
    completeService(client, 'fast', { exitCode: 7 });
    trackService(client, 'fast', 'Main');
    const first = manager.getAllJobs()[0]!;
    await first.promise;
    expect(first.resultText).toContain('"exitCode":7');
    prepareService(client, 'live');
    trackService(client, 'live', 'Main');
    const second = manager.getAllJobs().find(job => job.id !== first.id)!;
    client.kill();
    await second.promise;
    expect(second.status).toBe('failed');
  } finally {
    client.kill();
    await manager.dispose({ timeoutMs: 1000 });
    AsyncJobManager.setInstance(previous);
  }
});
