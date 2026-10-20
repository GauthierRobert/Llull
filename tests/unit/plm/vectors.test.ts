import { describe, expect, it } from 'vitest';
import type { EffectivityKind, ManagedItem, Revision } from '@core/model/plm';
import { closeForCutIn, containsUnit, effectivityProblem, isUnitOfKind, resolveRevision } from '@plm/effectivity';
import { isKnownScheme, isValidCustomList, revisionLabel } from '@plm/schemes';
import { isLegalTransition, transitionRefusal } from '@plm/transitions';
import { readValidation } from './scenarioRunner';

interface Sequence {
  schemes: {
    'asme-alpha': { first25: string[]; checkpoints: Record<string, string>; capacity: number };
    'numeric-2': { checkpoints: Record<string, string> };
  };
}
interface Resolution {
  ranges: Record<EffectivityKind, { revision: string; from: number | string; to: number | string | null }[]>;
  cases: { kind: EffectivityKind; unit: number | string; expectRevision: string | null }[];
}
const sequence = JSON.parse(readValidation('vectors/revision_sequence.json')) as Sequence;
const resolution = JSON.parse(readValidation('vectors/effectivity_resolution.json')) as Resolution;

describe('revision schemes (VC-PLM-04)', () => {
  it('asme-alpha reproduces the published sequence and checkpoints', () => {
    const { first25, checkpoints, capacity } = sequence.schemes['asme-alpha'];
    first25.forEach((label, index) => expect(revisionLabel('asme-alpha', index + 1)).toBe(label));
    for (const [n, label] of Object.entries(checkpoints)) expect(revisionLabel('asme-alpha', Number(n))).toBe(label);
    expect(revisionLabel('asme-alpha', capacity)).toBe('YY');
    expect(revisionLabel('asme-alpha', capacity + 1)).toBeNull();
    expect(revisionLabel('asme-alpha', 0)).toBeNull();
  });
  it('numeric-2 and custom lists', () => {
    for (const [n, label] of Object.entries(sequence.schemes['numeric-2'].checkpoints))
      expect(revisionLabel('numeric-2', Number(n))).toBe(label);
    expect(revisionLabel('numeric-2', 100)).toBeNull();
    expect(revisionLabel('custom:x', 2, ['X1', 'X2'])).toBe('X2');
    expect(revisionLabel('custom:x', 3, ['X1', 'X2'])).toBeNull();
  });
  it('validates scheme ids and custom lists', () => {
    expect(['asme-alpha', 'numeric-2', 'custom:x'].every(isKnownScheme)).toBe(true);
    expect(isKnownScheme('custom:')).toBe(false);
    expect(isKnownScheme('roman')).toBe(false);
    expect(isValidCustomList(['A', 'B'])).toBe(true);
    expect([[], ['A', 'A'], ['A', ' ']].some((labels) => isValidCustomList(labels))).toBe(false);
  });
});

const revisionWith = (label: string, state: Revision['state'], effectivity: Revision['effectivity']): Revision => ({
  label,
  state,
  iterations: [],
  effectivity,
  approvals: [],
  signatures: [],
  stateHistory: [],
});

function itemFromVector(): ManagedItem {
  const revisions: Record<string, Revision> = {};
  for (const [kind, ranges] of Object.entries(resolution.ranges))
    for (const range of ranges) {
      const existing = revisions[range.revision] ?? revisionWith(range.revision, range.revision === 'A' ? 'superseded' : 'released', []);
      revisions[range.revision] = {
        ...existing,
        effectivity: [
          ...existing.effectivity,
          { kind: kind as EffectivityKind, from: range.from, ...(range.to === null ? {} : { to: range.to }) },
        ],
      };
    }
  return {
    partNumber: 'LL-1001',
    name: 'x',
    itemType: 'part',
    revisionScheme: 'asme-alpha',
    currentRevision: 'B',
    revisions,
    revisionOrder: ['A', 'B'],
    marking: { regime: 'none' },
  };
}

describe('effectivity (VC-PLM-07)', () => {
  const item = itemFromVector();
  it.each(resolution.cases)('$kind $unit -> $expectRevision', ({ kind, unit, expectRevision }) => {
    expect(resolveRevision(item, kind, unit)).toBe(expectRevision);
  });
  it('obsolete and cancelled revisions never resolve', () => {
    const obsolete = { ...item, revisions: { ...item.revisions, B: { ...(item.revisions['B'] as Revision), state: 'obsolete' as const } } };
    expect(resolveRevision(obsolete, 'serial', 99)).toBeNull();
  });
  it('validates units per kind', () => {
    expect(isUnitOfKind('serial', 3)).toBe(true);
    expect(isUnitOfKind('serial', 0)).toBe(false);
    expect(isUnitOfKind('msn', '3')).toBe(false);
    expect(isUnitOfKind('date', '2026-02-30')).toBe(false);
    expect(isUnitOfKind('date', '2028-02-29')).toBe(true);
    expect(isUnitOfKind('date', 'soon')).toBe(false);
    expect(isUnitOfKind('date', 20260101)).toBe(false);
    expect(isUnitOfKind('lot', 'L-7')).toBe(true);
    expect(isUnitOfKind('lot', '')).toBe(false);
    expect(effectivityProblem([{ kind: 'serial', from: 5, to: 2 }])).toContain('ends');
    expect(effectivityProblem([{ kind: 'date', from: 'x' }])).toContain('not a valid date');
    expect(effectivityProblem([{ kind: 'serial', from: 1, to: 0 }])).toContain('not a valid serial');
    expect(
      effectivityProblem([
        { kind: 'serial', from: 1 },
        { kind: 'lot', from: 'L1', to: 'L1' },
      ]),
    ).toBeNull();
  });
  it('closes an open range the day or serial before the cut-in and refuses overlaps', () => {
    const open = [{ label: 'A', effectivity: [{ kind: 'date' as const, from: '2026-11-02' }] }];
    expect(closeForCutIn(open, [{ kind: 'date', from: '2027-03-01' }])).toEqual({
      closed: { A: [{ kind: 'date', from: '2026-11-02', to: '2027-02-28' }] },
    });
    const bounded = [{ label: 'A', effectivity: [{ kind: 'serial' as const, from: 1, to: 10 }] }];
    expect(closeForCutIn(bounded, [{ kind: 'serial', from: 5 }])).toHaveProperty('overlap');
    expect(closeForCutIn(open, [{ kind: 'date', from: '2026-11-02' }])).toHaveProperty('overlap');
    expect(closeForCutIn(open, [{ kind: 'serial', from: 5 }])).toEqual({ closed: { A: open[0]?.effectivity } });
    const lots = [{ label: 'A', effectivity: [{ kind: 'lot' as const, from: 'L1' }] }];
    expect(closeForCutIn(lots, [{ kind: 'lot', from: 'L1' }])).toHaveProperty('overlap');
    expect(containsUnit({ kind: 'lot', from: 'L1' }, 'L1')).toBe(true);
  });
});

describe('lifecycle transition table (VC-PLM-08)', () => {
  it('allows the table rows and refuses the others with the table text', () => {
    expect(isLegalTransition(null, 'in_work')).toBe(true);
    expect(isLegalTransition(null, 'released')).toBe(false);
    for (const [from, to] of [
      ['in_work', 'in_review'],
      ['in_review', 'in_work'],
      ['in_review', 'released'],
      ['in_work', 'cancelled'],
      ['released', 'superseded'],
      ['released', 'obsolete'],
      ['superseded', 'obsolete'],
    ] as const)
      expect(isLegalTransition(from, to), `${from}>${to}`).toBe(true);
    for (const [from, to] of [
      ['in_work', 'released'],
      ['released', 'in_review'],
      ['superseded', 'in_work'],
      ['obsolete', 'released'],
      ['in_review', 'cancelled'],
    ] as const)
      expect(isLegalTransition(from, to), `${from}>${to}`).toBe(false);
    expect(transitionRefusal('in_work', 'released')).toBe('submit_for_review first');
    expect(transitionRefusal('in_review', 'cancelled')).toBe('reject_review first');
    expect(transitionRefusal('in_review', 'obsolete')).toContain('reject_review');
    expect(transitionRefusal('obsolete', 'released')).toContain('terminal');
    expect(transitionRefusal('released', 'in_review')).toContain('revise_item');
    expect(transitionRefusal('superseded', 'in_work')).toContain('cannot change');
  });
});
