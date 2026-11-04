/**
 * Plant 01 PSC CAT-FU: `component_shape` of caps, couplings, unions, swages and eccentric reducers. The rows are DECLARED TEST INPUTS (round numbers, labelled
 * as such in their provenance, never a standard's values): the bundled catalogue has no sourced row for these types, so a bundled lookup is a refusal.
 * Expected numbers are hand calculations: an oblique frustum has the volume of the right frustum, pi L (R^2 + R r + r^2) / 3.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshData, type ShapeRecipe } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { buildShape } from '@aec/plant/catalog/shapes/build';
import type { ShapeSource } from '@aec/plant/catalog/shapes/shared';
import type { ComponentType } from '@aec/plant/catalog/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const cite = { citation: 'declared test input, not from a standard (CAT-FU fitting shapes)' };
const family = (id: string, type: string, sizes: Array<Record<string, unknown>>): Record<string, unknown> => ({
  id,
  type,
  standard: 'company test table',
  unit: 'mm',
  sizes: sizes.map((size) => ({ ...size, provenance: cite })),
});
const catalog = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'test-fittings',
  licence: 'company-proprietary',
  families: [
    family('cap', 'cap', [{ nps: 4, outsideDiameter: 114.3, length: 60 }]),
    family('coupling', 'coupling', [{ nps: 1, class: 3000, length: 40, bodyOd: 50, socketDepth: 13 }]),
    family('union', 'union', [{ nps: 1, class: 3000, length: 70, bodyOd: 60, threadLength: 15 }]),
    family('union-bare', 'union', [{ nps: 2, length: 70, bodyOd: 80 }]),
    family('coupling-no-body', 'coupling', [{ nps: 3, length: 70 }]),
    family('swage', 'swage', [{ nps: 4, smallNps: 2, length: 100, outsideDiameter: 114.3, smallOutsideDiameter: 60.3 }]),
    family('ecc', 'reducerEccentric', [{ nps: 4, smallNps: 2, length: 100, outsideDiameter: 114.3, smallOutsideDiameter: 60.3 }]),
  ],
};
const doc: CadDocument = apply(createEmptyDocument(), 'import_piping_catalog', { catalog });

interface Shape {
  recipe: ShapeRecipe;
  bounds: { min: number[]; max: number[]; size: number[] };
  ports: Array<{ id: string; position: number[]; direction: number[]; outsideDiameterMm: number; endType: string | null }>;
  hollow: boolean;
  notes: string[];
}
const shape = (params: Record<string, unknown>): Shape => data<Shape>(doc, 'component_shape', { catalogId: 'test-fittings', ...params });

let previous: GeometryKernel | null = null;
let kernel: GeometryKernel;
beforeAll(async () => {
  previous = getGeometryKernel();
  kernel = await createManifoldKernel();
  setGeometryKernel(kernel);
}, 60_000);
afterAll(() => setGeometryKernel(previous));

/** Revolved solids are 48-gons: the volume is within 0.5 % of the analytic one. */
const POLYGON = 0.005;
const relative = (actual: number, exact: number): number => Math.abs(actual - exact) / exact;

function volumeOf(recipe: ShapeRecipe): number {
  const handle = kernel.evaluate(recipe);
  expect(handle, 'the kernel builds the recipe').not.toBeNull();
  const mesh = kernel.tessellate(handle as never) as MeshData;
  let volume = 0;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const p = (k: number): number[] => [0, 1, 2].map((axis) => mesh.positions[(mesh.indices[at + k] as number) * 3 + axis] as number);
    const [a, b, c] = [p(0), p(1), p(2)] as [number[], number[], number[]];
    volume +=
      (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return Math.abs(volume);
}

describe('component_shape: cap', () => {
  it('is a closed-end cylinder of the row length (one open port at z = 0), drawn solid without a wall', () => {
    const cap = shape({ type: 'cap', nps: 4 });
    expect(cap.bounds.size).toEqual([114.3, 114.3, 60]);
    expect(cap.ports).toHaveLength(1);
    expect(cap.ports[0]).toMatchObject({ id: 'A', position: [0, 0, 0], direction: [0, 0, -1], outsideDiameterMm: 114.3, endType: 'BW' });
    expect(cap.hollow).toBe(false);
    expect(cap.notes.join(' ')).toContain('closed end drawn flat');
    expect(relative(volumeOf(cap.recipe), Math.PI * 57.15 ** 2 * 60)).toBeLessThan(POLYGON);
  });

  it('with a wall is a cup: volume = pi (R^2 L - r^2 (L - t)), the end wall equal to the pipe wall', () => {
    const cup = shape({ type: 'cap', nps: 4, wallMm: 6 });
    expect(cup.hollow).toBe(true);
    const [outer, inner] = [57.15, 51.15];
    expect(relative(volumeOf(cup.recipe), Math.PI * (outer ** 2 * 60 - inner ** 2 * (60 - 6)))).toBeLessThan(POLYGON);
  });
});

describe('component_shape: coupling and union', () => {
  it('a coupling is a solid body bodyOd x length with two SW ports (socketDepth in the row)', () => {
    const coupling = shape({ type: 'coupling', nps: 1, class: 3000 });
    expect(coupling.bounds.size).toEqual([50, 50, 40]);
    expect(coupling.ports.map((port) => [port.id, port.endType, port.direction[2]])).toEqual([
      ['A', 'SW', -1],
      ['B', 'SW', 1],
    ]);
    expect(coupling.notes.join(' ')).toContain('socket bore is not modelled');
    expect(relative(volumeOf(coupling.recipe), Math.PI * 25 ** 2 * 40)).toBeLessThan(POLYGON);
  });

  it('a union with a thread length is THD; without socketDepth / threadLength the end type is unknown (null)', () => {
    expect(shape({ type: 'union', nps: 1, class: 3000 }).ports.map((port) => port.endType)).toEqual(['THD', 'THD']);
    const bare = shape({ type: 'union', nps: 2 });
    expect(bare.ports.map((port) => port.endType)).toEqual([null, null]);
  });

  it('refuses a row without bodyOd (the body is larger than the pipe: never drawn at the pipe diameter) or without length', () => {
    expectRefusal(doc, 'component_shape', { catalogId: 'test-fittings', type: 'coupling', nps: 3 }, 'PSC_CATALOG_ROW_MISSING');
    const bare: ShapeSource = { type: 'coupling', standard: 'x', npsValue: 1, dims: { length: 40 } };
    const outcome = buildShape(bare);
    expect(outcome.ok).toBe(false);
    expect(buildShape({ ...bare, dims: { bodyOd: 50 } }).ok).toBe(false);
  });
});

describe('component_shape: swage and eccentric reducer', () => {
  it('a swage is a concentric frustum with unknown end types: volume pi L (R^2 + R r + r^2) / 3', () => {
    const swage = shape({ type: 'swage', nps: 4, branchNps: 2 });
    expect(swage.ports.map((port) => port.endType)).toEqual([null, null]);
    expect(swage.notes.join(' ')).toContain('swage drawn as a concentric reducer');
    const [big, small] = [57.15, 30.15];
    expect(relative(volumeOf(swage.recipe), (Math.PI * 100 * (big ** 2 + big * small + small ** 2)) / 3)).toBeLessThan(POLYGON);
  });

  it('an eccentric reducer: small end axis shifted (D - d) / 2 = 27 toward +X, flat side +X, bounds exact, volume of the oblique frustum', () => {
    const ecc = shape({ type: 'reducerEccentric', nps: 4, branchNps: 2 });
    expect(ecc.ports.map((port) => port.position)).toEqual([
      [0, 0, 0],
      [27, 0, 100],
    ]);
    expect(ecc.bounds.min).toEqual([-57.15, -57.15, 0]);
    expect(ecc.bounds.max[0]).toBeCloseTo(57.15, 9);
    expect(ecc.bounds.max[1]).toBeCloseTo(57.15, 9);
    expect(ecc.bounds.max[2]).toBe(100);
    const [big, small] = [57.15, 30.15];
    const exact = (Math.PI * 100 * (big ** 2 + big * small + small ** 2)) / 3;
    const volume = volumeOf(ecc.recipe);
    expect(Math.abs(volume - exact) / exact).toBeLessThan(0.02);
    expect(volume).toBeLessThan(exact);
    expect(ecc.notes.join(' ')).toContain('27.000 mm toward +X');
  });

  it('a hollow eccentric reducer subtracts the bore loft (wall 5: volume between the solid and the exact shell)', () => {
    const ecc = shape({ type: 'reducerEccentric', nps: 4, branchNps: 2, wallMm: 5 });
    expect(ecc.hollow).toBe(true);
    const solid = volumeOf(shape({ type: 'reducerEccentric', nps: 4, branchNps: 2 }).recipe);
    const shell = volumeOf(ecc.recipe);
    const [big, small] = [52.15, 25.15];
    const bore = (Math.PI * 100 * (big ** 2 + big * small + small ** 2)) / 3;
    expect(Math.abs(shell - (solid - bore)) / (solid - bore)).toBeLessThan(0.05);
    expect(shell).toBeLessThan(solid / 2);
  });

  it('refuses an eccentric reducer without the small end, with equal ends, or without a length; the swage needs the same', () => {
    const base: ShapeSource = { type: 'reducerEccentric', standard: 'x', npsValue: 4, dims: { length: 100 }, pipeOdMm: 114.3 };
    expect(buildShape(base).ok).toBe(false);
    expect(buildShape({ ...base, smallPipeOdMm: 114.3 }).ok).toBe(false);
    expect(buildShape({ ...base, smallPipeOdMm: 60.3, dims: {} }).ok).toBe(false);
    expect(buildShape({ ...base, smallPipeOdMm: 60.3 }).ok).toBe(true);
    expect(buildShape({ ...base, type: 'swage', smallPipeOdMm: undefined }).ok).toBe(false);
  });

  it('the bundled catalogue has no sourced row for these types: a lookup is a refusal, never an invented shape; the command is pure', () => {
    const empty = createEmptyDocument();
    for (const type of ['cap', 'coupling', 'union', 'swage', 'reducerEccentric'] as ComponentType[])
      expectRefusal(empty, 'component_shape', { type, nps: 4, branchNps: 2 }, 'PSC_CATALOG_ROW_MISSING');
    expectPure(doc, () => shape({ type: 'cap', nps: 4 }));
  });
});
