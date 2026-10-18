import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { validateAnimationValue } from '@core/commands/persistence/collections';
import {
  composeAnimatedPoseInto,
  createLoopScratch,
  createPoseScratch,
  measureLoop,
  nearestLoopDistance,
  writeFollowPathContributions,
  writeLoopFrame,
  type AnimationContribution,
} from '../../src/ui/viewport/3d/animationMath';
import { expectPure } from '../helpers/expectNoOp';

/** A 100 x 50 rectangle loop (closed polyline in the XY plane) and one box sitting on its first corner. */
function chainDoc(): { doc: CadDocument; loopId: string; linkId: string; openId: string } {
  const loop = execute(createEmptyDocument(), 'draw_polyline', {
    points: [
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ],
    closed: true,
  });
  const open = execute(loop.document, 'draw_polyline', {
    points: [
      [0, 0],
      [10, 0],
    ],
  });
  const link = execute(open.document, 'add_box', { size: [4, 2, 2] });
  return { doc: link.document, loopId: loop.affected[0] ?? '', openId: open.affected[0] ?? '', linkId: link.affected[0] ?? '' };
}

describe('animate follow_path', () => {
  it('stores the closed loop as world points with speed along the loop, purely', () => {
    const { doc, loopId, linkId } = chainDoc();
    const r = execute(doc, 'animate', { targetId: linkId, mode: 'follow_path', pathId: loopId, speed: 25 });
    const [anim] = Object.values(r.document.animations);
    expect(anim).toMatchObject({ mode: 'follow_path', speed: 25, channel: 'position', targetId: linkId });
    expect(anim?.path?.length).toBeGreaterThanOrEqual(4);
    expect(anim?.path).toContainEqual([100, 50, 0]);
    expect(r.summary).toContain('travels round');
    expectPure(doc, () => execute(doc, 'animate', { targetId: linkId, mode: 'follow_path', pathId: loopId, speed: 25 }));
  });

  it.each<[Record<string, unknown>, string]>([
    [{ speed: 5 }, 'pathId'],
    [{ pathId: 'LOOP' }, 'speed'],
    [{ pathId: 'nowhere', speed: 5 }, 'nowhere'],
    [{ pathId: 'OPEN', speed: 5 }, 'not a closed loop'],
    [{ pathId: 'LINK', speed: 5 }, 'not a 2D curve'],
  ])('rejects %j', (params, message) => {
    const { doc, loopId, linkId, openId } = chainDoc();
    const ids: Record<string, string> = { LOOP: loopId, OPEN: openId, LINK: linkId };
    const pathId = typeof params['pathId'] === 'string' ? (ids[params['pathId']] ?? params['pathId']) : undefined;
    const r = execute(doc, 'animate', { ...params, ...(pathId === undefined ? {} : { pathId }), targetId: linkId, mode: 'follow_path' });
    expect(r.document).toBe(doc);
    expect(r.summary).toContain(message);
  });

  it('round-trips through save / load and the validator rejects a follow_path without a path', () => {
    const { doc, loopId, linkId } = chainDoc();
    const animated = execute(doc, 'animate', { targetId: linkId, mode: 'follow_path', pathId: loopId, speed: 3 }).document;
    const loaded = deserializeDocument(serializeDocument(animated));
    expect(Object.values(loaded.animations)[0]?.path).toEqual(Object.values(animated.animations)[0]?.path);
    const base = {
      id: 'a',
      targetId: 'e',
      targetKind: 'entity',
      channel: 'position',
      axis: [0, 1, 0],
      speed: 1,
      amplitude: 0,
      frequency: 0,
    };
    expect(validateAnimationValue('a', { ...base, mode: 'follow_path', trigger: 'auto' })).toContain('needs a path');
    expect(validateAnimationValue('a', { ...base, mode: 'follow_path', trigger: 'auto', path: [[0, 0, 0]] })).toContain('path must');
    expect(validateAnimationValue('a', { ...base, mode: 'glide', trigger: 'auto' })).toContain('follow_path');
  });
});

describe('follow_path math', () => {
  const square = measureLoop([
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ]);

  it('measures the loop and finds the nearest arc length', () => {
    expect(square.lengths).toEqual([0, 10, 20, 30, 40]);
    expect(square.normal).toEqual([0, 0, 1]);
    expect(nearestLoopDistance(square, [10.5, 4, 0])).toBeCloseTo(14);
    expect(nearestLoopDistance(square, [-1, 5, 0])).toBeCloseTo(35);
    expect(
      measureLoop([
        [0, 0, 0],
        [1, 0, 0],
      ]).normal,
    ).toEqual([0, 0, 1]);
  });

  it('wraps the frame round the loop in both directions', () => {
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    writeLoopFrame(square, 45, point, tangent);
    expect(point.toArray()).toEqual([5, 0, 0]);
    expect(tangent.toArray()).toEqual([1, 0, 0]);
    writeLoopFrame(square, -5, point, tangent);
    expect(point.toArray()).toEqual([0, 5, 0]);
    expect(tangent.toArray()).toEqual([0, -1, 0]);
  });

  /** Pose of a member at `base` (link along +X) after `travel` round the square. */
  function carried(base: [number, number, number], travel: number): { position: number[]; heading: number[] } {
    const fresh = (): AnimationContribution => ({ channel: 'rotation', axis: new THREE.Vector3(), scalar: 0, pivot: new THREE.Vector3() });
    const turn = fresh();
    const shift = fresh();
    writeFollowPathContributions(square, base, travel, turn, shift, createLoopScratch());
    const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    composeAnimatedPoseInto(pose, base, [0, 0, 0], [turn, shift], createPoseScratch());
    const heading = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
    return {
      position: pose.position.toArray().map((v) => Math.round(v * 1e6) / 1e6),
      heading: heading.toArray().map((v) => Math.round(v)),
    };
  }

  it('carries a member along the loop and turns it with the tangent', () => {
    expect(carried([2, 0, 0], 3)).toEqual({ position: [5, 0, 0], heading: [1, 0, 0] });
    expect(carried([2, 0, 0], 13)).toEqual({ position: [10, 5, 0], heading: [0, 1, 0] });
    expect(carried([2, 0, 0], 23)).toEqual({ position: [5, 10, 0], heading: [-1, 0, 0] });
    expect(carried([2, 0, 0], 0)).toEqual({ position: [2, 0, 0], heading: [1, 0, 0] });
  });
});
