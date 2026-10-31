/** A mesh engine that is not ready yet (the native job still runs, TECHNICAL_SPEC 13.8): the refusal it answers, and replay never keeping a step that saw it. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createReplayCache } from '@core/commands/history/replayCache';
import { composeMeshEngines, deferMeshOp, deferralCount, MESH_ENGINE_PENDING } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import type { SubdivisionEntity } from '@core/model/types';
import { cuboid, docWithMeshes } from '../../helpers/meshFixtures';
import { contextWith, quadBox, stubQuadEngine } from '../../helpers/quadFixtures';

/** The stub quad engine, answering `deferMeshOp` while `ready.now` is false (the host would be awaiting the job). */
function lateEngine(ready: { now: boolean }, half = 5): MeshProcessingEngine {
  const stub = stubQuadEngine(() => quadBox(half, 1));
  return { ...stub, run: (input, op) => (ready.now ? stub.run(input, op) : deferMeshOp('quad_remesh')) };
}

const { doc: boxDoc, ids } = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
const boxId = ids[0] as string;
const cages = (doc: typeof boxDoc): SubdivisionEntity[] =>
  Object.values(doc.entities).filter((e): e is SubdivisionEntity => e.kind === 'subdivision');

describe('a deferred engine answer', () => {
  it('is the named refusal MESH_ENGINE_PENDING, counted, and the composite hands it back instead of asking the next engine', () => {
    const before = deferralCount();
    const refusal = deferMeshOp('quad_remesh') as MeshEngineFailure;
    expect(refusal.code).toBe(MESH_ENGINE_PENDING);
    expect(refusal.message).toContain('quad_remesh');
    expect(deferralCount()).toBe(before + 1);
    const never = stubQuadEngine(() => quadBox(5, 1));
    const composite = composeMeshEngines([lateEngine({ now: false }), { ...never, name: 'second' }]);
    expect(composite.run({ mesh: { positions: [], indices: [] } }, { op: 'quad_remesh', targetQuads: 6, adaptive: false })).toMatchObject({
      code: MESH_ENGINE_PENDING,
    });
  });

  it('makes quad_remesh a rejection that leaves the document, with the code the host discards', () => {
    const result = execute(boxDoc, 'quad_remesh', { id: boxId, targetQuadCount: 6 }, contextWith(lateEngine({ now: false })));
    expect(result.document).toBe(boxDoc);
    expect(result.error?.code).toBe(MESH_ENGINE_PENDING);
  });
});

describe('replay_history around a deferred step', () => {
  it('does not memoize the step or the ones after it: once the engine is ready the replay rebuilds all of them', () => {
    const ready = { now: true };
    const context = contextWith(lateEngine(ready));
    const remeshed = execute(boxDoc, 'quad_remesh', { id: boxId, targetQuadCount: 6 }, context);
    const withBox = execute(remeshed.document, 'add_box', { size: [3, 3, 3] }, context);
    expect(cages(withBox.document)).toHaveLength(1);
    ready.now = false;
    const pending = execute(withBox.document, 'replay_history', {}, context);
    expect(cages(pending.document)).toHaveLength(0);
    ready.now = true;
    const replayed = execute(withBox.document, 'replay_history', {}, context);
    expect(cages(replayed.document)).toHaveLength(1);
    expect(replayed.document.order).toEqual(withBox.document.order);
  });

  it('memoizes the steps before the first deferral and none after it, not even the ones that did not defer themselves', () => {
    const ready = { now: true };
    // its own replay cache: defaultContext() shares one per kernel across the worker, so other suites would move the counts
    const cache = createReplayCache();
    const context = { ...contextWith(lateEngine(ready, 4)), replayCache: cache };
    const fresh = docWithMeshes(cuboid([-4, -4, -4], [4, 4, 4]));
    const withBox = execute(
      execute(fresh.doc, 'quad_remesh', { id: fresh.ids[0] as string, targetQuadCount: 6 }, context).document,
      'add_box',
      { size: [3, 3, 3] },
      context,
    );
    // what replaying the import step alone adds to the cache: the only step before the first deferral
    const importOnly = docWithMeshes(cuboid([-3, -3, -3], [3, 3, 3])).doc;
    const start = cache.size;
    execute(importOnly, 'replay_history', {}, context);
    const importEntries = cache.size - start;
    expect(importEntries).toBeGreaterThan(0);
    ready.now = false;
    const before = cache.size;
    execute(withBox.document, 'replay_history', {}, context);
    expect(cache.size - before).toBe(importEntries);
    ready.now = true;
    execute(withBox.document, 'replay_history', {}, context);
    expect(cache.size - before).toBeGreaterThan(importEntries);
  });
});
