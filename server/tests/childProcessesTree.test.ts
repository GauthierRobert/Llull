import { spawn } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { killAllChildren, trackChild } from '../src/childProcesses';
import { alive } from './processTestSupport';

async function until(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe.skipIf(process.platform === 'win32')('killAllChildren', () => {
  it('kills the grandchildren of a detached child, not only the leader', async () => {
    const child = trackChild(spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    const leader = child.pid ?? -1;
    expect([alive(leader), alive(grandchild)]).toEqual([true, true]);

    expect(killAllChildren()).toBe(1);
    expect(await until(() => !alive(leader) && !alive(grandchild))).toBe(true);
  });
});
