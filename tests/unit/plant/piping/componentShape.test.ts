/** Plant 01 PSC M4: `component_shape` (VC-PSC-19): analytic bounds, ports, recipes built by the mesh kernel, refusals. Expected values come from the pack oracle file. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { createEmptyDocument, type MeshData, type ShapeRecipe } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { packJson } from './packData';
import { importedDoc } from './specFixture';

interface Shape {
  type: string;
  recipe: ShapeRecipe;
  bounds: { min: number[]; max: number[]; size: number[] };
  ports: Array<{ id: string; position: number[]; direction: number[]; outsideDiameterMm: number; endType: string | null }>;
  hollow: boolean;
  notes: string[];
  stats: { leaves: number; booleans: number };
  verified: boolean;
  warnings?: Array<{ code: string }>;
}
const oracle = packJson<{
  shapes: {
    elbowLr90Nps6: { boundsMin: number[]; boundsMax: number[]; centreToEndMm: number; odMm: number };
    elbowLr45Nps4: Record<string, number>;
  };
}>('psc_m4_oracles.json').shapes;
const doc = createEmptyDocument();
const specDoc = importedDoc();
const shape = (params: Record<string, unknown>, from = doc): Shape => data<Shape>(from, 'component_shape', params);
const near = (actual: number, expected: number, tolerance: number): void =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
const nearAll = (actual: readonly number[], expected: readonly number[], tolerance: number): void =>
  expected.forEach((value, index) => near(actual[index] as number, value, tolerance));
const norm = (vector: readonly number[]): number => Math.hypot(...vector);

let previous: GeometryKernel | null = null;
let kernel: GeometryKernel;
beforeAll(async () => {
  previous = getGeometryKernel();
  kernel = await createManifoldKernel();
  setGeometryKernel(kernel);
}, 60_000);
afterAll(() => setGeometryKernel(previous));

function mesh(recipe: ShapeRecipe): { min: number[]; max: number[]; volume: number } {
  const handle = kernel.evaluate(recipe);
  expect(handle, 'the kernel builds the recipe').not.toBeNull();
  const built = kernel.tessellate(handle as never) as MeshData;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < built.positions.length; at += 3)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] as number, built.positions[at + axis] as number);
      max[axis] = Math.max(max[axis] as number, built.positions[at + axis] as number);
    }
  let volume = 0;
  for (let at = 0; at < built.indices.length; at += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (built.indices[at + k] as number) * 3);
    const p = (i: number): number[] => [built.positions[i] as number, built.positions[i + 1] as number, built.positions[i + 2] as number];
    const [pa, pb, pc] = [p(a as number), p(b as number), p(c as number)] as [number[], number[], number[]];
    volume +=
      (pa[0]! * (pb[1]! * pc[2]! - pb[2]! * pc[1]!) -
        pa[1]! * (pb[0]! * pc[2]! - pb[2]! * pc[0]!) +
        pa[2]! * (pb[0]! * pc[1]! - pb[1]! * pc[0]!)) /
      6;
  }
  return { min, max, volume: Math.abs(volume) };
}

describe('component_shape, elbows (VC-PSC-19)', () => {
  const lr90 = { type: 'elbow90', nps: 6, radius: 'LR' };

  it('has the closed-form bounds of the LR 90 NPS 6 elbow: 312.75 x 312.75 x 168.3 mm', () => {
    const elbow = shape(lr90);
    nearAll(elbow.bounds.min, oracle.elbowLr90Nps6.boundsMin, 1e-9);
    nearAll(elbow.bounds.max, oracle.elbowLr90Nps6.boundsMax, 1e-9);
    nearAll(elbow.bounds.size, [312.75, 312.75, 168.3], 1e-9);
    expect(elbow.hollow).toBe(false);
    expect(elbow.notes).toContain('no wall: drawn solid');
    expect(elbow.verified).toBe(true);
  });

  it('puts the end faces in the planes y = 0 and x = 0 with outward unit directions and the pipe OD', () => {
    const [a, b] = shape(lr90).ports;
    nearAll(a?.position ?? [], [228.6, 0, 0], 1e-9);
    nearAll(a?.direction ?? [], [0, -1, 0], 1e-12);
    nearAll(b?.position ?? [], [0, 228.6, 0], 1e-9);
    nearAll(b?.direction ?? [], [-1, 0, 0], 1e-12);
    expect([a?.outsideDiameterMm, b?.outsideDiameterMm]).toEqual([168.3, 168.3]);
    expect([a?.endType, b?.endType]).toEqual(['BW', 'BW']);
  });

  it('is a valid recipe that the mesh kernel builds within 0.5 % of the analytic bounds and the Pappus volume', () => {
    const elbow = shape(lr90);
    expect(validateShapeRecipe(elbow.recipe)).toBeNull();
    const built = mesh(elbow.recipe);
    nearAll(built.min, oracle.elbowLr90Nps6.boundsMin, 0.005 * 312.75);
    nearAll(built.max, oracle.elbowLr90Nps6.boundsMax, 0.005 * 312.75);
    const exact = Math.PI * 84.15 ** 2 * 228.6 * (Math.PI / 2);
    expect(Math.abs(built.volume / exact - 1)).toBeLessThan(0.005);
  });

  it('makes the elbow hollow from the spec pipe wall (Sch 40, 7.11 mm) and its volume is the Pappus ring', () => {
    const elbow = shape({ specId: 'CS150-A1', type: 'elbow90', nps: 6 }, specDoc);
    expect(elbow.hollow).toBe(true);
    expect(elbow.stats.booleans).toBe(3);
    const built = mesh(elbow.recipe);
    const ring = Math.PI * (84.15 ** 2 - (84.15 - 7.11) ** 2) * 228.6 * (Math.PI / 2);
    expect(Math.abs(built.volume / ring - 1)).toBeLessThan(0.01);
    nearAll(elbow.bounds.size, [312.75, 312.75, 168.3], 1e-9);
  });

  it('keeps the 0.37 mm straight ends of the LR 45 NPS 4 elbow whose tabulated B exceeds R tan(22.5 deg)', () => {
    const elbow = shape({ type: 'elbow45', nps: 4, radius: 'LR' });
    const expected = oracle.elbowLr45Nps4;
    const tangent = (expected['centreToEndMm'] as number) - (expected['bendRadiusMm'] as number) * Math.tan(Math.PI / 8);
    near(tangent, expected['tangentMm'] as number, 5e-5);
    expect(elbow.notes.some((note) => note.startsWith('straight ends of 0.37 mm'))).toBe(true);
    const [a, b] = elbow.ports;
    near(a?.position[1] as number, -tangent, 1e-9);
    near(norm(b?.direction ?? []), 1, 1e-12);
    near(
      Math.hypot((b?.position[0] as number) - 152.4 * Math.cos(Math.PI / 4), (b?.position[1] as number) - 152.4 * Math.sin(Math.PI / 4)),
      tangent,
      1e-9,
    );
    const built = mesh(elbow.recipe);
    nearAll(built.min.slice(0, 1), [elbow.bounds.min[0] as number], 0.5);
    nearAll(built.max, elbow.bounds.max, 0.01 * 152.4);
  });

  it('refuses an elbow whose tabulated centre-to-end is shorter than the bend allows (PSC_CATALOG_DIM_MISMATCH)', () => {
    const imported = execute(doc, 'import_piping_catalog', {
      catalog: {
        format: 'llull-piping-catalog',
        schemaVersion: 1,
        id: 'bad-elbow',
        licence: 'open-data',
        families: [
          {
            id: 'bad-b16.9-lr45',
            type: 'elbow45',
            standard: 'ASME B16.9',
            radius: 'LR',
            sizes: [{ nps: 4, centreToEnd: 40, provenance: { citation: 'test' } }],
          },
        ],
      },
    });
    expectRefusal(imported.document, 'component_shape', { catalogId: 'bad-elbow', type: 'elbow45', nps: 4 }, 'PSC_CATALOG_DIM_MISMATCH');
  });
});

describe('component_shape, the other types', () => {
  it('builds the tee as run plus branch with three ports and bounds from the tabulated run C', () => {
    const tee = shape({ type: 'tee', nps: 6 });
    expect(tee.ports.map((port) => port.id)).toEqual(['A', 'B', 'C']);
    nearAll(tee.bounds.min, [-143, -84.15, -84.15], 1e-9);
    nearAll(tee.bounds.max, [143, 143, 84.15], 1e-9);
    nearAll(tee.ports[2]?.position ?? [], [0, 143, 0], 1e-12);
    expect(tee.verified).toBe(false);
    expect(tee.warnings?.[0]?.code).toBe('PSC_DATA_UNVERIFIED');
  });

  it('builds a hollow tee from the spec with the schedule 40 wall, and the kernel agrees on the extent', () => {
    const tee = shape({ specId: 'CS150-A1', componentId: 'T-BW', nps: 6 }, specDoc);
    expect(tee.hollow).toBe(true);
    const built = mesh(tee.recipe);
    nearAll(built.min, tee.bounds.min, 1);
    nearAll(built.max, tee.bounds.max, 1);
  });

  it('builds a hollow concentric reducer frustum NPS 8 x 6 of length 152 mm (large end at z = 0)', () => {
    const reducer = shape({ specId: 'CS150-A1', type: 'reducerConcentric', nps: 8, branchNps: 6 }, specDoc);
    nearAll(reducer.bounds.min, [-109.55, -109.55, 0], 1e-9);
    nearAll(reducer.bounds.max, [109.55, 109.55, 152], 1e-9);
    expect(reducer.ports.map((port) => port.outsideDiameterMm)).toEqual([219.1, 168.3]);
    expect(reducer.hollow).toBe(true);
    const frustum = (Math.PI * 152 * (109.55 ** 2 + 109.55 * 84.15 + 84.15 ** 2)) / 3;
    const bore = (Math.PI * 152 * ((109.55 - 8.18) ** 2 + (109.55 - 8.18) * (84.15 - 8.18) + (84.15 - 8.18) ** 2)) / 3;
    const built = mesh(reducer.recipe);
    expect(Math.abs(built.volume / (frustum - bore) - 1)).toBeLessThan(0.02);
  });

  it('builds the NPS 4 Class 150 weld-neck flange: disc OD 228.6, raised face, 8 holes of 19.05 mm on the 190.5 mm circle', () => {
    const flange = shape({ type: 'flangeWeldNeck', nps: 4, class: 150 });
    expect(validateShapeRecipe(flange.recipe)).toBeNull();
    expect(flange.stats.leaves).toBe(9);
    nearAll(flange.bounds.min, [-114.3, -114.3, -1.6], 1e-9);
    nearAll(flange.bounds.max, [114.3, 114.3, 22.4], 1e-9);
    expect(flange.ports.map((port) => port.endType)).toEqual(['FL', 'BW']);
    expect(flange.notes.some((note) => note.includes('hub not drawn'))).toBe(true);
    const built = mesh(flange.recipe);
    nearAll(built.min, flange.bounds.min, 0.2);
    nearAll(built.max, flange.bounds.max, 0.2);
    const plate = Math.PI * 114.3 ** 2 * 22.4 + Math.PI * 78.6 ** 2 * 1.6;
    const bores = Math.PI * 57.15 ** 2 * 24 + 8 * Math.PI * 9.525 ** 2 * 22.4;
    expect(Math.abs(built.volume / (plate - bores) - 1)).toBeLessThan(0.02);
  });

  it('builds a spiral-wound gasket annulus (inner ring ID 106.4, centering ring OD 174.8) and flags the assumed thickness', () => {
    const gasket = shape({ type: 'gasketSpiralWound', nps: 4, class: 150 });
    nearAll(gasket.bounds.max, [87.4, 87.4, 4.5], 1e-9);
    expect(gasket.notes[0]).toContain('ASSUMED');
    expect(gasket.ports.map((port) => port.endType)).toEqual(['FL', 'FL']);
  });

  it('draws the B16.10 gate valve as an envelope of face-to-face 229 by the flange OD', () => {
    const valve = shape({ type: 'valveGate', nps: 4, class: 150 });
    nearAll(valve.bounds.size, [228.6, 228.6, 229], 1e-9);
    expect(valve.notes[0]).toContain('envelope');
    expect(valve.ports.map((port) => port.direction)).toEqual([
      [0, 0, -1],
      [0, 0, 1],
    ]);
  });

  it('builds a pipe of the given length, hollow with the catalogue wall', () => {
    const pipe = shape({ type: 'pipe', nps: 6, schedule: '40', lengthMm: 1000 });
    nearAll(pipe.bounds.size, [168.3, 168.3, 1000], 1e-9);
    expect(pipe.hollow).toBe(true);
    const built = mesh(pipe.recipe);
    expect(Math.abs(built.volume / (Math.PI * (84.15 ** 2 - 77.04 ** 2) * 1000) - 1)).toBeLessThan(0.01);
  });

  it('builds an imported olet and a reducing tee from the spec (weldolet row from an olet schema catalogue)', () => {
    const olets = execute(specDoc, 'import_piping_catalog', {
      catalog: {
        format: 'llull-piping-catalog',
        schemaVersion: 1,
        id: 'olets',
        licence: 'open-data',
        families: [
          {
            id: 'mss-sp-97-weldolet',
            type: 'weldolet',
            standard: 'MSS SP-97',
            sizes: [{ nps: 6, smallNps: 2, centreToOutlet: 60, bodyOd: 70, branchBore: 40, provenance: { citation: 'test table' } }],
          },
          {
            id: 'asme-b16.9-rt',
            type: 'reducingTee',
            standard: 'ASME B16.9',
            sizes: [{ nps: 6, smallNps: 4, centreToEndRun: 143, centreToEndBranch: 137, provenance: { citation: 'test table' } }],
          },
        ],
      },
    });
    const withOlets = execute(olets.document, 'edit_pipe_spec', {
      specId: 'CS150-A1',
      ops: [{ op: 'setHeader', fields: { catalogs: ['llull-open-piping', 'olets'] } }],
    }).document;
    const olet = shape({ specId: 'CS150-A1', type: 'weldolet', nps: 6, branchNps: 2 }, withOlets);
    nearAll(olet.bounds.max, [35, 60, 35], 1e-9);
    expect(olet.ports[0]?.endType).toBe('BW');
    expect(olet.hollow).toBe(true);
    const reducing = shape({ specId: 'CS150-A1', type: 'reducingTee', nps: 6, branchNps: 4 }, withOlets);
    expect(reducing.ports[2]?.outsideDiameterMm).toBe(114.3);
    nearAll(reducing.ports[2]?.position ?? [], [0, 137, 0], 1e-12);
    expectRefusal(
      specDoc,
      'component_shape',
      { specId: 'CS150-A1', type: 'reducingTee', nps: 6, branchNps: 4 },
      'PSC_CATALOG_FAMILY_MISSING',
      'catalogs',
    );
  });
});

describe('component_shape, refusals', () => {
  it('refuses types without a recipe and eccentric reducers with PSC_SHAPE_UNSUPPORTED', () => {
    expectRefusal(doc, 'component_shape', { type: 'reducerEccentric', nps: 6 }, 'PSC_CATALOG_ROW_MISSING');
    expectRefusal(doc, 'component_shape', { type: 'boltSet', nps: 4 }, 'PSC_CATALOG_ROW_MISSING');
    expectRefusal(specDoc, 'component_shape', { specId: 'CS150-A1', type: 'boltSet', nps: 4 }, 'PSC_SHAPE_UNSUPPORTED');
    expectRefusal(doc, 'component_shape', { type: 'pipe', nps: 6, schedule: '40' }, 'PSC_SHAPE_UNSUPPORTED');
  });

  it('refuses unknown specs, components, catalogues, sizes and missing selectors', () => {
    expectRefusal(doc, 'component_shape', { specId: 'NOPE', type: 'elbow90', nps: 6 }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(specDoc, 'component_shape', { specId: 'CS150-A1', nps: 6 }, 'PSC_NO_COMPONENT', 'componentId');
    expectRefusal(specDoc, 'component_shape', { specId: 'CS150-A1', componentId: 'NOPE', nps: 6 }, 'PSC_NO_COMPONENT', 'componentId');
    expectRefusal(
      specDoc,
      'component_shape',
      { specId: 'CS150-A1', componentId: 'T-BW', type: 'elbow90', nps: 6 },
      'PSC_NO_COMPONENT',
      'type',
    );
    expectRefusal(specDoc, 'component_shape', { specId: 'CS150-A1', componentId: 'T-BW', nps: 1 }, 'PSC_SIZE_OUT_OF_RANGE', 'nps');
    expectRefusal(specDoc, 'component_shape', { specId: 'CS150-A1', componentId: 'T-BW', nps: 4.3 }, 'PSC_SIZE_UNKNOWN', 'nps');
    expectRefusal(doc, 'component_shape', { nps: 6 }, 'PSC_NO_COMPONENT', 'type');
    expectRefusal(doc, 'component_shape', { catalogId: 'nope', type: 'elbow90', nps: 6 }, 'PSC_CATALOG_UNKNOWN', 'catalogId');
    expectRefusal(doc, 'component_shape', { type: 'elbow90', nps: 99 }, 'PSC_SHAPE_UNSUPPORTED', 'type');
    expectRefusal(doc, 'component_shape', { type: 'tee', nps: 99 }, 'PSC_CATALOG_ROW_MISSING', 'type');
  });

  it('is read-only and pure', () => {
    expectPure(specDoc, () => execute(specDoc, 'component_shape', { specId: 'CS150-A1', type: 'elbow90', nps: 6 }));
    expect(execute(doc, 'component_shape', { type: 'elbow90', nps: 6, radius: 'LR' }).document).toBe(doc);
  });
});
