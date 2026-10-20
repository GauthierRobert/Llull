import { describe, expect, it } from 'vitest';
import type { PartSurface } from '@core/model/composites';
import type { Vec2, Vec3 } from '@core/model/types';
import { fibreDirection, fibreDirection3d, fromFlat, normalAt, toFlat, zeroDirection } from '@aero/composites/surface';

const plane: PartSurface = { type: 'plane', origin: [1, 2, 3], xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] };
const cylinder: PartSurface = { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 50 };
const cone: PartSurface = { type: 'cone', apex: [0, 0, 100], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: Math.PI / 4 };

const close = (a: readonly number[], b: readonly number[], digits = 9): void =>
  a.forEach((value, i) => expect(value).toBeCloseTo(b[i] as number, digits));

describe('developed frames of the tool face', () => {
  it('maps plane points to the face frame and back', () => {
    const hit = toFlat(plane, [4, 7, 9]);
    close(hit.uv, [5, 6]);
    expect(hit.offset).toBeCloseTo(3, 12);
    close(fromFlat(plane, hit.uv), [1, 7, 9]);
    expect(normalAt(plane, [0, 0])).toEqual([1, 0, 0]);
    expect(zeroDirection(plane, [3, 3])).toEqual([1, 0]);
  });

  it('unrolls a cylinder to (arc length, axial) and keeps the radial offset', () => {
    const point: Vec3 = [50 * Math.cos(1), 50 * Math.sin(1), 12];
    const hit = toFlat(cylinder, [point[0] * 1.1, point[1] * 1.1, point[2]]);
    close(hit.uv, [50, 12]);
    expect(hit.offset).toBeCloseTo(5, 9);
    close(fromFlat(cylinder, [50, 12]), point);
    close(normalAt(cylinder, [50, 12]), [Math.cos(1), Math.sin(1), 0]);
    expect(zeroDirection(cylinder, [5, 5])).toEqual([0, 1]);
    const wrapped = toFlat(cylinder, [50, -0.0001, 0]);
    expect(wrapped.uv[0]).toBeCloseTo(2 * Math.PI * 50, 2);
  });

  it('develops a cone to polar coordinates about the apex with azimuth * sin(half angle)', () => {
    const sin = Math.SQRT1_2;
    const rho = 80;
    const azimuth = 2;
    const point: Vec3 = [rho * sin * Math.cos(azimuth), rho * sin * Math.sin(azimuth), 100 - rho * sin];
    const hit = toFlat(cone, point);
    const flat: Vec2 = [rho * Math.cos(azimuth * sin), rho * Math.sin(azimuth * sin)];
    close(hit.uv, flat);
    expect(hit.offset).toBeCloseTo(0, 9);
    close(fromFlat(cone, hit.uv), point);
    expect(toFlat(cone, [30, 0, 100 - 10]).offset).toBeGreaterThan(0);
    const normal = normalAt(cone, hit.uv);
    expect(normal.reduce((sum, c) => sum + c * c, 0)).toBeCloseTo(1, 9);
    const generator = [point[0], point[1], point[2] - 100];
    expect(normal.reduce((sum, c, i) => sum + c * (generator[i] as number), 0)).toBeCloseTo(0, 9);
    close(zeroDirection(cone, [3, 4]), [0.6, 0.8]);
    expect(zeroDirection(cone, [0, 0])).toEqual([1, 0]);
  });

  it('turns fibre angles counter-clockwise from the zero direction, on the surface', () => {
    close(fibreDirection(plane, [0, 0], 90), [0, 1]);
    close(fibreDirection(cylinder, [0, 0], 90), [-1, 0]);
    const along = fibreDirection3d(cylinder, [0, 10], 0);
    close(along, [0, 0, 1], 6);
    const helix = fibreDirection3d(cylinder, [0, 10], 45);
    close(helix.map(Math.abs), [0, Math.SQRT1_2, Math.SQRT1_2], 6);
    const meridian = fibreDirection3d(cone, [30, 0], 0);
    expect(meridian[2]).toBeLessThan(0);
    expect(Math.hypot(...meridian)).toBeCloseTo(1, 9);
  });
});
