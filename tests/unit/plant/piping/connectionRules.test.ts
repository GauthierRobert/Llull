/** Plant 01 PSC / 02 RTE: connection rules and the socket gap in the PSC spec format (`socketGapMm`, `connections`). */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { pipeSpecErrors } from '@aec/plant/spec/document';
import { diffSpecs } from '@aec/plant/spec/diff';
import type { PipeSpec } from '@aec/plant/spec/types';
import { smallBoreDocument } from './smallBoreFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface RouteData {
  pipePieces: Array<{ cutLengthMm: number }>;
  counts: Record<string, number>;
}

const setHeader = (doc: CadDocument, fields: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'edit_pipe_spec', { specId: 'SW800', ops: [{ op: 'setHeader', fields }] });

/** The SW800 scene of socketThreaded.test.ts (NPS 1, socket depth 13) after `header` members were set on the spec, routed up 1000 and across 1500. */
function route(header: Record<string, unknown> | null): ReturnType<typeof execute> {
  let doc = smallBoreDocument('spec_sw800.json');
  if (header !== null) doc = apply(doc, 'edit_pipe_spec', { specId: 'SW800', ops: [{ op: 'setHeader', fields: header }] });
  doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'SW800', dn: 25 });
  doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [0, 0, 1], dn: 25, endType: 'SW' });
  const legs = [
    { direction: '+Z', length: 1000 },
    { direction: '+X', length: 1500 },
  ];
  return execute(doc, 'route_pipe', { lineId: piping(doc).lineOrder.at(-1), from: { portId: piping(doc).tieInOrder.at(-1) }, legs });
}
const cuts = (header: Record<string, unknown> | null): number[] => {
  const result = route(header);
  expect(result.rejected, result.summary).toBeUndefined();
  return (result.data as RouteData).pipePieces.map((piece) => piece.cutLengthMm);
};

describe('socketGapMm', () => {
  it('the named default 1.6 mm is the baseline (socket depth 13, pipe 11.4 inside)', () => {
    expect(cuts(null)).toEqual([981.8, 1470.4]);
  });

  it('a spec gap of 3 mm sits the pipe J - 3 = 10 mm inside: cuts 1000 - 41 + 20 = 979 and 1500 - 41 + 10 = 1469', () => {
    expect(cuts({ socketGapMm: 3 })).toEqual([979, 1469]);
  });

  it('the file form rejects a gap outside 0..10 and a gap survives a save / load', () => {
    const base = smallBoreDocument('spec_sw800.json');
    expect(setHeader(base, { socketGapMm: 11 }).rejected).toBe(true);
    expect(setHeader(base, { socketGapMm: -1 }).rejected).toBe(true);
    const edited = apply(base, 'edit_pipe_spec', { specId: 'SW800', ops: [{ op: 'setHeader', fields: { socketGapMm: 2 } }] });
    expect(deserializeDocument(serializeDocument(edited)).plant?.spec?.specs['SW800']?.at(-1)?.socketGapMm).toBe(2);
  });
});

describe('connections (rules of the spec)', () => {
  it('a SW-PL rule with its own gap overrides the default (2 mm: engagement 11, cuts 1000 - 41 + 22 = 981 and 1500 - 41 + 11 = 1470)', () => {
    expect(cuts({ connections: [{ end: 'SW', pipeEnd: 'PL', joint: 'socketWeld', gapMm: 2 }] })).toEqual([981, 1470]);
  });

  it('a rule is read in either order and wins over socketGapMm', () => {
    expect(cuts({ socketGapMm: 5, connections: [{ end: 'PL', pipeEnd: 'SW', joint: 'socketWeld', gapMm: 2 }] })).toEqual([981, 1470]);
  });

  it('a socket-weld rule without a gap takes the spec socketGapMm', () => {
    expect(cuts({ socketGapMm: 3, connections: [{ end: 'SW', pipeEnd: 'PL', joint: 'socketWeld' }] })).toEqual([979, 1469]);
  });

  it('a rule that makes SW-PL a butt weld counts butt welds and no socket weld', () => {
    const result = route({ connections: [{ end: 'SW', pipeEnd: 'PL', joint: 'buttWeld', gapMm: 0 }] });
    expect(result.rejected, result.summary).toBeUndefined();
    expect((result.data as RouteData).counts).toMatchObject({ socketWelds: 0, buttWelds: 3 });
  });

  it('a threaded rule on a socket-weld row is refused (RTE_SPEC_NO_COMPONENT: the row has no threadEngagement; nothing is invented)', () => {
    const result = route({ connections: [{ end: 'SW', pipeEnd: 'PL', joint: 'threaded' }] });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('RTE_SPEC_NO_COMPONENT');
  });

  it('a socket gap not smaller than the socket depth cannot cut the pipe back: RTE_SPEC_NO_COMPONENT naming socketDepth', () => {
    const result = route({ connections: [{ end: 'SW', pipeEnd: 'PL', joint: 'socketWeld', gapMm: 13 }] });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('RTE_SPEC_NO_COMPONENT');
    expect(result.summary).toContain('socketDepth');
  });

  it('two rules for one pair, an unknown end or joint, and a negative gap are refused; the document is not mutated', () => {
    const base = smallBoreDocument('spec_sw800.json');
    const rule = { end: 'SW', pipeEnd: 'PL', joint: 'socketWeld' };
    expectPure(base, () => setHeader(base, { connections: [rule] }));
    expect(setHeader(base, { connections: [rule, { ...rule, end: 'PL', pipeEnd: 'SW' }] }).summary).toContain('two rules');
    expect(setHeader(base, { connections: [{ ...rule, end: 'XX' }] }).rejected).toBe(true);
    expect(setHeader(base, { connections: [{ ...rule, joint: 'glued' }] }).rejected).toBe(true);
    expect(setHeader(base, { connections: [{ ...rule, gapMm: -1 }] }).rejected).toBe(true);
    expectRefusal(
      base,
      'edit_pipe_spec',
      { specId: 'SW800', ops: [{ op: 'setHeader', fields: { connections: [{ ...rule, end: 'XX' }] } }] },
      'PSC_SPEC_INVALID',
    );
  });

  it('is part of the canonical export, the revision diff and the load validation', () => {
    const edited = apply(smallBoreDocument('spec_sw800.json'), 'edit_pipe_spec', {
      specId: 'SW800',
      ops: [{ op: 'setHeader', fields: { socketGapMm: 2, connections: [{ end: 'SW', pipeEnd: 'PL', joint: 'socketWeld', gapMm: 2 }] } }],
    });
    const exported = data<{ text: string }>(edited, 'export_pipe_spec', { specId: 'SW800' });
    expect(exported.text).toContain('"connections"');
    expect(exported.text).toContain('"socketGapMm":2');
    const specs = edited.plant?.spec?.specs['SW800'] as PipeSpec[];
    const diff = diffSpecs({ ...(specs.at(-1) as PipeSpec), socketGapMm: 4 }, specs.at(-1) as PipeSpec);
    expect(diff.header.map((change) => change.field)).toEqual(['socketGapMm']);
    const { connections: _removed, ...plain } = specs.at(-1) as PipeSpec;
    expect(diffSpecs(plain as PipeSpec, specs.at(-1) as PipeSpec).header.map((change) => change.field)).toEqual(['connections']);
    const withRevision = (member: string, value: unknown): unknown => ({
      ...edited.plant?.spec,
      specs: { SW800: [{ ...(specs.at(-1) as object), [member]: value }] },
    });
    expect(pipeSpecErrors(withRevision('connections', [{ end: 'ZZ' }]))).toHaveLength(1);
    expect(pipeSpecErrors(withRevision('socketGapMm', 99))).toHaveLength(1);
    expect(pipeSpecErrors(withRevision('connections', [{ end: 'SW', pipeEnd: 'PL', joint: 'socketWeld', gapMm: 2 }]))).toEqual([]);
    expect(ok(edited, 'check_pipe_spec', { specId: 'SW800' }).rejected).toBeUndefined();
  });
});
