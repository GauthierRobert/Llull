/**
 * Live OpenCascade vs Manifold for exact curves: sweeps (round, hollow and polygon sections along
 * bent / smooth paths) and extrusions / revolutions whose profile carries `curves`. OCC builds the
 * exact B-rep (arcs, Béziers, pipe surfaces — visible in STEP); Manifold works from the shared
 * tessellation, so both agree within chord tolerance.
 */

import { describe, it, expect } from 'vitest';
import type { CadDocument, Entity } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import type { ShapeTopology } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { booleanMesh, box, common, expectBoundsClose, liveKernels, meshOf, volume } from './kernelTestSupport';

const kernels = liveKernels();

function created(doc: CadDocument, name: string, params: Record<string, unknown>): Entity {
  const result = execute(doc, name, params);
  const id = result.affected[0];
  expect(id, result.summary).toBeDefined();
  return result.document.entities[id as string] as Entity;
}

const empty = createEmptyDocument();

/** Doc with one sketch entity (fixture setup only). */
function sketch(entity: Record<string, unknown>): CadDocument {
  const e = { position: [0, 0, 0], rotation: [0, 0, 0], ...common, ...entity } as unknown as Entity;
  return { ...empty, entities: { [e.id]: e }, order: [e.id] };
}

function volumes(entity: Entity): { occt: number; manifold: number } {
  const occ = meshOf(kernels.occt, entity);
  const man = meshOf(kernels.manifold, entity);
  expect(occ).not.toBeNull();
  expect(man).not.toBeNull();
  return { occt: volume(occ as NonNullable<typeof occ>), manifold: volume(man as NonNullable<typeof man>) };
}

function topologyOf(entity: Entity): ShapeTopology {
  const shape = kernels.occt.evaluate({ op: 'solid', entity });
  expect(shape).not.toBeNull();
  const topology = kernels.occt.topology(shape as NonNullable<typeof shape>);
  expect(topology).not.toBeNull();
  return topology as ShapeTopology;
}

const curvedArea = (topology: ShapeTopology): number =>
  topology.faces.filter((face) => face.surface !== 'plane').reduce((sum, f) => sum + f.area, 0);

function stepOf(entity: Entity): string {
  const shape = kernels.occt.evaluate({ op: 'solid', entity });
  expect(shape).not.toBeNull();
  return kernels.occt.exportStep([shape as NonNullable<typeof shape>]) ?? '';
}

const L_PATH = [
  [0, 0, 0],
  [20, 0, 0],
  [20, 15, 10],
];

describe('sweep_profile on the live kernels', () => {
  it('round pipe along a bent path: exact pipe wall 2π r L, meshes match π r² L', () => {
    const pipe = created(empty, 'sweep_profile', { path: L_PATH, radius: 1.5, bendRadius: 5 });
    const exact = (
      execute({ ...empty, entities: { [pipe.id]: pipe } }, 'mass_properties', { entityId: pipe.id }).data as { volume: number }
    ).volume;
    const { occt, manifold } = volumes(pipe);
    const length = exact / (Math.PI * 1.5 ** 2);
    const topology = topologyOf(pipe);
    expect(topology.solids).toBe(1);
    expect(curvedArea(topology) / (2 * Math.PI * 1.5 * length)).toBeCloseTo(1, 4);
    expect(occt / exact).toBeGreaterThan(0.97);
    expect(occt / exact).toBeLessThan(1.01);
    expect(manifold / exact).toBeGreaterThan(0.97);
    expect(manifold / exact).toBeLessThan(1.01);
    expect(stepOf(pipe)).toMatch(/CIRCLE/);
  });

  it('hollow pipe: volume is the annulus area times the path length', () => {
    const tube = created(empty, 'sweep_profile', { path: L_PATH, radius: 2, innerRadius: 1.5, bendRadius: 6 });
    const exact = (
      execute({ ...empty, entities: { [tube.id]: tube } }, 'mass_properties', { entityId: tube.id }).data as { volume: number }
    ).volume;
    const { occt, manifold } = volumes(tube);
    for (const measured of [occt, manifold]) {
      expect(measured / exact).toBeGreaterThan(0.97);
      expect(measured / exact).toBeLessThan(1.01);
    }
    expect(topologyOf(tube).solids).toBe(1);
  });

  it('rectangular duct along a smooth spline: kernels agree and the solid is booleanable', () => {
    const duct = created(empty, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [10, 5, 2],
        [20, 0, 4],
        [30, -5, 2],
      ],
      smooth: true,
      section: [
        [-1, -0.5],
        [1, -0.5],
        [1, 0.5],
        [-1, 0.5],
      ],
    });
    const { occt, manifold } = volumes(duct);
    expect(occt / manifold).toBeCloseTo(1, 1);
    const cut = booleanMesh(kernels.occt, 'subtract', duct, box([15, 0, 2], [4, 20, 20]));
    expect(cut).not.toBeNull();
    expect(volume(cut as NonNullable<typeof cut>)).toBeLessThan(occt);
  });
});

describe('sweep section roll', () => {
  it('OCC and the shared tessellation carry a flat section the same way on a non-planar path', () => {
    const strap = created(empty, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [10, 10, 10],
      ],
      bendRadius: 3,
      section: [
        [-2, -0.2],
        [2, -0.2],
        [2, 0.2],
        [-2, 0.2],
      ],
    });
    const occ = meshOf(kernels.occt, strap);
    const man = meshOf(kernels.manifold, strap);
    expectBoundsClose(occ as NonNullable<typeof occ>, man as NonNullable<typeof man>, 0.05);
  });
});

describe('exact profile curves on the live OCC kernel', () => {
  it('extrude_profile of a circle builds a true cylinder face (STEP has CIRCLE)', () => {
    const doc = sketch({ id: 'c', kind: 'circle', center: [0, 0], radius: 5 });
    const ext = created(doc, 'extrude_profile', { id: 'c', depth: 4 });
    const wall = topologyOf(ext).faces.filter((face) => face.surface === 'cylinder');
    expect(wall.reduce((sum, face) => sum + face.area, 0) / (2 * Math.PI * 5 * 4)).toBeCloseTo(1, 6);
    expect(volumes(ext).occt / (Math.PI * 25 * 4)).toBeGreaterThan(0.98);
    expect(stepOf(ext)).toMatch(/CIRCLE/);
  });

  it('revolve_profile of a closed spline nozzle keeps Bézier edges in STEP', () => {
    const doc = sketch({
      id: 's',
      kind: 'spline',
      closed: true,
      points: [
        [2, 0],
        [4, 3],
        [3, 6],
        [6, 10],
        [5, 11],
        [1.5, 6],
        [1, 2],
      ],
    });
    const rev = created(doc, 'revolve_profile', { profileIds: ['s'] });
    const { occt, manifold } = volumes(rev);
    expect(occt / manifold).toBeCloseTo(1, 1);
    expect(stepOf(rev)).toMatch(/B_SPLINE|BEZIER/);
  });
});
