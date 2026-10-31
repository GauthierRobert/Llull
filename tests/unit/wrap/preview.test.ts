/**
 * 03 WRP previews (spec §14.17): preview_emboss_on_face and preview_add_knurl answer what the two commands would do, with the same parameters and the same refusals, and change nothing. On the fake exact
 * kernel (a cylinder R 20 with the closed-form chart): footprint polylines lie on the cylinder, the distortion is the chart's, the knurl lines are the teeth that close round the face.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { Vec3 } from '@core/model/types';
import { expectPure } from '../../helpers/expectNoOp';
import { cylinder, emptyDoc, FACE, make, rectangleOn, sphere, useFakeKernel } from './support';

const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const radial = (point: Vec3): number => Math.hypot(point[0], point[1]);

describe('preview_emboss_on_face', () => {
  useFakeKernel();

  const scene = (): { doc: ReturnType<typeof emptyDoc>; solid: string; params: Record<string, unknown> } => {
    const base = cylinder();
    const rect = rectangleOn(base.doc, 30, 10);
    return {
      doc: rect.doc,
      solid: base.id,
      params: { id: base.id, face: FACE, profileIds: [rect.id], mode: 'emboss', depth: 1, placement: { method: 'develop' } },
    };
  };

  it('the footprint of a 30 x 10 rectangle on the cylinder R 20 is one closed loop on the face, with the closed-form volume of the relief and no stretch; nothing is changed', () => {
    const { doc, params } = scene();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'preview_emboss_on_face', params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(JSON.stringify(result.document)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const footprint = data(result)['footprint'] as Array<{ hole: boolean; points: Vec3[] }>;
    expect(footprint).toHaveLength(1);
    expect(footprint[0]?.hole).toBe(false);
    const points = footprint[0]?.points as Vec3[];
    // closed, on the cylinder, the extent of the rectangle: 30 along the circumference (1.5 rad), 10 along the axis
    expect(points[0]).toEqual(points[points.length - 1]);
    for (const point of points) expect(radial(point)).toBeCloseTo(20, 6);
    const zs = points.map((p) => p[2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(10, 6);
    const distortion = data(result)['distortion'] as { maxAbsLengthStrain: number; areaRatio: number };
    expect(distortion.maxAbsLengthStrain).toBeLessThan(1e-9);
    expect(distortion.areaRatio).toBeCloseTo(1, 9);
    expect(data(result)['expectedVolumeDelta'] as number).toBeCloseTo(307.5, 9);
    expect(data(result)).toMatchObject({ mode: 'emboss', depth: 1, method: 'develop', faceKind: 'cylinder', instances: 1 });
    expect(result.summary).toContain('nothing is changed');
    expectPure(doc, () => execute(doc, 'preview_emboss_on_face', params));
  });

  it('a profile with a hole gives the hole loop', () => {
    const base = cylinder();
    const outer = rectangleOn(base.doc, 30, 20);
    const hole = rectangleOn(outer.doc, 10, 5);
    const ring = execute(hole.doc, 'preview_emboss_on_face', {
      id: base.id,
      face: FACE,
      profileIds: [outer.id, hole.id],
      mode: 'deboss',
      depth: 1,
      placement: { method: 'develop' },
    });
    expect(ring.rejected, ring.summary).toBeUndefined();
    expect((data(ring)['footprint'] as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses with the code of emboss_on_face: a depth, an open profile, a wrong face; the same refusals, nothing changed', () => {
    const { doc, params } = scene();
    for (const bad of [{ depth: 0 }, { depth: -1 }, { profileIds: ['nope'] }, { id: 'missing' }]) {
      const real = execute(doc, 'emboss_on_face', { ...params, ...bad });
      const preview = execute(doc, 'preview_emboss_on_face', { ...params, ...bad });
      expect(preview.error?.code, JSON.stringify(bad)).toBe(real.error?.code);
      expect(preview.document).toBe(doc);
    }
    expect(execute(doc, 'preview_emboss_on_face', { ...params, depth: 0 }).affected).toEqual([]);
  });

  it('a deboss deeper than the material and a distortion over the limit are refused before the build, like the command; a chain is not drawn', () => {
    const { doc, params } = scene();
    const through = execute(doc, 'preview_emboss_on_face', { ...params, mode: 'deboss', depth: 100 });
    expect(through.error?.code).toBe('WRP_DEPTH_EXCEEDS_SOLID');
    const chained = execute(doc, 'preview_emboss_on_face', { ...params, chain: [{ faceNear: [0, 0, 20] }] });
    expect(chained.error?.code).toBe('WRP_PARAM_INVALID');
    expect(chained.summary).toContain('leave out chain');
    const ball = sphere();
    const disk = rectangleOn(ball.doc, 20, 20);
    const stretched = execute(disk.doc, 'preview_emboss_on_face', {
      id: ball.id,
      face: { faceNear: [25, 0, 0] },
      profileIds: [disk.id],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'geodesic' },
      maxLengthStrain: 1e-6,
    });
    expect(stretched.error?.code).toBe('WRP_DISTORTION_EXCEEDED');
  });
});

describe('preview_add_knurl', () => {
  useFakeKernel();
  const rod = (): { doc: ReturnType<typeof emptyDoc>; id: string } => {
    const made = make(emptyDoc(), 'add_cylinder', { radius: 10, height: 40 });
    return { doc: made.doc, id: made.id };
  };
  const face = { faceNear: [10, 0, 0] };

  it('a straight knurl is 63 axial lines on the cylinder R 10 over its 40 length, the teeth that close round it; nothing is changed', () => {
    const { doc, id } = rod();
    const result = execute(doc, 'preview_add_knurl', { id, face, pattern: 'straight', pitch: 1 });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.document).toBe(doc);
    const lines = data(result)['lines'] as Array<{ tooth: number; hand: string | null; points: Vec3[] }>;
    expect(lines).toHaveLength(63);
    expect(data(result)).toMatchObject({ teeth: 63, pitchAdjusted: true, diameter: 20, pattern: 'straight', thinned: false, length: 40 });
    expect(data(result)['pitch'] as number).toBeCloseTo(0.99733100114, 9);
    for (const line of lines) {
      expect(line.hand).toBeNull();
      expect(line.points).toHaveLength(2);
      for (const point of line.points) expect(radial(point)).toBeCloseTo(10, 9);
      expect(Math.abs((line.points[1] as Vec3)[2] - (line.points[0] as Vec3)[2])).toBeCloseTo(40, 9);
      expect(line.points[0]?.[0]).toBeCloseTo((line.points[1] as Vec3)[0], 9);
    }
    expectPure(doc, () => execute(doc, 'preview_add_knurl', { id, face, pattern: 'straight', pitch: 1 }));
  });

  it('a diagonal knurl is helices of the hand asked (default right, 30 degrees from the axis: the azimuth turns 40 tan 30 / 10 over the length), a diamond has both hands', () => {
    const { doc, id } = rod();
    const diagonal = execute(doc, 'preview_add_knurl', { id, face, pattern: 'diagonal', pitch: (Math.PI * 20) / 60, model: 'geometry' });
    expect(diagonal.rejected, diagonal.summary).toBeUndefined();
    const lines = data(diagonal)['lines'] as Array<{ hand: string; points: Vec3[] }>;
    expect(lines).toHaveLength(60);
    const first = lines[0]?.points as Vec3[];
    expect(first.length).toBeGreaterThan(10);
    const angle = (p: Vec3): number => Math.atan2(p[1], p[0]);
    const turn = ((angle(first[first.length - 1] as Vec3) - angle(first[0] as Vec3) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.abs(turn)).toBeCloseTo(((40 * Math.tan(Math.PI / 6)) / 10) % (2 * Math.PI), 6);
    const left = execute(doc, 'preview_add_knurl', {
      id,
      face,
      pattern: 'diagonal',
      pitch: (Math.PI * 20) / 60,
      model: 'geometry',
      hand: 'left',
    });
    const leftFirst = (data(left)['lines'] as Array<{ points: Vec3[] }>)[0]?.points as Vec3[];
    const leftTurn =
      ((angle(leftFirst[leftFirst.length - 1] as Vec3) - angle(leftFirst[0] as Vec3) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.sign(leftTurn)).toBe(-Math.sign(turn));
    const diamond = execute(doc, 'preview_add_knurl', { id, face, pattern: 'diamond', pitch: (Math.PI * 20) / 60, helixAngleDeg: 20 });
    const hands = new Set((data(diamond)['lines'] as Array<{ hand: string }>).map((line) => line.hand));
    expect([...hands].sort()).toEqual(['left', 'right']);
    expect(data(diamond)['helixAngleDeg']).toBe(20);
    expect(data(diamond)['lines'] as unknown[]).toHaveLength(120);
  });

  it('more than 400 lines are thinned (every n-th tooth) and said so', () => {
    const wide = make(emptyDoc(), 'add_cylinder', { radius: 100, height: 40 });
    const result = execute(wide.doc, 'preview_add_knurl', { id: wide.id, face: { faceNear: [100, 0, 0] }, pattern: 'straight', pitch: 1 });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(data(result)).toMatchObject({ teeth: 628, thinned: true });
    expect((data(result)['lines'] as unknown[]).length).toBeLessThanOrEqual(400);
    expect(result.summary).toContain('every 2th');
  });

  it('refuses like add_knurl: a face that is not a cylinder, a pitch too coarse or not positive, a helix with a straight pattern, a hand without a diagonal geometry knurl', () => {
    const { doc, id } = rod();
    const ball = sphere();
    for (const [params, target] of [
      [{ id: ball.id, face: { faceNear: [25, 0, 0] }, pattern: 'straight', pitch: 1 }, ball.doc],
      [{ id, face, pattern: 'straight', pitch: 100 }, doc],
      [{ id, face, pattern: 'straight', pitch: 0 }, doc],
      [{ id, face, pattern: 'straight', pitch: 1, helixAngleDeg: 30 }, doc],
      [{ id, face, pattern: 'diagonal', pitch: 1, hand: 'left' }, doc],
      [{ id, face, pattern: 'diagonal', pitch: 1, helixAngleDeg: 95 }, doc],
      [{ id, face, pattern: 'straight', pitch: 0.01 }, doc],
    ] as const) {
      const real = execute(target, 'add_knurl', params);
      const preview = execute(target, 'preview_add_knurl', params);
      expect(real.error?.code).toBeDefined();
      expect(preview.error?.code).toBe(real.error?.code);
      expect(preview.document).toBe(target);
    }
  });
});
