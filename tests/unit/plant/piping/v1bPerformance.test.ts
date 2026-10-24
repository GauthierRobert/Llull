/**
 * Performance budgets of 02 RTE V1 part 2 (§8): supports on 100 runs (placing, checking, moving the equipment they hang on), the PCF and IFC exports of
 * 100 lines. Budgets are generous bounds, not benchmarks; the measured times are in TECHNICAL_SPEC §13.10.
 */

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { cs150Document } from './rteFixtures';

const RUNS = 100;

/** `RUNS` parallel DN100 runs (y = 1500 i, x 0 -> 6000, z 3000), each over an IPE200 at x 3000 (axis z 2830). */
function runSet(): { doc: CadDocument; runIds: string[] } {
  let doc = cs150Document();
  const runIds: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const y = 1500 * i;
    doc = apply(doc, 'add_tie_in_point', { tag: `A${i}`, position: [0, y, 3000], direction: [1, 0, 0], dn: 100, endType: 'BW' });
    const a = doc.plant?.piping?.tieInOrder.at(-1) as string;
    doc = apply(doc, 'add_tie_in_point', { tag: `B${i}`, position: [6000, y, 3000], direction: [-1, 0, 0], dn: 100, endType: 'BW' });
    const b = doc.plant?.piping?.tieInOrder.at(-1) as string;
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: String(1000 + i), spec: 'CS150', dn: 100 });
    doc = apply(doc, 'route_pipe', { lineId: doc.plant?.piping?.lineOrder.at(-1), from: { portId: a }, to: { portId: b } });
    runIds.push(doc.plant?.piping?.runOrder.at(-1) as string);
    doc = apply(doc, 'add_steel_member', { role: 'beam', start: [3000, y - 700, 2830], end: [3000, y + 700, 2830], profile: 'IPE200' });
  }
  return { doc, runIds };
}

describe('V1 part 2 performance budgets', () => {
  const { doc, runIds } = runSet();

  const supported = (): CadDocument => {
    let next = doc;
    for (const runId of runIds) next = apply(next, 'add_pipe_support', { runId, spacing: 3000 });
    return next;
  };

  it(`placing a shoe on each of ${RUNS} runs (one add_pipe_support each, the building regenerated every time) stays within 60 s`, () => {
    const started = performance.now();
    const next = supported();
    const elapsed = performance.now() - started;
    expect(Object.values(next.building?.elements ?? {}).filter((element) => element.category === 'pipeSupport')).toHaveLength(RUNS);
    expect(elapsed).toBeLessThan(60_000);
  });

  it(`check_pipe_supports, building_schedule and check_steel_members on ${RUNS} supported runs stay within 20 s each`, () => {
    const next = supported();
    for (const [name, params] of [
      ['check_pipe_supports', {}],
      ['building_schedule', { kind: 'support' }],
      ['check_steel_members', {}],
    ] as const) {
      const started = performance.now();
      data(next, name, params);
      expect(performance.now() - started, name).toBeLessThan(20_000);
    }
  });

  it(`any plant command on a ${RUNS}-run document with ${RUNS} supports (set_heat_tracing: the supports of changed runs are re-checked) costs no more than 10 s`, () => {
    const next = supported();
    const started = performance.now();
    apply(next, 'set_heat_tracing', { lineId: next.plant?.piping?.lineOrder[0], type: 'electric', tracers: 1 });
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it(`delete_pipe_run on a supported run (its support is deleted with it) costs no more than 10 s on a ${RUNS}-run document`, () => {
    const next = supported();
    const started = performance.now();
    const deleted = apply(next, 'delete_pipe_run', { runId: runIds[0] });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(Object.values(deleted.building?.elements ?? {}).filter((element) => element.category === 'pipeSupport')).toHaveLength(RUNS - 1);
  });

  it(`export_pcf and export_ifc of ${RUNS} lines stay within 20 s each`, () => {
    for (const name of ['export_pcf', 'export_ifc']) {
      const started = performance.now();
      const result = data<{ files?: unknown[]; ifc?: string }>(doc, name, {});
      expect(performance.now() - started, name).toBeLessThan(20_000);
      expect(result.files?.length ?? result.ifc?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
