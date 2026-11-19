/**
 * PERF1 §5 row 4: `compute_view_factors integration='reciprocal'` (one integral per unordered facet pair, one panel for well-separated
 * facets) against the default `full` rule, the closed forms and a meshed cube enclosure; the option reaches the engine and the result
 * records it.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { type GeometryQueryEngine, type ViewFactorExchangeOptions, meshBvhEngine } from '@core/geometry/geometryQueries';
import { createEmptyDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { viewFactorParallel, viewFactorPerpendicular } from '@cae/thermal/thermalClosedForms';
import { type Facet, exchangeArea, makeFacet, reciprocalExchangeArea } from '@cae/thermal/viewFactorContour';
import { viewFactorExchangeReference } from '@cae/thermal/viewFactorExchange';

const doc = createEmptyDocument();

interface Data {
  matrix: number[][];
  rowSums: number[];
  integration: string;
  method: string;
  reciprocityMaxError: number;
}

type V3 = [number, number, number];
const square = (name: string, vertices: V3[]): { name: string; vertices: V3[] } => ({ name, vertices });
const floor = square('floor', [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
]);
const ceiling = (height: number): { name: string; vertices: V3[] } =>
  square('ceiling', [
    [0, 0, height],
    [0, 1, height],
    [1, 1, height],
    [1, 0, height],
  ]);
const wall = square('wall', [
  [0, 0, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 0, 0],
]);

const run = (params: Record<string, unknown>, engine: GeometryQueryEngine | null = null): { summary: string; data: Data } => {
  const result = execute(doc, 'compute_view_factors', { lengthUnit: 'm', ...params }, { ...defaultContext(), geometryQueries: engine });
  expect(result.rejected, result.summary).toBeUndefined();
  return { summary: result.summary, data: result.data as Data };
};

const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

describe('compute_view_factors integration', () => {
  it('reciprocal: plates 2 apart (every facet pair one panel) give the closed form and full within 1e-12, and say so', () => {
    const params = { surfaces: [floor, ceiling(2)], maxFacetSize: { value: 0.5, unit: 'm' } };
    const full = run(params);
    const reciprocal = run({ ...params, integration: 'reciprocal' });
    const value = reciprocal.data.matrix[0]?.[1] ?? 0;
    expect(relative(value, viewFactorParallel(1, 1, 2))).toBeLessThan(1e-12);
    expect(relative(value, full.data.matrix[0]?.[1] ?? 0)).toBeLessThan(1e-12);
    expect(value).not.toBe(full.data.matrix[0]?.[1]);
    expect(reciprocal.data.matrix[1]?.[0]).toBe(value);
    expect(reciprocal.data.reciprocityMaxError).toBe(0);
    expect(reciprocal.data.integration).toBe('reciprocal');
    expect(reciprocal.data.method).toContain('reciprocal: one integral per unordered facet pair');
    expect(reciprocal.summary).toContain('integration reciprocal');
    expect(full.data.integration).toBe('full');
    expect(full.data.method).not.toContain('reciprocal');
    expect(full.summary).not.toContain('reciprocal');
    expect(run({ ...params, integration: 'full' }).data).toEqual(full.data);
  });

  it('reciprocal: perpendicular plates with a common edge (adaptive pairs) match full and the closed form, also obstructed', () => {
    const params = { surfaces: [floor, wall], maxFacetSize: { value: 0.5, unit: 'm' } };
    const full = run(params);
    const reciprocal = run({ ...params, integration: 'reciprocal' });
    expect(relative(reciprocal.data.matrix[0]?.[1] ?? 0, full.data.matrix[0]?.[1] ?? 0)).toBeLessThan(1e-12);
    expect(relative(reciprocal.data.matrix[0]?.[1] ?? 0, viewFactorPerpendicular(1, 1, 1))).toBeLessThan(1e-9);
    const blocker = {
      vertices: [
        [0.1, 0.2, 0.05],
        [0.9, 0.2, 0.05],
        [0.9, 0.3, 0.6],
        [0.1, 0.3, 0.6],
      ] as V3[],
    };
    const shadowed = { ...params, obstruction: true, blockers: [blocker] };
    const fullShadowed = run(shadowed).data.matrix;
    const reciprocalShadowed = run({ ...shadowed, integration: 'reciprocal' }).data.matrix;
    expect(fullShadowed[0]?.[1]).toBeLessThan(full.data.matrix[0]?.[1] ?? 0);
    for (const [i, j] of [
      [0, 1],
      [1, 0],
    ] as const)
      expect(relative(reciprocalShadowed[i]?.[j] ?? 0, fullShadowed[i]?.[j] ?? 0)).toBeLessThan(1e-12);
  });

  it('refuses an unknown integration through the schema', () => {
    const result = execute(doc, 'compute_view_factors', { lengthUnit: 'm', surfaces: [floor, ceiling(1)], integration: 'fast' });
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/compute_view_factors rejected: invalid params — integration/);
  });

  it('hands the integration to the engine and uses its answer; a null answer runs the TS reference of that integration', () => {
    const seen: (ViewFactorExchangeOptions | undefined)[] = [];
    const answering = (matrix: number[][] | null): GeometryQueryEngine => ({
      ...meshBvhEngine,
      viewFactorExchange: (_surfaces, _blockers, options) => {
        seen.push(options);
        return matrix;
      },
    });
    const params = { surfaces: [floor, ceiling(2)], maxFacetSize: { value: 0.5, unit: 'm' }, integration: 'reciprocal' };
    const stub = run(
      params,
      answering([
        [0, 0.5],
        [0.5, 0],
      ]),
    );
    expect(stub.data.matrix).toEqual([
      [0, 0.5],
      [0.5, 0],
    ]);
    expect(run(params, answering(null)).data).toEqual(run(params).data);
    run({ ...params, integration: undefined }, answering(null));
    expect(seen).toEqual([{ integration: 'reciprocal' }, { integration: 'reciprocal' }, { integration: 'full' }]);
  });
});

/** The walls of the box [0, size]^3 seen from inside (surface = wall, area `areas[k]`), square cells of side `cell`, two facets each. */
function box(size: V3, cell: number): { walls: Facet[][]; areas: number[] } {
  const walls: Facet[][] = [];
  const areas: number[] = [];
  for (let axis = 0; axis < 3; axis += 1)
    for (const high of [false, true]) {
      const [uAxis, vAxis] = [(axis + 1) % 3, (axis + 2) % 3];
      const at = (u: number, v: number): Vec3 => {
        const p: V3 = [0, 0, 0];
        p[axis] = high ? (size[axis] ?? 0) : 0;
        p[uAxis] = u * cell;
        p[vAxis] = v * cell;
        return p;
      };
      const [width, height] = [size[uAxis] ?? 0, size[vAxis] ?? 0];
      const [nu, nv] = [Math.round(width / cell), Math.round(height / cell)];
      const facets: Facet[] = [];
      for (let i = 0; i < nu; i += 1)
        for (let j = 0; j < nv; j += 1) {
          const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
          facets.push(...(high ? [makeFacet(a, c, b), makeFacet(a, d, c)] : [makeFacet(a, b, c), makeFacet(a, c, d)]));
        }
      walls.push(facets);
      areas.push(width * height);
    }
  return { walls, areas };
}

describe('reciprocal integration on a meshed enclosure', () => {
  it('facets that do not face each other exchange nothing; reciprocalExchangeArea is the same integral as exchangeArea far apart', () => {
    const up = makeFacet([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const down = makeFacet([0, 0, 3], [0, 1, 3], [1, 0, 3]);
    expect(exchangeArea(up, makeFacet([0, 0, 3], [1, 0, 3], [0, 1, 3]))).toBe(0);
    expect(relative(reciprocalExchangeArea(up, down), exchangeArea(up, down))).toBeLessThan(1e-12);
  });

  it('a 1 x 1 x 4 box of 144 facets: entries within 1e-12 of full, row sums within 2e-13, rows of F sum to 1; with a baffle too', () => {
    const { walls, areas } = box([1, 1, 4], 0.5);
    expect(walls.flat()).toHaveLength(144);
    const baffle = [makeFacet([0.3, 0.3, 2], [0.7, 0.3, 2], [0.7, 0.7, 2]), makeFacet([0.3, 0.3, 2], [0.7, 0.7, 2], [0.3, 0.7, 2])];
    for (const blockers of [null, baffle]) {
      const full = viewFactorExchangeReference(meshBvhEngine, walls, blockers);
      const reciprocal = viewFactorExchangeReference(meshBvhEngine, walls, blockers, { integration: 'reciprocal' });
      expect(reciprocal).not.toEqual(full);
      for (let i = 0; i < 6; i += 1) {
        const [fullRow, row] = [full[i] ?? [], reciprocal[i] ?? []];
        for (let j = 0; j < 6; j += 1) {
          if (i === j) expect(row[j]).toBe(0);
          else expect(relative(row[j] ?? 0, fullRow[j] ?? 0)).toBeLessThan(1e-12);
          if (blockers === null) expect(row[j]).toBe(reciprocal[j]?.[i]);
        }
        const [sum, fullSum] = [row.reduce((a, b) => a + b, 0), fullRow.reduce((a, b) => a + b, 0)];
        expect(relative(sum, fullSum)).toBeLessThan(2e-13);
        if (blockers === null) expect(Math.abs(sum / (areas[i] ?? 1) - 1)).toBeLessThan(1e-9);
      }
    }
  });
});
