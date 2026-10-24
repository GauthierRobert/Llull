/**
 * 03 WRP M4: geodesic and parametric charts on sphere and torus faces (VC-WRP-08, 09, 27, 28), emboss / deboss on them with the closed-form volumes, and the distortion
 * limit. Fake exact kernel; the exact solids are proved natively in server/tests/nativeWrapCurved.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildChart } from '@core/geometry/faceChart';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { curveOf, emptyDoc, make, meshOf, sphere, useFakeKernel, type Made } from './support';

const R = 25;
const POLE = { faceNear: [0, 0, R] };
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const distortionOf = (result: ReturnType<typeof execute>): Record<string, number> => data(result)['distortion'] as Record<string, number>;

const disk = (base: Made, radius: number): Made => make(base.doc, 'draw_arc', { center: [0, 0], radius });
const torus = (): Made => make(emptyDoc(), 'add_torus', { ringRadius: 10, tubeRadius: 3 });

const geodesic = { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, R] } };

describe('wrap_to_face on a sphere (VC-WRP-08, 09, 28)', () => {
  useFakeKernel();

  it('geodesic disk a 10 on R 25: boundary 61.1696902, strain -0.0264541, area ratio 0.9867376', () => {
    const ball = sphere();
    const circle = disk(ball, 10);
    const result = execute(circle.doc, 'wrap_to_face', {
      id: ball.id,
      face: POLE,
      entityIds: [circle.id],
      placement: geodesic,
      maxLengthStrain: 0.05,
    });
    expect(result.rejected).toBeUndefined();
    const curve = (data(result)['curves'] as Array<Record<string, number>>)[0] as Record<string, number>;
    expect(relative(curve['length3d'] as number, 2 * Math.PI * R * Math.sin(10 / R))).toBeLessThan(1e-6);
    expect(relative(curve['length3d'] as number, 61.1696902)).toBeLessThan(1e-6);
    const info = distortionOf(result);
    expect(Math.abs((info['maxLengthStrain'] as number) + 0.0264541)).toBeLessThan(2e-6);
    expect(relative(info['areaRatio'] as number, 0.9867376)).toBeLessThan(1e-6);
    expect(info).toMatchObject({ method: 'geodesic', methodRequested: 'geodesic', limit: 0.05, limitDefaulted: false });
    expect(data(result)['method']).toBe('geodesic');
    expect(curveOf(result.document, result.affected[0] as string).onFace?.chartLength).toBeCloseTo(2 * Math.PI * 10, 9);
    expect(result.summary).toContain('geodesic');
    expectPure(circle.doc, () =>
      execute(circle.doc, 'wrap_to_face', { id: ball.id, face: POLE, entityIds: [circle.id], placement: geodesic, maxLengthStrain: 0.05 }),
    );
  });

  it('refuses the disk under the named 2 % default (a 2.65 % stretch) and reports the measured distortion', () => {
    const ball = sphere();
    const circle = disk(ball, 10);
    const refused = expectRefusal(
      circle.doc,
      'wrap_to_face',
      { id: ball.id, face: POLE, entityIds: [circle.id], placement: geodesic },
      'WRP_DISTORTION_EXCEEDED',
      'placement',
    );
    expect(refused.summary).toContain('geodesic chart stretches');
    expect(distortionOf(refused)).toMatchObject({ limit: 0.02, limitDefaulted: true });
    expect(relative(distortionOf(refused)['maxAbsLengthStrain'] as number, 0.0264541)).toBeLessThan(1e-4);
  });

  it('check_wrap fails the a 20 disk (-0.1033) and passes the a 10 disk against a 0.05 limit (VC-WRP-28)', () => {
    const ball = sphere();
    const big = disk(ball, 20);
    const small = make(big.doc, 'draw_arc', { center: [0, 0], radius: 10 });
    const wide = execute(small.doc, 'wrap_to_face', {
      id: ball.id,
      face: POLE,
      entityIds: [big.id],
      placement: geodesic,
      maxLengthStrain: 0.5,
    });
    expect(Math.abs((distortionOf(wide)['maxLengthStrain'] as number) + 0.1033)).toBeLessThan(1e-4);
    const narrow = execute(wide.document, 'wrap_to_face', {
      id: ball.id,
      face: POLE,
      entityIds: [small.id],
      placement: geodesic,
      maxLengthStrain: 0.05,
    });
    const failing = execute(narrow.document, 'check_wrap', { ids: [wide.affected[0]], maxLengthStrain: 0.05 });
    expect(data(failing)['status']).toBe('fail');
    expect((data(failing)['findings'] as Array<Record<string, unknown>>)[0]).toMatchObject({ code: 'WRP_CHECK_DISTORTION' });
    expect(((data(failing)['findings'] as Array<Record<string, number>>)[0] as Record<string, number>)['value']).toBeCloseTo(-0.1033, 3);
    const passing = execute(narrow.document, 'check_wrap', { ids: [narrow.affected[0]], maxLengthStrain: 0.05 });
    expect(data(passing)['status']).toBe('pass');
  });

  it('refuses develop on a sphere (VC-WRP-09), a sketch beyond the chart reach, and a freeform face', () => {
    const ball = sphere();
    const circle = disk(ball, 10);
    expectRefusal(
      circle.doc,
      'wrap_to_face',
      { id: ball.id, face: POLE, entityIds: [circle.id], placement: { method: 'develop' } },
      'WRP_FACE_NOT_DEVELOPABLE',
      'placement.method',
    );
    const wide = disk(ball, 45);
    const far = expectRefusal(
      wide.doc,
      'wrap_to_face',
      { id: ball.id, face: POLE, entityIds: [wide.id], placement: { method: 'geodesic' }, maxLengthStrain: 5 },
      'WRP_OUTSIDE_FACE',
    );
    expect(far.summary).toContain('reach');
    expect(
      buildChart(
        { type: 'other', kind: 'bspline' as never },
        { anchorChart: [0, 0], anchorOn: [0, 0, 0], angleDeg: 0, mirror: false },
        'geodesic',
      ),
    ).toEqual({ error: 'unsupported_surface' });
  });

  it('the parametric chart is affine (exact pcurves) and stretches away from the equator of its frame', () => {
    const ball = sphere();
    const circle = disk(ball, 5);
    const result = execute(circle.doc, 'wrap_to_face', {
      id: ball.id,
      face: POLE,
      entityIds: [circle.id],
      placement: { method: 'parametric', anchor: { chart: [0, 0], on: [0, 0, R] } },
      maxLengthStrain: 0.5,
    });
    expect(result.rejected).toBeUndefined();
    expect(distortionOf(result)).toMatchObject({ method: 'parametric' });
    expect(distortionOf(result)['maxAbsLengthStrain']).toBeGreaterThan(0);
    // a circle of radius 5 mapped by the equirectangular chart: every sample lies on the sphere
    const curve = curveOf(result.document, result.affected[0] as string);
    const samples = [0, 0.25, 0.5, 0.75].map((t) => {
      const poles = curve.curve.poles;
      return poles[Math.floor(t * (poles.length - 1))] as [number, number, number];
    });
    for (const [x, y, z] of samples) expect(Math.hypot(x, y, z)).toBeCloseTo(R, 3);
  });
});

describe('emboss_on_face on a sphere and a torus (closed forms)', () => {
  useFakeKernel();

  it('embosses a geodesic disk a 4, depth 1 on R 25: footprint 2 pi R^2 (1 - cos(a / R)), volume A (d + d^2 / R + d^3 / 3R^2)', () => {
    const ball = sphere();
    const circle = disk(ball, 4);
    const area = 2 * Math.PI * R * R * (1 - Math.cos(4 / R));
    const result = execute(circle.doc, 'emboss_on_face', {
      id: ball.id,
      face: POLE,
      profileIds: [circle.id],
      mode: 'emboss',
      depth: 1,
      placement: geodesic,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = data(result);
    expect(relative(info['regionArea'] as number, area)).toBeLessThan(1e-6);
    const volume = area * (1 + 1 / R + 1 / (3 * R * R));
    expect(relative(info['expectedVolumeDelta'] as number, volume)).toBeLessThan(1e-6);
    expect(relative(info['volumeDelta'] as number, volume)).toBeLessThan(1e-6);
    expect(info).toMatchObject({ method: 'geodesic', faceKind: 'sphere', convex: true });
    expect(meshOf(result.document, result.affected[0] as string).brep).toMatchObject({ op: 'emboss', surface: { type: 'sphere' } });
    const check = execute(result.document, 'check_wrap', { maxLengthStrain: 0.05 });
    expect(data(check)['status']).toBe('pass');
    expectPure(circle.doc, () =>
      execute(circle.doc, 'emboss_on_face', {
        id: ball.id,
        face: POLE,
        profileIds: [circle.id],
        mode: 'emboss',
        depth: 1,
        placement: geodesic,
      }),
    );
  });

  it('debosses the same disk: -A (d - d^2 / R + d^3 / 3R^2), and refuses a depth reaching the centre', () => {
    const ball = sphere();
    const circle = disk(ball, 4);
    const area = 2 * Math.PI * R * R * (1 - Math.cos(4 / R));
    const result = execute(circle.doc, 'emboss_on_face', {
      id: ball.id,
      face: POLE,
      profileIds: [circle.id],
      mode: 'deboss',
      depth: 2,
      placement: geodesic,
    });
    const volume = -area * (2 - 4 / R + 8 / (3 * R * R));
    expect(relative(data(result)['expectedVolumeDelta'] as number, volume)).toBeLessThan(1e-6);
    expect(
      expectRefusal(
        circle.doc,
        'emboss_on_face',
        { id: ball.id, face: POLE, profileIds: [circle.id], mode: 'deboss', depth: 30, placement: geodesic },
        'WRP_DEPTH_EXCEEDS_SOLID',
        'depth',
      ).data,
    ).toMatchObject({ maxDepth: R });
  });

  it('refuses a sphere emboss stretched beyond the limit', () => {
    const ball = sphere();
    const circle = disk(ball, 20);
    const refused = expectRefusal(
      circle.doc,
      'emboss_on_face',
      { id: ball.id, face: POLE, profileIds: [circle.id], mode: 'emboss', depth: 1, placement: geodesic },
      'WRP_DISTORTION_EXCEEDED',
    );
    expect(distortionOf(refused)['maxAbsLengthStrain']).toBeGreaterThan(0.1);
  });

  it('embosses a parametric rectangle on the outer equator of a torus R 10 r 3 with the tube-offset volume', () => {
    const ring = torus();
    const rect = make(ring.doc, 'draw_rectangle', { width: 4, height: 2, position: [-2, -1, 0] });
    const result = execute(rect.doc, 'emboss_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      profileIds: [rect.id],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'parametric', anchor: { chart: [0, 0], on: [13, 0, 0] } },
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const [major, minor, d] = [10, 3, 1];
    const uv = (4 / 13) * (2 / minor);
    const cosIntegral = (4 / 13) * 2 * Math.sin(1 / minor);
    const expected = major * (minor * d + (d * d) / 2) * uv + (((minor + d) ** 3 - minor ** 3) / 3) * cosIntegral;
    expect(relative(data(result)['expectedVolumeDelta'] as number, expected)).toBeLessThan(1e-9);
    expect(relative(data(result)['regionArea'] as number, minor * (major * uv + minor * cosIntegral))).toBeLessThan(1e-9);
    const down = execute(rect.doc, 'emboss_on_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      profileIds: [rect.id],
      mode: 'deboss',
      depth: 1,
      placement: { method: 'parametric', anchor: { chart: [0, 0], on: [13, 0, 0] } },
    });
    expect(data(down)['expectedVolumeDelta']).toBeLessThan(0);
    expectRefusal(
      rect.doc,
      'emboss_on_face',
      { id: ring.id, face: { faceNear: [13, 0, 0] }, profileIds: [rect.id], mode: 'emboss', depth: 1 },
      'WRP_FACE_NOT_DEVELOPABLE',
    );
  });

  it('wraps a geodesic circle on the torus: the circumferential stretch follows the tube curvature', () => {
    const ring = torus();
    const circle = disk(ring, 1);
    const result = execute(circle.doc, 'wrap_to_face', {
      id: ring.id,
      face: { faceNear: [13, 0, 0] },
      entityIds: [circle.id],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [13, 0, 0] } },
      maxLengthStrain: 0.5,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    // geodesic circle of radius a on a surface of Gaussian curvature K: L = 2 pi (a - K a^3 / 6 + ...); on the outer equator K = cos(v) / (r (R + r cos v)) = 1 / 39
    const length = (data(result)['curves'] as Array<Record<string, number>>)[0]?.['length3d'] as number;
    expect(length).toBeLessThan(2 * Math.PI);
    expect(2 * Math.PI - length).toBeCloseTo((2 * Math.PI) / (6 * 39), 3);
  });
});
