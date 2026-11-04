/**
 * Plant 02 RTE CAT-FU: supports on a spec-driven run in a document whose unit is not mm. A run is stored in millimetres; the carrier lookup gives the pipe
 * in document units like a building pipe, so the same scene in mm and in m (or ft) gives the same supports. Scene of runSupports.test.ts: DN80 CS150 hot line at
 * z 3000 from x 0 to 6000, IPE200 beams under it at x 500, 3000 and 5500 (axis z 2830).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { fromMm } from '@core/model/units';
import type { CadDocument } from '@core/model/types';
import type { PipeSupportElement } from '@aec/building/types';
import { runCarrierPipe } from '@aec/plant/piping/runCarrier';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document } from './rteFixtures';

const HOT = { service: 'HO', sequence: '4001', spec: 'CS150', dn: 80, designTempC: 180, insulation: { code: 'H', thickness: 'fromSpec' } };

/** The hot run in `units` (routed in mm, then the document unit is changed: the run stays in mm) with the three beams placed in those units. */
function scene(units: 'mm' | 'm' | 'ft'): { doc: CadDocument; runId: string } {
  const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', HOT);
  const lineId = created.affected[0] as string;
  let doc = apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  const runId = doc.plant?.piping?.runOrder[0] as string;
  if (units !== 'mm') doc = apply(doc, 'set_units', { units });
  const convert = (mm: number): number => fromMm(doc, mm);
  for (const x of [500, 3000, 5500])
    doc = apply(doc, 'add_steel_member', {
      role: 'beam',
      start: [convert(x), convert(-1000), convert(2830)],
      end: [convert(x), convert(1000), convert(2830)],
      profile: 'IPE200',
    });
  return { doc, runId };
}
const supportsOf = (doc: CadDocument): PipeSupportElement[] =>
  Object.values(doc.building?.elements ?? {}).filter((element): element is PipeSupportElement => element.category === 'pipeSupport');

describe('add_pipe_support on a run in a document in m / ft', () => {
  it.each([
    ['m', 0.001],
    ['ft', 0.3048 / 1000],
  ] as const)('%s: the carrier pipe is in document units (6 m long, OD 88.9 mm)', (units, perMm) => {
    const { doc, runId } = scene(units);
    const pipe = runCarrierPipe(doc, runId);
    expect(pipe?.points.at(0)?.[0]).toBeCloseTo(0, 9);
    expect(pipe?.points.at(-1)?.[0]).toBeCloseTo(6000 * (units === 'm' ? 0.001 : 1 / 304.8), 6);
    expect(pipe?.diameter).toBeCloseTo(88.9 * (units === 'm' ? 0.001 : 1 / 304.8), 9);
    expect(perMm).toBeGreaterThan(0);
  });

  it('m: spacing 3 puts one support on each beam (x 0.5, 3, 5.5), attached, the pedestal 25.55 mm; the mm document gives the same', () => {
    const inMetres = scene('m');
    const result = ok(inMetres.doc, 'add_pipe_support', { runId: inMetres.runId, spacing: 3 });
    const placed = supportsOf(result.document);
    expect(placed.map((support) => support.position[0]).sort((x, y) => x - y)).toEqual([0.5, 3, 5.5]);
    expect(placed.every((support) => support.memberId !== null)).toBe(true);
    placed.forEach((support) => expect(support.pedestalHeight).toBeCloseTo(0.02555, 3));
    const inMillimetres = scene('mm');
    const reference = supportsOf(ok(inMillimetres.doc, 'add_pipe_support', { runId: inMillimetres.runId, spacing: 3000 }).document);
    expect(reference.map((support) => support.position[0]).sort((x, y) => x - y)).toEqual([500, 3000, 5500]);
  });

  it('m: a point near the run is accepted (3 m along, on the centreline) and a point 5 m off is refused; check_pipe_supports reads the run in metres', () => {
    const { doc, runId } = scene('m');
    const placed = ok(doc, 'add_pipe_support', { runId, at: [[3, 0, 3]] });
    expect(supportsOf(placed.document)[0]?.position[0]).toBe(3);
    const far = execute(doc, 'add_pipe_support', { runId, at: [[3, 5, 3]] });
    expect(far.document).toBe(doc);
    expect(far.summary).toContain('no support could be placed');
    const full = ok(doc, 'add_pipe_support', { runId, spacing: 3 }).document;
    const row = data<{ pipes: Array<{ id: string; supports: number; largestSpanM: number; unattached: number }> }>(
      full,
      'check_pipe_supports',
      {},
    ).pipes.find((pipe) => pipe.id === runId);
    expect(row).toMatchObject({ supports: 3, unattached: 0 });
    expect(row?.largestSpanM).toBeCloseTo(2.5, 6);
    expectPure(doc, () => execute(doc, 'add_pipe_support', { runId, spacing: 3 }));
  });
});
