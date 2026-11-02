/** Plant 04 PID M7b: P3D_SPEC_MISMATCH, P3D_CLASS_MISMATCH, P3D_INLINE_ORDER_MISMATCH, and the 3D side reading 02 RTE routed lines and 03 EQP vessels. */

import { describe, expect, it } from 'vitest';
import { data } from '../../../helpers/commandAssertions';
import type { CadDocument } from '@core/model/types';
import { CLEAN_INLINE, routedWithValves, withPid, type InlineSpec, type PidOptions } from './pid3dM7b';

interface Item {
  code: string;
  item: string;
  message: string;
  values: Record<string, string | number | boolean>;
}
interface Skip {
  code: string;
  reason: string;
  item: string;
}
interface Answer {
  status: string;
  items: Item[];
  skipped: Skip[];
  countsByCode: Record<string, number>;
  matched: { equipment: string[]; lines: string[]; inline: string[] };
  unmatchedPid: Array<{ label: string; reason: string }>;
  unmatched3d: Array<{ label: string; category: string; reason: string }>;
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): Answer => data<Answer>(doc, 'check_pid_3d', params);
const scene = routedWithValves();
const clean = (options: PidOptions = {}): CadDocument => withPid(scene, { pipingClass: 'CS150', inline: CLEAN_INLINE, ...options });
const pairs = (answer: Answer): string[][] => answer.items.map((f) => [f.code, f.item]);

describe('02 RTE routed lines on the 3D side', () => {
  it('pairs the P&ID line with the routed line and the inline tags with the routed valves (no P3D_UNPLACED)', () => {
    const answer = check(clean());
    expect(answer.items).toEqual([]);
    expect(answer.status).toBe('pass');
    expect(answer.matched.lines).toEqual([scene.lineNumber]);
    expect(answer.matched.equipment).toEqual(['P-101', 'V-101']);
    expect(answer.matched.inline).toEqual(['XV-1', 'XV-2', 'XV-3']);
    expect(answer.unmatchedPid).toEqual([]);
  });

  it('reports a routed valve that is not on the P&ID as P3D_NOT_IN_PID in the inline category', () => {
    const answer = check(clean({ inline: CLEAN_INLINE.slice(0, 2) }));
    expect(pairs(answer)).toEqual([['P3D_NOT_IN_PID', 'XV-3']]);
    expect(answer.unmatched3d).toMatchObject([{ category: 'inline', label: 'XV-3', reason: 'not_in_pid' }]);
  });

  it('reports a P&ID valve that is not in 3D as P3D_UNPLACED', () => {
    const answer = check(clean({ inline: [...CLEAN_INLINE, { tag: 'HV-9', class: 'GateValve' }] }));
    expect(pairs(answer)).toEqual([['P3D_UNPLACED', 'HV-9']]);
    expect(answer.unmatchedPid).toMatchObject([{ label: 'HV-9', reason: 'unplaced' }]);
  });

  it('reads the nozzle ports of the routed run as the line ends (no connectivity finding when they agree)', () => {
    expect(check(clean()).countsByCode['P3D_CONNECTIVITY_MISMATCH']).toBe(0);
  });

  it('flags a routed line whose nozzle port differs from the P&ID nozzle sub-tag', () => {
    const answer = check(clean({ pumpNozzle: 'N5' }));
    expect(pairs(answer)).toEqual([['P3D_CONNECTIVITY_MISMATCH', scene.lineNumber]]);
    expect(answer.items[0]?.values['modelEnds']).toContain('P-101/N2');
  });

  it('a routed line absent from the P&ID is P3D_NOT_IN_PID (pipe category)', () => {
    const answer = check(scene.doc);
    expect(answer.unmatched3d.some((u) => u.category === 'pipe' && u.label === scene.lineNumber)).toBe(true);
  });
});

describe('P3D_SPEC_MISMATCH', () => {
  it('flags a P&ID piping class that is not the spec id of the 3D line', () => {
    const answer = check(clean({ pipingClass: 'CS300' }));
    expect(pairs(answer)).toEqual([['P3D_SPEC_MISMATCH', scene.lineNumber]]);
    expect(answer.items[0]?.values).toEqual({ pidClass: 'CS300', modelSpec: 'CS150' });
  });

  it('accepts the same class written differently under tag normalisation, and refuses it with normaliseTags false', () => {
    expect(check(clean({ pipingClass: 'cs-150' })).items).toEqual([]);
    expect(pairs(check(clean({ pipingClass: 'cs-150' }), { normaliseTags: false }))).toContainEqual([
      'P3D_SPEC_MISMATCH',
      scene.lineNumber,
    ]);
  });

  it('skips (coded) a P&ID line without a piping class instead of passing it', () => {
    const answer = check(withPid(scene, { inline: CLEAN_INLINE }));
    expect(answer.items).toEqual([]);
    expect(answer.skipped.filter((k) => k.code === 'P3D_SPEC_MISMATCH')).toMatchObject([
      { reason: 'no_pid_class', item: scene.lineNumber },
    ]);
  });
});

describe('P3D_CLASS_MISMATCH', () => {
  const inline = (cls: string): readonly InlineSpec[] => [{ tag: 'XV-1', class: cls }, ...CLEAN_INLINE.slice(1)];

  it('flags an inline item whose DEXPI class maps to another catalogue type', () => {
    const answer = check(clean({ inline: inline('GlobeValve') }));
    expect(pairs(answer)).toEqual([['P3D_CLASS_MISMATCH', 'XV-1']]);
    expect(answer.items[0]?.values).toEqual({ pidClass: 'GlobeValve', modelType: 'valveGate', expected: 'valveGlobe' });
  });

  it('accepts the mapped class and OperatedValve for any valve type', () => {
    expect(check(clean({ inline: inline('OperatedValve') })).items).toEqual([]);
    expect(check(clean()).countsByCode['P3D_CLASS_MISMATCH']).toBe(0);
  });

  it('flags a reducer class on a valve', () => {
    expect(pairs(check(clean({ inline: inline('PipeReducer') })))).toEqual([['P3D_CLASS_MISMATCH', 'XV-1']]);
  });

  it('skips (coded) a class with no row in the mapping table', () => {
    const answer = check(clean({ inline: inline('NeedleValve') }));
    expect(answer.items).toEqual([]);
    expect(answer.skipped.filter((k) => k.reason === 'class_not_mapped')).toMatchObject([{ code: 'P3D_CLASS_MISMATCH', item: 'XV-1' }]);
  });

  it('flags equipment whose class a 03 EQP vessel cannot stand for', () => {
    const answer = check(clean({ vesselClass: 'CentrifugalPump' }));
    expect(pairs(answer)).toEqual([['P3D_CLASS_MISMATCH', 'V-101']]);
    expect(answer.items[0]?.values).toMatchObject({ pidClass: 'CentrifugalPump', modelKind: 'vessel' });
  });

  it('accepts a vertical vessel as Tank / ProcessColumn, and skips (coded) equipment without a vessel kind', () => {
    for (const vesselClass of ['Tank', 'ProcessColumn', 'ColumnSection']) expect(check(clean({ vesselClass })).items).toEqual([]);
    const answer = check(clean());
    expect(answer.skipped.filter((k) => k.reason === 'no_3d_class')).toMatchObject([{ code: 'P3D_CLASS_MISMATCH', item: 'P-101' }]);
  });
});

describe('P3D_INLINE_ORDER_MISMATCH', () => {
  /** P&ID items are drawn from the pump, the 3D route also starts at the pump: route order XV-1, XV-2, XV-3. */
  const order = (tags: string[]): readonly InlineSpec[] => tags.map((tag) => ({ tag, class: 'GateValve' }));

  it('passes when the order agrees, and when the P&ID is drawn against the route direction (reverse tried)', () => {
    expect(check(clean({ inline: order(['XV-1', 'XV-2', 'XV-3']) })).countsByCode['P3D_INLINE_ORDER_MISMATCH']).toBe(0);
    expect(check(clean({ inline: order(['XV-3', 'XV-2', 'XV-1']) })).items).toEqual([]);
  });

  it('reports the longest common sequence and the out-of-place tags', () => {
    const answer = check(clean({ inline: order(['XV-1', 'XV-3', 'XV-2']) }));
    expect(pairs(answer)).toEqual([['P3D_INLINE_ORDER_MISMATCH', scene.lineNumber]]);
    expect(answer.items[0]?.values).toMatchObject({ pidOrder: 'XV-1,XV-3,XV-2', lcsLength: 2, modelReversed: false });
    expect(answer.items[0]?.values['outOfPlace']).toBe('XV-3');
    expect(answer.items[0]?.values['lcs']).toBe('XV-1,XV-2');
  });

  it('does not report an order problem for a tag that is only on one side (that is UNPLACED / NOT_IN_PID)', () => {
    const answer = check(clean({ inline: order(['XV-1', 'XV-3']) }));
    expect(pairs(answer)).toEqual([['P3D_NOT_IN_PID', 'XV-2']]);
  });

  it('is not compared in scope equipment', () => {
    expect(check(clean({ inline: order(['XV-1', 'XV-3', 'XV-2']) }), { scope: 'equipment' }).items).toEqual([]);
  });
});
