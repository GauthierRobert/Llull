import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { answerPhysicsJob, type PhysicsJobRequest, type PhysicsWorkerLike } from '@app/physicsJob';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createEmptyDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { runPhysicsQuery, setPhysicsWorkerFactory, warmPhysicsEngine } from '@ui/services/physicsRun';
import { useStore } from '@ui/store';
import { inProcessPhysicsWorker } from '../helpers/inProcessPhysicsWorker';

/** A box 5 units up with a rigid body: it falls freely. */
function fallingBox(): void {
  const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 5] });
  useStore.getState().setDocument(execute(box.document, 'add_rigid_body', { entityIds: [box.affected[0]] }).document);
}

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));
afterEach(() => setPhysicsWorkerFactory(null));

describe('runPhysicsQuery (in-page physics worker)', () => {
  it('runs the command in the worker on the document as it is when asked, and reports the engine load once', async () => {
    fallingBox();
    const seen: PhysicsJobRequest[] = [];
    setPhysicsWorkerFactory(() => inProcessPhysicsWorker(seen));
    const status: string[] = [];
    const first = await runPhysicsQuery('simulate_motion', { duration: 0.5 }, (line) => status.push(line));
    const second = await runPhysicsQuery('simulate_motion', { duration: 0.25 }, (line) => status.push(line));
    expect(first.summary).toMatch(/simulate_motion: 0\.5 s with MuJoCo .* velocity \[0, 0, -4\.905\] m\/s/);
    expect((first.data as { duration: number }).duration).toBe(0.5);
    expect(second.summary).toMatch(/simulate_motion: 0\.25 s/);
    expect(status).toEqual(['Loading the MuJoCo physics engine…']);
    expect(seen.map((request) => request.document)).toEqual([useStore.getState().document, useStore.getState().document]);
  });

  it('answers each job with its own result when they overlap', async () => {
    fallingBox();
    setPhysicsWorkerFactory(() => inProcessPhysicsWorker());
    const [long, short] = await Promise.all([
      runPhysicsQuery('simulate_motion', { duration: 0.5 }),
      runPhysicsQuery('simulate_motion', { duration: 0.1 }),
    ]);
    expect([(long.data as { duration: number }).duration, (short.data as { duration: number }).duration]).toEqual([0.5, 0.1]);
  });

  it('a worker that dies answers the pending jobs with the reason, and the next job starts a fresh worker', async () => {
    fallingBox();
    const made: PhysicsWorkerLike[] = [];
    setPhysicsWorkerFactory(() => {
      const worker: PhysicsWorkerLike =
        made.length === 0
          ? { onmessage: null, onerror: null, terminate: () => undefined, postMessage: () => undefined }
          : inProcessPhysicsWorker();
      made.push(worker);
      return worker;
    });
    const stuck = runPhysicsQuery('simulate_motion', { duration: 0.5 });
    made[0]?.onerror?.({ message: 'out of memory' });
    expect((await stuck).summary).toBe('The physics worker stopped: out of memory');
    expect((await stuck).data).toBeUndefined();
    const retried = await runPhysicsQuery('simulate_motion', { duration: 0.5 });
    expect(retried.summary).toMatch(/simulate_motion: 0\.5 s/);
    expect(made).toHaveLength(2);
  });

  it('warming up starts the worker and loads the engine once, and the first job after it no longer announces a load', async () => {
    fallingBox();
    const warmUps = { count: 0 };
    let made = 0;
    setPhysicsWorkerFactory(() => {
      made += 1;
      return inProcessPhysicsWorker([], warmUps);
    });
    warmPhysicsEngine();
    warmPhysicsEngine();
    expect([made, warmUps.count]).toEqual([1, 1]);
    const status: string[] = [];
    const run = await runPhysicsQuery('simulate_motion', { duration: 0.2 }, (line) => status.push(line));
    expect(run.summary).toMatch(/simulate_motion: 0\.2 s/);
    expect([made, warmUps.count, status]).toEqual([1, 1, []]);
  });

  it('warming up without workers is a no-op', () => {
    expect(() => warmPhysicsEngine()).not.toThrow();
  });

  it('without workers (this jsdom has none) it says so instead of hanging', async () => {
    const run = await runPhysicsQuery('simulate_motion', { duration: 0.5 });
    expect(run.summary).toBe(
      'simulate_motion needs the llull backend (it is not connected) and the in-page physics engine is not available here.',
    );
    expect(run.data).toBeUndefined();
  });
});

describe('answerPhysicsJob', () => {
  it('runs a read-only command and returns its summary and data', () => {
    fallingBox();
    const answer = answerPhysicsJob({
      id: 7,
      document: useStore.getState().document,
      command: 'simulate_motion',
      params: { duration: 0.2 },
    });
    expect(answer.id).toBe(7);
    expect(answer.summary).toMatch(/simulate_motion: 0\.2 s/);
    expect(answer.data).toBeDefined();
  });

  it('refuses a command that would change the document: the worker only answers queries', () => {
    const answer = answerPhysicsJob({ id: 1, document: createEmptyDocument(), command: 'add_box', params: { size: [1, 1, 1] } });
    expect(answer.summary).toBe('add_box is not a read-only command: the physics worker only answers queries.');
    expect(answer.data).toBeUndefined();
  });

  it('refuses an unknown command the same way', () => {
    expect(answerPhysicsJob({ id: 2, document: createEmptyDocument(), command: 'no_such_command', params: {} }).data).toBeUndefined();
  });
});
