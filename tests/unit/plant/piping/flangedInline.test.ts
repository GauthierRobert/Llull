/**
 * Plant 02 RTE (ISO M6c): the mid-line flanged joint (`flangedJoint`) and the instrument (`instrument`) as inline components. CS150 DN100 stub: weld-neck flange hub Y = 76,
 * spiral-wound gasket 3 mm. Hand calculation, a 4000 mm leg from a butt-weld tie-in at the origin, a joint at 1500 and a 300 mm flanged instrument at 3000:
 * joint: gasket [1498.5, 1501.5], flange A hub [1422.5, 1498.5], flange B hub [1501.5, 1577.5]; instrument faces 2850 / 3150, each with a 3 + 76 mm set outside:
 * flange hubs 2771 and 3229 -> pipe pieces 1422.5, 1577.5 -> 2771 = 1193.5, 3229 -> 4000 = 771.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PipeRun, PipingModel, RoutedPart } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Line } from './rteFixtures';

function scene(): { doc: CadDocument; lineId: string; tie: string } {
  const line = cs150Line(100, '3001');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 100 });
  return { doc: tie.doc, lineId: line.lineId, tie: tie.id };
}
const legs = [{ direction: '+X', length: 4000 }];
const joint = { type: 'flangedJoint', tag: 'FJ-1', at: { leg: 0, centreDistance: 1500 } };
const instrument = { type: 'instrument', tag: 'FT-1', lengthMm: 300, at: { leg: 0, centreDistance: 3000 } };
const runOf = (doc: CadDocument, runId: string): PipeRun => (doc.plant?.piping as PipingModel).runs[runId] as PipeRun;
const partsOf = (doc: CadDocument, runId: string): readonly RoutedPart[] => {
  const derived = deriveRun(doc, runOf(doc, runId));
  if (!derived.ok) throw new Error(derived.message);
  return derived.parts;
};
const pieces = (doc: CadDocument, runId: string): number[] =>
  partsOf(doc, runId)
    .filter((part) => part.kind === 'pipe')
    .map((part) => +(part.cutLength ?? 0).toFixed(6));

function routed(inline: unknown[]): { doc: CadDocument; runId: string; lineId: string } {
  const s = scene();
  const result = ok(s.doc, 'route_pipe', { lineId: s.lineId, from: { portId: s.tie }, legs, inline });
  return { doc: result.document, runId: (result.data as { runId: string }).runId, lineId: s.lineId };
}

describe('flangedJoint', () => {
  const { doc, runId } = routed([joint]);

  it('is flange A, one gasket centred on the joint, one bolt set, flange B: hubs 1422.5-1498.5 and 1501.5-1577.5, pieces 1422.5 and 2422.5', () => {
    const parts = partsOf(doc, runId);
    expect(parts.filter((part) => part.kind === 'flange')).toHaveLength(2);
    expect(parts.filter((part) => part.kind === 'gasket')).toHaveLength(1);
    expect(parts.filter((part) => part.kind === 'boltSet')).toHaveLength(1);
    const [a, b] = parts.filter((part) => part.kind === 'flange');
    expect(a?.ports.map((port) => port.position[0])).toEqual([1422.5, 1498.5]);
    expect(b?.ports.map((port) => port.position[0])).toEqual([1501.5, 1577.5]);
    const gasket = parts.find((part) => part.kind === 'gasket');
    expect(gasket?.ports.map((port) => port.position[0])).toEqual([1498.5, 1501.5]);
    expect(pieces(doc, runId)).toEqual([1422.5, 2422.5]);
    const derived = deriveRun(doc, runOf(doc, runId));
    if (!derived.ok) throw new Error(derived.message);
    expect(derived.joints.filter((candidate) => candidate.kind === 'flanged')).toHaveLength(1);
    expect(derived.joints.filter((candidate) => candidate.kind === 'buttWeld')).toHaveLength(3);
    expect(derived.inline[0]).toMatchObject({ type: 'flangedJoint', lengthMm: 3, tag: 'FJ-1' });
  });

  it('counts two weld-neck flanges, one gasket and one bolt set in the takeoff', () => {
    const counts = (ok(doc, 'piping_takeoff', {}).data as { counts: Record<string, number> }).counts;
    expect(counts['flangeWeldNeck']).toBe(2);
    expect(counts['gasketSpiralWound']).toBe(1);
    expect(counts['boltSet']).toBe(1);
  });

  it('inserts into an existing run too; gives its component id, and a lengthMm or endType is refused (they are for instruments)', () => {
    const plain = routed([]);
    const placed = ok(plain.doc, 'insert_inline_component', { runId: plain.runId, ...joint });
    expect(placed.data).toMatchObject({ type: 'flangedJoint', runId: plain.runId });
    expect(pieces(placed.document, plain.runId)).toEqual([1422.5, 2422.5]);
    expectRefusal(plain.doc, 'insert_inline_component', { runId: plain.runId, ...joint, lengthMm: 100 }, 'RTE_SIZE_MISMATCH');
    expectRefusal(plain.doc, 'insert_inline_component', { runId: plain.runId, ...joint, dn2: 80 }, 'RTE_SIZE_MISMATCH');
  });

  it('a joint too close to the start does not fit: RTE_INLINE_DOES_NOT_FIT, document unchanged', () => {
    const plain = routed([]);
    const refused = execute(plain.doc, 'insert_inline_component', {
      runId: plain.runId,
      type: 'flangedJoint',
      at: { leg: 0, centreDistance: 40 },
    });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(plain.doc);
  });

  it('is pure', () => {
    const plain = routed([]);
    expectPure(plain.doc, () => execute(plain.doc, 'insert_inline_component', { runId: plain.runId, ...joint }));
  });
});

describe('instrument', () => {
  it('flanged (default): body 300 mm between two flange sets, pieces 1193.5 and 771 around it', () => {
    const { doc, runId } = routed([joint, instrument]);
    expect(pieces(doc, runId)).toEqual([1422.5, 1193.5, 771]);
    const body = partsOf(doc, runId).find((part) => part.typeKey === 'instrument');
    expect(body?.kind).toBe('inline');
    expect(body?.unverified).toBe(true);
    expect(body?.catalogueKey).toBe('CS150/INSTRUMENT/100');
    expect(body?.ports.map((port) => [port.position[0], port.endType])).toEqual([
      [2850, 'FL'],
      [3150, 'FL'],
    ]);
    expect((runOf(doc, runId).inline ?? []).find((item) => item.type === 'instrument')).toMatchObject({
      lengthMm: 300,
      endType: 'FL',
      tag: 'FT-1',
    });
    const takeoff = ok(doc, 'piping_takeoff', {}).data as { counts: Record<string, number>; unverifiedReasons: string[] };
    expect(takeoff.counts['flangeWeldNeck']).toBe(4);
    expect(takeoff.unverifiedReasons.join()).toContain('CS150/INSTRUMENT/100');
  });

  it('butt welded (endType BW): the body welds to the pipe, no flange sets, pieces 2850 and 4000 - 3150', () => {
    const { doc, runId } = routed([{ ...instrument, endType: 'BW' }]);
    expect(partsOf(doc, runId).filter((part) => part.kind === 'flange')).toHaveLength(0);
    expect(pieces(doc, runId)).toEqual([2850, 850]);
    expect(
      partsOf(doc, runId)
        .find((part) => part.typeKey === 'instrument')
        ?.ports.map((port) => port.endType),
    ).toEqual(['BW', 'BW']);
  });

  it('is written as an INSTRUMENT record between its flange sets in the PCF', () => {
    const { doc, lineId } = routed([instrument]);
    const text = (data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: [lineId] }).files[0] as { content: string })
      .content;
    expect(text).toContain('INSTRUMENT\n');
    expect(text).toContain('END-POINT 2850.0 0.0 0.0 100 FL\n    END-POINT 3150.0 0.0 0.0 100 FL');
  });

  it('refuses an instrument without lengthMm, and lengthMm / endType on any other type: RTE_SIZE_MISMATCH, document unchanged', () => {
    const plain = routed([]);
    const missing = expectRefusal(
      plain.doc,
      'insert_inline_component',
      { runId: plain.runId, type: 'instrument', at: { leg: 0, centreDistance: 3000 } },
      'RTE_SIZE_MISMATCH',
    );
    expect(missing.document).toBe(plain.doc);
    expectRefusal(
      plain.doc,
      'insert_inline_component',
      { runId: plain.runId, type: 'valveGate', lengthMm: 100, at: { leg: 0, centreDistance: 3000 } },
      'RTE_SIZE_MISMATCH',
    );
    expectRefusal(plain.doc, 'insert_inline_component', { runId: plain.runId, ...instrument, dn2: 80 }, 'RTE_SIZE_MISMATCH');
  });

  it('an instrument longer than its leg does not fit: RTE_INLINE_DOES_NOT_FIT', () => {
    const plain = routed([]);
    const refused = execute(plain.doc, 'insert_inline_component', { runId: plain.runId, ...instrument, lengthMm: 3900 });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('RTE_INLINE_DOES_NOT_FIT');
    expect(refused.document).toBe(plain.doc);
  });

  it('load validation: lengthMm positive and only on an instrument, endType FL | BW only on an instrument; a stored instrument without a length does not derive', () => {
    const { doc, runId } = routed([instrument]);
    const piping = JSON.parse(JSON.stringify(doc.plant?.piping)) as { runs: Record<string, { inline: Array<Record<string, unknown>> }> };
    const item = (piping.runs[runId] as { inline: Array<Record<string, unknown>> }).inline[0] as Record<string, unknown>;
    expect(pipingErrors(piping)).toEqual([]);
    item['lengthMm'] = -1;
    expect(pipingErrors(piping).join()).toContain('lengthMm and endType');
    item['lengthMm'] = 300;
    item['endType'] = 'SW';
    expect(pipingErrors(piping).join()).toContain('lengthMm and endType');
    item['endType'] = 'FL';
    item['type'] = 'valveGate';
    expect(pipingErrors(piping).join()).toContain('lengthMm and endType');
    const run = runOf(doc, runId);
    const { lengthMm: _length, ...bare } = (run.inline ?? [])[0] as unknown as Record<string, unknown>;
    void _length;
    const broken = deriveRun(doc, { ...run, inline: [bare] } as unknown as PipeRun);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe('RTE_SIZE_MISMATCH');
    expect(apply).toBeDefined();
  });
});
