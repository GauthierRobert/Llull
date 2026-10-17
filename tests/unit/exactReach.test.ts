/** exactExitDepth: Newton on the exact surface through projectOnFace (curved exit wall) and its null paths. */
import { describe, expect, it } from 'vitest';
import { exactExitDepth } from '@core/geometry/exactReach';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import type { ShapeHandle } from '@core/geometry/kernel';

const FRAME = { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;
const SHAPE = {} as ShapeHandle;
type P = readonly [number, number, number];

/** A sphere of radius 8 centred at the origin: the axis through (3, 0) leaves its inside at z = -sqrt(64 - 9). */
const sphere = (face = 0): FaceQueryPort =>
  ({
    distance: (_shape: unknown, points: readonly P[]) => points.map(() => ({ distance: 0, signed: 0, face })),
    projectOnFace: (_shape: unknown, _face: number, points: readonly P[]) =>
      points.map(([x, y, z]) => {
        const length = Math.hypot(x, y, z);
        const normal: P = [x / length, y / length, z / length];
        return { point: [normal[0] * 8, normal[1] * 8, normal[2] * 8], normal, uv: [0, 0], distance: Math.abs(length - 8) };
      }),
  }) as unknown as FaceQueryPort;

describe('exactExitDepth', () => {
  it('converges on a curved wall from a chord-error mesh depth', () => {
    const exactZ = -Math.sqrt(64 - 9);
    const depth = exactExitDepth(sphere(), SHAPE, FRAME, [3, 0], 10 + 7.2);
    expect(depth).toBeCloseTo(10 - exactZ, 9);
  });

  it('is null without a nearest face or projection, for a grazing ray, a non-converging query and a face far from the mesh hit', () => {
    const base = sphere();
    expect(exactExitDepth({ ...base, distance: () => null } as FaceQueryPort, SHAPE, FRAME, [3, 0], 17)).toBeNull();
    expect(exactExitDepth({ ...base, projectOnFace: () => null } as FaceQueryPort, SHAPE, FRAME, [3, 0], 17)).toBeNull();
    const grazing = {
      ...base,
      projectOnFace: (_s: unknown, _f: number, [p]: readonly P[]) => [{ point: p, normal: [1, 0, 0], uv: [0, 0], distance: 0 }],
    };
    expect(exactExitDepth(grazing as unknown as FaceQueryPort, SHAPE, FRAME, [3, 0], 17)).toBeNull();
    const offSurface = {
      ...base,
      projectOnFace: (_s: unknown, _f: number, [p]: readonly P[]) => [{ point: p, normal: [0, 0, 1], uv: [0, 0], distance: 1 }],
    };
    expect(exactExitDepth(offSurface as unknown as FaceQueryPort, SHAPE, FRAME, [3, 0], 17)).toBeNull();
    expect(exactExitDepth(sphere(), SHAPE, FRAME, [3, 0], 30)).toBeNull();
  });
});
