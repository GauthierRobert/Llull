/**
 * 03 WRP M4: create_curve_on_face (VC-WRP-37 and the sphere / torus geodesics, isoparametric and uv modes) and split_face_by_curves (VC-WRP-17 command logic) on a fake exact
 * kernel; the exact split is proved natively in server/tests/nativeWrapCurved.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { curveOf, cylinder, emptyDoc, FACE, make, meshOf, sphere, useFakeKernel, type Made } from './support';

const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const curveInfo = (result: ReturnType<typeof execute>): Record<string, number> => data(result)['curve'] as Record<string, number>;
const torus = (): Made => make(emptyDoc(), 'add_torus', { ringRadius: 10, tubeRadius: 3 });
const onCylinder = (theta: number, z: number): number[] => [20 * Math.cos(theta), 20 * Math.sin(theta), z];

describe('create_curve_on_face geodesic (VC-WRP-37)', () => {
  useFakeKernel();

  it.each([
    [1, 10, 22.3606798],
    [0.5, 0, 10],
    [2, 5, 40.3112887],
  ])('cylinder r 20: Δθ %d rad, Δz %d gives a helix of length %d', (angle, rise, expected) => {
    const { doc, id } = cylinder();
    const result = execute(doc, 'create_curve_on_face', {
      id,
      face: FACE,
      mode: 'geodesic',
      from: onCylinder(0, 0),
      to: onCylinder(angle, rise),
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(relative(curveInfo(result)['length3d'] as number, expected)).toBeLessThan(1e-6);
    const curve = curveOf(result.document, result.affected[0] as string);
    expect(curve.onFace).toMatchObject({ entityId: id });
    expect(curve.onFace?.frame).toBeUndefined();
    const end = curve.curve.poles[curve.curve.poles.length - 1] as unknown as number[];
    expect(Math.hypot(end[0] as number, end[1] as number)).toBeCloseTo(20, 4);
  });

  it('sphere R 25: the arc between two points is the great circle (length R x angle), at most a quarter turn', () => {
    const ball = sphere();
    const result = execute(ball.doc, 'create_curve_on_face', {
      id: ball.id,
      face: { faceNear: [0, 0, 25] },
      mode: 'geodesic',
      from: [0, 0, 25],
      to: [25 * Math.sin(0.5), 0, 25 * Math.cos(0.5)],
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(relative(curveInfo(result)['length3d'] as number, 12.5)).toBeLessThan(1e-6);
    expectRefusal(
      ball.doc,
      'create_curve_on_face',
      { id: ball.id, face: { faceNear: [0, 0, 25] }, mode: 'geodesic', from: [0, 0, 25], to: [0, 0, -25] },
      'WRP_GEODESIC_FAILED',
      'to',
    );
    expectRefusal(
      ball.doc,
      'create_curve_on_face',
      { id: ball.id, face: { faceNear: [0, 0, 25] }, mode: 'geodesic', from: [0, 0, 25], to: [0, 0, 25] },
      'WRP_GEODESIC_FAILED',
    );
  });

  it('torus R 10 r 3: the outer equator and a meridian are geodesics of length ring x Δu and r x Δv', () => {
    const ring = torus();
    const equator = execute(ring.doc, 'create_curve_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      mode: 'geodesic',
      from: [13, 0, 0],
      to: [13 * Math.cos(0.3), 13 * Math.sin(0.3), 0],
    });
    expect(equator.rejected, equator.summary).toBeUndefined();
    expect(relative(curveInfo(equator)['length3d'] as number, 13 * 0.3)).toBeLessThan(1e-6);
    const meridian = execute(ring.doc, 'create_curve_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      mode: 'geodesic',
      from: [13, 0, 0],
      to: [10 + 3 * Math.cos(0.5), 0, 3 * Math.sin(0.5)],
    });
    expect(relative(curveInfo(meridian)['length3d'] as number, 1.5)).toBeLessThan(1e-6);
    const slanted = execute(ring.doc, 'create_curve_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      mode: 'geodesic',
      from: [13, 0, 0],
      to: [(10 + 3 * Math.cos(0.4)) * Math.cos(0.2), (10 + 3 * Math.cos(0.4)) * Math.sin(0.2), 3 * Math.sin(0.4)],
    });
    expect(slanted.rejected, slanted.summary).toBeUndefined();
    const chord = Math.hypot(13 - (10 + 3 * Math.cos(0.4)) * Math.cos(0.2), (10 + 3 * Math.cos(0.4)) * Math.sin(0.2), 3 * Math.sin(0.4));
    expect(curveInfo(slanted)['length3d']).toBeGreaterThan(chord);
    expect(curveInfo(slanted)['length3d']).toBeLessThan(13 * 0.2 + 3 * 0.4);
  });

  it('refuses points off the face, a cone-apex path, missing mode parameters, unknown ids; is pure', () => {
    const { doc, id } = cylinder();
    expectRefusal(
      doc,
      'create_curve_on_face',
      { id, face: FACE, mode: 'geodesic', from: [90, 0, 0], to: onCylinder(1, 0) },
      'WRP_ANCHOR_OFF_FACE',
      'from',
    );
    expectRefusal(
      doc,
      'create_curve_on_face',
      { id, face: FACE, mode: 'geodesic', from: onCylinder(0, 0), to: [90, 0, 0] },
      'WRP_ANCHOR_OFF_FACE',
      'to',
    );
    expectRefusal(doc, 'create_curve_on_face', { id, face: FACE, mode: 'geodesic', from: onCylinder(0, 0) }, 'WRP_PARAM_INVALID');
    expectRefusal(doc, 'create_curve_on_face', { id, face: FACE, mode: 'isoparametric', through: onCylinder(0, 0) }, 'WRP_PARAM_INVALID');
    expectRefusal(doc, 'create_curve_on_face', { id, face: FACE, mode: 'uv' }, 'WRP_PARAM_INVALID');
    expectRefusal(
      doc,
      'create_curve_on_face',
      {
        id: 'nope',
        face: FACE,
        mode: 'uv',
        uv: [
          [0, 0],
          [1, 1],
        ],
      },
      'WRP_ENTITY_NOT_FOUND',
    );
    expectPure(doc, () =>
      execute(doc, 'create_curve_on_face', { id, face: FACE, mode: 'geodesic', from: onCylinder(0, 0), to: onCylinder(1, 5) }),
    );
  });
});

describe('create_curve_on_face isoparametric and uv', () => {
  useFakeKernel();

  it('an axial iso line spans the face (40) and a ring iso curve closes round it (2 pi r)', () => {
    const { doc, id } = cylinder();
    const axial = execute(doc, 'create_curve_on_face', {
      id,
      face: FACE,
      mode: 'isoparametric',
      through: onCylinder(0.4, 3),
      direction: 'v',
    });
    expect(axial.rejected, axial.summary).toBeUndefined();
    expect(relative(curveInfo(axial)['length3d'] as number, 40)).toBeLessThan(1e-6);
    expect(curveOf(axial.document, axial.affected[0] as string).onFace?.frame).toBe('native');
    const ring = execute(doc, 'create_curve_on_face', { id, face: FACE, mode: 'isoparametric', through: onCylinder(0, 3), direction: 'u' });
    expect(ring.rejected, ring.summary).toBeUndefined();
    expect(relative(curveInfo(ring)['length3d'] as number, 2 * Math.PI * 20)).toBeLessThan(1e-4);
  });

  it('a cubic through (u, v) points: two points make the helix of the development', () => {
    const { doc, id } = cylinder();
    const helix = execute(doc, 'create_curve_on_face', {
      id,
      face: FACE,
      mode: 'uv',
      uv: [
        [0, 0],
        [1, 10],
      ],
    });
    expect(helix.rejected, helix.summary).toBeUndefined();
    expect(relative(curveInfo(helix)['length3d'] as number, Math.hypot(20, 10))).toBeLessThan(1e-4);
    const bent = execute(doc, 'create_curve_on_face', {
      id,
      face: FACE,
      mode: 'uv',
      uv: [
        [0, 0],
        [0.5, 4],
        [1, 0],
      ],
    });
    expect(bent.rejected, bent.summary).toBeUndefined();
    expect(data(bent)['faceKind']).toBe('cylinder');
  });

  it('refuses a uv curve leaving the face and coincident points', () => {
    const { doc, id } = cylinder();
    expectRefusal(
      doc,
      'create_curve_on_face',
      {
        id,
        face: FACE,
        mode: 'uv',
        uv: [
          [0, 0],
          [1, 60],
        ],
      },
      'WRP_OUTSIDE_FACE',
    );
    expectRefusal(
      doc,
      'create_curve_on_face',
      {
        id,
        face: FACE,
        mode: 'uv',
        uv: [
          [1, 1],
          [1, 1],
        ],
      },
      'WRP_PARAM_INVALID',
    );
  });
});

describe('split_face_by_curves', () => {
  useFakeKernel();

  const ring = (): { doc: ReturnType<typeof emptyDoc>; solid: string; curve: string } => {
    const base = cylinder();
    const made = execute(base.doc, 'create_curve_on_face', {
      id: base.id,
      face: FACE,
      mode: 'isoparametric',
      through: onCylinder(0, 3),
      direction: 'u',
    });
    return { doc: made.document, solid: base.id, curve: made.affected[0] as string };
  };

  it('divides the cylinder face along a ring curve: more faces, new face names, the curve kept', () => {
    const { doc, solid, curve } = ring();
    const result = execute(doc, 'split_face_by_curves', { id: solid, curveIds: [curve] });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = data(result);
    expect(info['facesAfter'] as number).toBeGreaterThan(info['facesBefore'] as number);
    expect((info['faces'] as unknown[]).length).toBeGreaterThan(0);
    expect(info).toMatchObject({ volumeBefore: expect.any(Number), unverified: false });
    expect(meshOf(result.document, result.affected[0] as string).brep).toMatchObject({
      op: 'emboss',
      mode: 'split',
      surface: { type: 'face' },
    });
    expect(result.document.entities[curve]).toBeDefined();
    expect(result.document.entities[solid]).toBeUndefined();
    expect(result.summary).toContain('faces');
    expectPure(doc, () => execute(doc, 'split_face_by_curves', { id: solid, curveIds: [curve] }));
  });

  it('refuses a curve that is not a curve on a face, unknown ids, a curve off the solid and a split that divides nothing', () => {
    const { doc, solid, curve } = ring();
    const line = make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
      ],
    });
    expectRefusal(line.doc, 'split_face_by_curves', { id: solid, curveIds: [line.id] }, 'WRP_SPLIT_CURVE_NOT_ON_FACE', 'curveIds.0');
    expectRefusal(doc, 'split_face_by_curves', { id: solid, curveIds: ['nope'] }, 'WRP_ENTITY_NOT_FOUND');
    expectRefusal(doc, 'split_face_by_curves', { id: 'nope', curveIds: [curve] }, 'WRP_ENTITY_NOT_FOUND');
    const other = make(doc, 'add_cylinder', { radius: 5, height: 5, position: [100, 0, 0] });
    expectRefusal(other.doc, 'split_face_by_curves', { id: other.id, curveIds: [curve] }, 'WRP_SPLIT_CURVE_NOT_ON_FACE', 'curveIds');
  });
});
