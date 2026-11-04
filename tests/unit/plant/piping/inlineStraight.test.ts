/**
 * Plant 02 RTE CAT-FU: couplings, unions and swages placed inline (`insert_inline_component`, `route_pipe.inline`). The rows are DECLARED TEST INPUTS on the
 * small-bore scene (SW800, NPS 1 SW elbow centre-to-mouth 41, socket depth 13, socket gap 1.6): round numbers labelled as such, never a standard's values.
 * Hand calculation: the pipe sits J - gap = 11.4 mm inside every socket; the leg of 1000 with its elbow mouth at 959 loses the coupling length.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { smallBoreDocument } from './smallBoreFixtures';

const cite = { citation: 'declared test input, not from a standard (CAT-FU inline fittings)' };
const row = (size: Record<string, unknown>): Record<string, unknown> => ({ ...size, provenance: cite });
const catalog = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'test-sw-fittings',
  licence: 'company-proprietary',
  families: [
    {
      id: 'cpl',
      type: 'coupling',
      standard: 'company test table',
      ends: ['SW'],
      unit: 'mm',
      sizes: [row({ nps: 1, class: 3000, length: 40, bodyOd: 50, socketDepth: 13 })],
    },
    {
      id: 'uni-thd',
      type: 'union',
      standard: 'company test table',
      ends: ['THD'],
      unit: 'mm',
      sizes: [row({ nps: 1, class: 3000, length: 70, bodyOd: 60, threadLength: 15 })],
    },
    {
      id: 'cpl-nolength',
      type: 'coupling',
      standard: 'company test table',
      ends: ['SW'],
      unit: 'mm',
      sizes: [row({ nps: 2, class: 3000, bodyOd: 80, socketDepth: 13 })],
    },
    {
      id: 'swg',
      type: 'swage',
      standard: 'company test table',
      ends: ['SW'],
      unit: 'mm',
      sizes: [row({ nps: 2, smallNps: 1, class: 3000, length: 80, socketDepth: 13 })],
    },
  ],
};
const component = (id: string, type: string, from: number, to: number, ref: string, extra: Record<string, unknown> = {}): object => ({
  id,
  type,
  fromNps: from,
  toNps: to,
  ends: 'SW',
  catalogRef: ref,
  ...extra,
});

function scene(): { doc: CadDocument; line: string; tie: string } {
  let doc = smallBoreDocument('spec_sw800.json');
  doc = apply(doc, 'import_piping_catalog', { catalog });
  const spec = doc.plant?.spec?.specs['SW800']?.at(-1);
  doc = apply(doc, 'edit_pipe_spec', {
    specId: 'SW800',
    ops: [
      { op: 'setHeader', fields: { catalogs: [...(spec?.catalogs ?? []), 'test-sw-fittings'] } },
      { op: 'addComponent', component: component('CPL', 'coupling', 1, 1, 'cpl', { class: 3000 }) },
      { op: 'addComponent', component: component('UNI', 'union', 1, 1, 'uni-thd', { class: 3000, ends: 'THD' }) },
      { op: 'addComponent', component: component('SWG', 'swage', 2, 2, 'swg', { branchFromNps: 1, branchToNps: 1, class: 3000 }) },
    ],
  });
  doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'SW800', dn: 25 });
  doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [0, 0, 1], dn: 25, endType: 'SW' });
  const piping = doc.plant?.piping as PipingModel;
  return { doc, line: piping.lineOrder.at(-1) as string, tie: piping.tieInOrder.at(-1) as string };
}
const legs = [
  { direction: '+Z', length: 1000 },
  { direction: '+X', length: 1500 },
];
interface Placed {
  runId: string;
  pipePieces: Array<{ cutLengthMm: number; leg: number; dn: number }>;
  counts: Record<string, number>;
}
const derivedOf = (doc: CadDocument, runId: string): Extract<ReturnType<typeof deriveRun>, { ok: true }> => {
  const derived = deriveRun(doc, (doc.plant?.piping as PipingModel).runs[runId] as PipeRun);
  if (!derived.ok) throw new Error(derived.message);
  return derived;
};
const routed = (inline: unknown[]): { doc: CadDocument; result: ReturnType<typeof execute> } => {
  const s = scene();
  const result = execute(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs, inline });
  return { doc: s.doc, result };
};

describe('coupling inline', () => {
  it('occupies its length: pieces 480 + 22.8 = 502.8 and 439 + 22.8 = 461.8 around a coupling at 500; two more socket welds', () => {
    const { result } = routed([{ type: 'coupling', at: { leg: 0, centreDistance: 500 } }]);
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Placed;
    expect(data.pipePieces.filter((piece) => piece.leg === 0).map((piece) => piece.cutLengthMm)).toEqual([502.8, 461.8]);
    expect(data.counts).toMatchObject({ socketWelds: 5, buttWelds: 0 });
    const run = (result.document.plant?.piping as PipingModel).runs[data.runId] as PipeRun;
    const derived = deriveRun(result.document, run);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const part = derived.parts.find((candidate) => candidate.kind === 'inline');
    expect(part?.ports.map((port) => port.endType)).toEqual(['SW', 'SW']);
    expect(part?.ports.map((port) => port.position[2])).toEqual([480, 520]);
    expect(derived.inline[0]).toMatchObject({ type: 'coupling', dn: 25, lengthMm: 40 });
  });

  it('insert_inline_component places it, move_inline_component slides it, remove_inline_component restores the leg', () => {
    const { doc, result } = routed([]);
    const runId = (result.data as Placed).runId;
    const inserted = ok(result.document, 'insert_inline_component', { runId, type: 'coupling', at: { leg: 0, centreDistance: 500 } });
    const id = inserted.affected[0] as string;
    expect(id).toMatch(/^fitting-/);
    const moved = ok(inserted.document, 'move_inline_component', { runId, componentId: id, centreDistance: 600 });
    expect((moved.data as { legCutLengthsMm: number[] }).legCutLengthsMm.map((cut) => +cut.toFixed(6))).toEqual([602.8, 361.8]);
    const removed = ok(moved.document, 'remove_inline_component', { runId, componentId: id });
    expect(derivedOf(removed.document, runId).legs[0]?.cutLengthsMm.map((cut) => +cut.toFixed(6))).toEqual([981.8]);
    expect(doc).toBeDefined();
  });

  it('the spec socket gap applies: gap 3 mm gives engagement 10 and pieces 500 and 459', () => {
    let s = scene();
    s = { ...s, doc: apply(s.doc, 'edit_pipe_spec', { specId: 'SW800', ops: [{ op: 'setHeader', fields: { socketGapMm: 3 } }] }) };
    const result = execute(s.doc, 'route_pipe', {
      lineId: s.line,
      from: { portId: s.tie },
      legs,
      inline: [{ type: 'coupling', at: { leg: 0, centreDistance: 500 } }],
    });
    expect((result.data as Placed).pipePieces.filter((piece) => piece.leg === 0).map((piece) => piece.cutLengthMm)).toEqual([500, 459]);
  });

  it('refuses dn2 on a coupling (one size), a position outside the leg, a row without length, and a union whose end has no connection rule', () => {
    const s = scene();
    const base = { lineId: s.line, from: { portId: s.tie }, legs };
    expect(
      execute(s.doc, 'route_pipe', { ...base, inline: [{ type: 'coupling', dn2: 15, at: { leg: 0, centreDistance: 500 } }] }).rejected,
    ).toBe(true);
    const outside = execute(s.doc, 'route_pipe', { ...base, inline: [{ type: 'coupling', at: { leg: 0, centreDistance: 995 } }] });
    expect(outside.rejected).toBe(true);
    expect(outside.error?.code).toBe('RTE_INLINE_DOES_NOT_FIT');
    const union = execute(s.doc, 'route_pipe', { ...base, inline: [{ type: 'union', at: { leg: 0, centreDistance: 500 } }] });
    expect(union.rejected).toBe(true);
    expect(union.error?.code).toBe('RTE_NO_CONNECTION_RULE');
    expectPure(s.doc, () => execute(s.doc, 'route_pipe', { ...base, inline: [{ type: 'coupling', at: { leg: 0, centreDistance: 500 } }] }));
  });

  it('a spec without the type refuses with RTE_SPEC_NO_COMPONENT: the bundled catalogue has no coupling row, nothing is invented', () => {
    const plain = smallBoreDocument('spec_sw800.json');
    let doc = apply(plain, 'create_pipeline', { service: 'P', sequence: '1', spec: 'SW800', dn: 25 });
    doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [0, 0, 1], dn: 25, endType: 'SW' });
    const piping = doc.plant?.piping as PipingModel;
    const refused = execute(doc, 'route_pipe', {
      lineId: piping.lineOrder.at(-1),
      from: { portId: piping.tieInOrder.at(-1) },
      legs,
      inline: [{ type: 'coupling', at: { leg: 0, centreDistance: 500 } }],
    });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('RTE_SPEC_NO_COMPONENT');
  });
});

describe('swage inline', () => {
  it('changes the run size from its centre on (DN50 -> DN25 needs dn2), occupying its row length of 80', () => {
    const s = scene();
    const first = execute(s.doc, 'create_pipeline', { service: 'Q', sequence: '2', spec: 'SW800', dn: 50 });
    expect(first.rejected).toBeUndefined();
    const doc = first.document;
    const piping = doc.plant?.piping as PipingModel;
    const from = { point: [5000, 0, 0], direction: [0, 0, 1] };
    const result = execute(doc, 'route_pipe', {
      lineId: piping.lineOrder.at(-1),
      from,
      legs: [{ direction: '+Z', length: 2000 }],
      inline: [{ type: 'swage', dn2: 25, at: { leg: 0, centreDistance: 1000 } }],
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Placed;
    const derived = derivedOf(result.document, data.runId);
    expect(derived.parts.filter((part) => part.kind === 'pipe').map((part) => part.dn)).toEqual([50, 25]);
    const swage = derived.parts.find((part) => part.kind === 'reducer');
    expect(swage?.typeKey).toBe('swage');
    expect(swage?.ports.map((port) => port.position[2])).toEqual([960, 1040]);
    expect(derived.inline[0]).toMatchObject({ type: 'swage', dn: 50, dn2: 25, lengthMm: 80 });
    const noDn2 = execute(doc, 'route_pipe', {
      lineId: piping.lineOrder.at(-1),
      from,
      legs: [{ direction: '+Z', length: 2000 }],
      inline: [{ type: 'swage', at: { leg: 0, centreDistance: 1000 } }],
    });
    expect(noDn2.rejected).toBe(true);
    expect(noDn2.error?.code).toBe('RTE_SIZE_MISMATCH');
    expectRefusal(
      s.doc,
      'insert_inline_component',
      { runId: 'nope', type: 'swage', dn2: 25, at: { leg: 0, centreDistance: 1 } },
      'RTE_UNKNOWN_RUN',
    );
  });
});
