/**
 * @layer server/tests
 * Live OpenCascade: smooth subdivision solids become exact B-spline solids (one bicubic face per
 * refined cage quad, sewn closed) whose volume matches the Catmull-Clark limit surface, that take
 * booleans, and that write B_SPLINE_SURFACE geometry to STEP. A faceted (level 0) cage stays
 * planar.
 */

import { describe, it, expect } from 'vitest';
import type { Entity, SubdivisionEntity, Vec3 } from '@core/model/types';
import { boxCage, cylinderCage, subdivisionTriangles } from '@core/geometry/subdivision';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { booleanRecipe, box, common, leaf, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();

const subdivision = (
  cage: Pick<SubdivisionEntity, 'vertices' | 'faces' | 'creases'>,
  levels: number,
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
): SubdivisionEntity =>
  ({
    id: 's',
    kind: 'subdivision',
    ...cage,
    levels,
    position,
    rotation,
    ...common,
  }) as Entity as SubdivisionEntity;

/** Volume of the subdivided mesh at a deep level (converges to the limit surface from outside). */
function limitVolume(entity: SubdivisionEntity): number {
  return subdivisionTriangles({ ...entity, levels: 5 }).reduce(
    (sum, [a, b, c]) =>
      sum + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6,
    0,
  );
}

function topologyOf(entity: Entity): NonNullable<ReturnType<typeof kernels.occt.topology>> {
  const shape = kernels.occt.evaluate(leaf(entity));
  expect(shape).not.toBeNull();
  const topology = kernels.occt.topology(shape as NonNullable<typeof shape>);
  expect(topology).not.toBeNull();
  return topology as NonNullable<typeof topology>;
}

describe('occt exact subdivision solids', () => {
  const blob = subdivision(boxCage([4, 3, 5], [2, 1, 1]), 2);

  it('sews one B-spline face per refined quad into a solid at the limit volume', () => {
    const topology = topologyOf(blob);
    expect(topology.solids).toBe(1);
    expect(topology.faces).toHaveLength(subdivisionPatches(blob).length);
    expect(topology.faces.every((face) => face.surface === 'bspline')).toBe(true);
    expect(topology.volume / limitVolume(blob)).toBeCloseTo(1, 2);
  });

  it('keeps its volume when moved and turned', () => {
    const turned = { ...blob, position: [3, -2, 7], rotation: [0.4, -0.3, 1.1] } as Entity;
    expect(topologyOf(turned).volume).toBeCloseTo(topologyOf(blob).volume, 6);
  });

  it('builds creased and extraordinary-vertex cages (cylinder with sharp caps)', () => {
    const cage = cylinderCage(1, 2, 6, 2);
    const rims = cage.faces.slice(-2).flatMap((face) => face.map((a, i) => [a, face[(i + 1) % face.length]] as [number, number]));
    const topology = topologyOf(subdivision({ ...cage, creases: rims }, 3));
    expect(topology.solids).toBe(1);
    expect(topology.volume).toBeGreaterThan(0.8 * Math.PI * 2 * 0.75);
    expect(topology.volume).toBeLessThan(Math.PI * 2);
  });

  it('takes an exact boolean with a box', () => {
    const cut = kernels.occt.evaluate(booleanRecipe('subtract', blob, box([0, 0, 2.5], [2, 2, 2])));
    expect(cut).not.toBeNull();
    const topology = kernels.occt.topology(cut as NonNullable<typeof cut>);
    expect(topology?.solids).toBe(1);
    expect(topology?.volume).toBeLessThan(topologyOf(blob).volume);
    expect(topology?.faces.some((face) => face.surface === 'plane')).toBe(true);
  });

  it('writes B-spline surfaces to STEP', () => {
    const shape = kernels.occt.evaluate(leaf(blob));
    const step = kernels.occt.exportStep([shape as NonNullable<typeof shape>]);
    expect(step).toContain('B_SPLINE_SURFACE');
  });

  it('builds a surface_from_curves hood as one exact solid', () => {
    const bow = (y: number): Vec3[] => [
      [0, y, 0],
      [5, y, 3],
      [10, y, 0],
    ];
    const result = execute(createEmptyDocument(), 'surface_from_curves', {
      curves: [bow(0), bow(8)],
      thickness: 0.5,
      cells: [6, 4],
    });
    const hood = result.document.entities[result.affected[0] as string] as Entity;
    const topology = topologyOf(hood);
    expect(topology.solids).toBe(1);
    expect(topology.faces.every((face) => face.surface === 'bspline')).toBe(true);
    expect(topology.volume / limitVolume(hood as SubdivisionEntity)).toBeCloseTo(1, 2);
  });

  it('keeps a faceted (level 0) cage planar', () => {
    const topology = topologyOf(subdivision(boxCage([2, 2, 2], [1, 1, 1]), 0));
    expect(topology.solids).toBe(1);
    expect(topology.faces.every((face) => face.surface === 'plane')).toBe(true);
    expect(topology.volume).toBeCloseTo(8, 6);
  });
});
