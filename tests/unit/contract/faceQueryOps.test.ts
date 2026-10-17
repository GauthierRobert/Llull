import { describe, expect, it, vi } from 'vitest';
import type { BoxEntity, ShapeRecipe } from '@core/model/types';
import { type FaceQueryOps, type KernelOps, handleOf, kernelFromOps, keyOnlyHandle, SHAPE_NOT_CACHED } from '@core/geometry/shapeKernel';
import type { FaceDetail } from '@core/geometry/kernelPorts';
import { TETRA } from '../../helpers/fakeKernel';

interface Native {
  readonly label: string;
}

const box: BoxEntity = { id: 'a', kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'l', color: '#888888', size: [1, 1, 1] };
const leaf: ShapeRecipe = { op: 'solid', entity: box };
const DETAIL: FaceDetail = { index: 0, surface: 'plane', area: 1, centroid: [0, 0, 0], samples: [] };

const nothing = (): null => null;
const faceQuery = (overrides: Partial<FaceQueryOps<Native>> = {}): FaceQueryOps<Native> => ({
  faceDetails: (shape) => [{ ...DETAIL, surface: shape.label === 'solid:a' ? 'plane' : 'other' }],
  faceContains: nothing,
  faceGraph: nothing,
  faceGeometry: nothing,
  projectOnFace: nothing,
  evaluateFace: nothing,
  tessellateFace: nothing,
  faceSamples: nothing,
  edgeSamples: nothing,
  edgeContinuity: nothing,
  distance: nothing,
  bspline: nothing,
  ...overrides,
});

function opsWith(
  query?: FaceQueryOps<Native>,
  solid: KernelOps<Native>['solid'] = (entity) => ({ label: `solid:${entity.id}` }),
): KernelOps<Native> {
  const ops: KernelOps<Native> = {
    solid,
    boolean: nothing,
    fillet: nothing,
    blend: nothing,
    chamfer: nothing,
    shell: nothing,
    place: nothing,
    scale: nothing,
    tessellate: () => TETRA,
    topology: nothing,
    exportStep: nothing,
    release: () => undefined,
  };
  return query === undefined ? ops : { ...ops, faceQuery: query };
}

describe('kernelFromOps face query', () => {
  it('is absent when the ops have none', () => {
    expect(kernelFromOps(opsWith()).faceQuery).toBeUndefined();
  });

  it('resolves a handle to its native shape and forwards the arguments', () => {
    const faceContains = vi.fn(
      (_shape: Native, face: number, _point: readonly number[], tolerance?: number) => face === 1 && tolerance === 0.5,
    );
    const kernel = kernelFromOps(opsWith(faceQuery({ faceContains: faceContains as FaceQueryOps<Native>['faceContains'] })));
    const handle = kernel.evaluate(leaf)!;
    expect(kernel.faceQuery?.faceDetails(handle)?.[0]?.surface).toBe('plane');
    expect(kernel.faceQuery?.faceContains(handle, 1, [0, 0, 0], 0.5)).toBe(true);
    expect(faceContains).toHaveBeenCalledWith({ label: 'solid:a' }, 1, [0, 0, 0], 0.5);
  });

  it('returns null for a recipe the kernel refused, and for any throw', () => {
    const refused = kernelFromOps(opsWith(faceQuery(), () => null));
    expect(refused.faceQuery?.faceDetails(handleOf(leaf))).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwing = kernelFromOps(
      opsWith(
        faceQuery({
          faceDetails: () => {
            throw new Error('boom');
          },
        }),
      ),
    );
    expect(throwing.faceQuery?.faceDetails(throwing.evaluate(leaf)!)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warn.mockRestore();
  });

  it('lets an uncached key-only handle surface as SHAPE_NOT_CACHED so a proxy can resend the recipe', () => {
    const kernel = kernelFromOps(opsWith(faceQuery()));
    const handle = kernel.evaluate(leaf)!;
    kernel.clear();
    expect(() => kernel.faceQuery?.faceDetails(keyOnlyHandle(handle))).toThrow(SHAPE_NOT_CACHED);
    expect(kernel.faceQuery?.faceDetails(handle)).not.toBeNull();
  });
});

describe('kernelFromOps info', () => {
  it('lists every optional port that is wired, on top of what the ops declare', () => {
    const ops: KernelOps<Native> = {
      ...opsWith(faceQuery()),
      info: () => ({ occtVersion: '7.4.0p1', capabilities: ['topology', 'exportStep'] }),
      massProperties: nothing,
      brep: nothing,
    };
    const info = kernelFromOps(ops).info?.();
    expect(info?.occtVersion).toBe('7.4.0p1');
    expect(info?.capabilities).toEqual(['topology', 'exportStep', 'massProperties', 'faceQuery', 'brepBlobs']);
    expect(kernelFromOps(opsWith()).info).toBeUndefined();
  });
});
