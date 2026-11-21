/**
 * PERF1 gate, radiation view factors: `compute_view_factors integration='reciprocal'` on a 3 072-facet cube cavity through the native
 * engine (budgets.ts `thermal.*`; the default `full` rule of the same case is measured, not gated: PERF1 §5 row 4); skipped without
 * llull-compute.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { createNativeGeometryQueryEngine } from '../../src/native/geometryQueryEngine';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { requireTool } from '../../../tests/requireTool';
import { expectWithinBudget, reportMeasurements } from './harness';

afterAll(() => console.warn(reportMeasurements()));

type V3 = [number, number, number];
const BINARY = nativeBinaryPath('llull-compute');

/** The six inward-facing walls of the unit cube; maxFacetSize 0.1 m splits each into 512 facets. */
const walls: { name: string; vertices: V3[] }[] = [
  ['z0', [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
  ['z1', [0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]],
  ['x0', [0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
  ['x1', [1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
  ['y0', [0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]],
  ['y1', [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
].map(([name, ...vertices]) => ({ name: name as string, vertices: vertices as V3[] }));

const baffle: V3[] = [
  [0.3, 0.3, 0.5],
  [0.7, 0.3, 0.5],
  [0.7, 0.7, 0.5],
  [0.3, 0.7, 0.5],
];

describe.skipIf(requireTool('native:llull-compute', BINARY !== null))('radiation view factor budgets (PERF1)', () => {
  const context = { ...defaultContext(), geometryQueries: BINARY === null ? null : createNativeGeometryQueryEngine(BINARY) };
  const timed = (extra: Record<string, unknown>): number => {
    const params = {
      lengthUnit: 'm',
      surfaces: walls,
      maxFacetSize: { value: 0.1, unit: 'm' },
      closed: true,
      integration: 'reciprocal',
      ...extra,
    };
    const started = performance.now();
    const result = execute(createEmptyDocument(), 'compute_view_factors', params, context);
    const elapsed = performance.now() - started;
    // a failed native run is refused above the TypeScript limit (THM_FACET_LIMIT), so this summary means the native engine answered
    expect(result.summary).toContain('6 surfaces, 3072 facets');
    expect(result.summary).toContain('integration reciprocal');
    return elapsed;
  };

  it('thermal.viewfactor.reciprocal3k: a closed 3 072-facet cube cavity', () => {
    expectWithinBudget('thermal.viewfactor.reciprocal3k', timed({}));
  });

  it('thermal.viewfactor.reciprocal3k_obstructed: the same cavity with obstruction and a baffle', () => {
    expectWithinBudget('thermal.viewfactor.reciprocal3k_obstructed', timed({ obstruction: true, blockers: [{ vertices: baffle }] }));
  });
});
