/**
 * SC-Q4b judges for the constraint guards and the DOF count (docs/MUTATION.md): conflicting, redundant and flipping constraints are refused
 * with the document unchanged, consistent edits keep the sketch's branch, and seeded random sketches agree with the independent oracle.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type LineEntity } from '@core/model/types';
import { runPlan } from './runPlan';
import { sketchPlans } from './sketchPlans';
import type { GoldenAction } from './plans';
import { oracleDof, worstResidual } from './sketchOracle';
import { xy } from '../helpers/xy';

const ref = (entityId: string, kind?: 'start' | 'end'): Record<string, string> => (kind ? { entityId, kind } : { entityId });

const built = (name: string): CadDocument => {
  const plan = sketchPlans[name];
  if (!plan) throw new Error(`no sketch plan ${name}`);
  return runPlan(plan.actions).document;
};

const lineId = (doc: CadDocument, index: number): string => {
  const id = doc.order.filter((e) => doc.entities[e]?.kind === 'line')[index];
  if (id === undefined) throw new Error(`no line #${index}`);
  return id;
};

const refusedUnchanged = (doc: CadDocument, command: string, params: Record<string, unknown>): string => {
  const result = execute(doc, command, params);
  expect(result.affected).toEqual([]);
  expect(result.document).toBe(doc);
  return result.summary;
};

const TRIANGLE: GoldenAction[] = [
  { command: 'draw_polyline', params: { points: xy(0, 0, 10, 0) }, as: 'ab' },
  { command: 'draw_polyline', params: { points: xy(10, 0, 5, 3.3) }, as: 'bc' },
  { command: 'draw_polyline', params: { points: xy(5, 3.3, 0, 0) }, as: 'ca' },
  ...(
    [
      ['ab', 'end', 'bc', 'start'],
      ['bc', 'end', 'ca', 'start'],
      ['ca', 'end', 'ab', 'start'],
    ] as const
  ).map(([a, ak, b, bk]) => ({
    command: 'add_constraint',
    params: { constraint: { kind: 'coincident', a: { entityId: `$${a}`, kind: ak }, b: { entityId: `$${b}`, kind: bk } } },
  })),
  ...(['ab', 'bc', 'ca'] as const).map((side, i) => ({
    command: 'add_constraint',
    params: { constraint: { kind: 'aligned', a: { entityId: `$${side}` }, value: i === 0 ? 10 : 6 } },
    as: `dim_${side}`,
  })),
  { command: 'solve_constraints', params: {} },
];

const signedArea = (doc: CadDocument): number => {
  const [ab, bc] = [0, 1].map((i) => doc.entities[lineId(doc, i)] as LineEntity) as [LineEntity, LineEntity];
  const u = [ab.end[0] - ab.start[0], ab.end[1] - ab.start[1]];
  const v = [bc.end[0] - ab.start[0], bc.end[1] - ab.start[1]];
  return (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0);
};

describe('constraint guards refuse and leave the document unchanged', () => {
  it('a dimension that contradicts a fully constrained slot is a conflict naming the constraints it fights', () => {
    const doc = built('sketch_slot_fully_constrained');
    const summary = refusedUnchanged(doc, 'add_constraint', { constraint: { kind: 'aligned', a: ref(lineId(doc, 0)), value: 50 } });
    expect(summary).toMatch(/conflicts with constraint\(s\) 'con-/);
  });

  it('a relation the slot already implies is redundant', () => {
    const doc = built('sketch_slot_fully_constrained');
    expect(refusedUnchanged(doc, 'add_constraint', { constraint: { kind: 'horizontal', a: ref(lineId(doc, 1)) } })).toContain('redundant');
  });

  it('an angle edited to the other side of its line would mirror the sketch: refused as a flip, a same-side edit is kept', () => {
    const doc = runPlan([
      { command: 'draw_polyline', params: { points: xy(0, 0, 10, 0) }, as: 'a' },
      { command: 'draw_polyline', params: { points: xy(0, 0, 10, 6) }, as: 'b' },
      { command: 'add_constraint', params: { constraint: { kind: 'angle', a: { entityId: '$a' }, b: { entityId: '$b' }, value: 0.5 } } },
    ]).document;
    const angleId = doc.constraintOrder[0] as string;
    expect(refusedUnchanged(doc, 'update_constraint', { id: angleId, patch: { value: -0.5 } })).toContain('flip');
    const kept = execute(doc, 'update_constraint', { id: angleId, patch: { value: 0.9 } });
    expect(kept.affected).toEqual([angleId]);
  });

  it('a dimensioned triangle keeps its orientation through feasible edits and refuses an impossible side', () => {
    const outcome = runPlan(TRIANGLE);
    expect(outcome.failedSteps).toEqual([]);
    const doc = outcome.document;
    expect(signedArea(doc)).toBeGreaterThan(0);
    const third = doc.constraintOrder.at(-1) as string;
    for (const value of [15.9, 4.1]) {
      const edited = execute(doc, 'update_constraint', { id: third, patch: { value } });
      expect(edited.affected).toEqual([third]);
      const solved = execute(edited.document, 'solve_constraints', {}).document;
      expect(signedArea(solved)).toBeGreaterThan(0);
      expect(worstResidual(solved).residual).toBeLessThan(1e-9);
    }
    for (const impossible of [3, 20])
      expect(refusedUnchanged(doc, 'update_constraint', { id: third, patch: { value: impossible } })).toContain('conflicts');
  });
});

/** Mulberry32: a small seeded PRNG so the property sample is identical on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'line' | 'circle';

/** A random sketch of lines and circles and up to `tries` random constraints (the guard refuses the inconsistent ones). */
function randomSketch(seed: number, tries: number): CadDocument {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const coord = (): number => Math.round((random() * 40 - 20) * 100) / 100;
  let doc = createEmptyDocument();
  const ids: { id: string; kind: Kind }[] = [];
  const shapes = 2 + Math.floor(random() * 3);
  for (let i = 0; i < shapes; i++) {
    const kind: Kind = random() < 0.7 ? 'line' : 'circle';
    const result =
      kind === 'line'
        ? execute(doc, 'draw_polyline', { points: xy(coord(), coord(), coord(), coord()) })
        : execute(doc, 'draw_arc', { center: [coord(), coord()], radius: 1 + Math.round(random() * 800) / 100 });
    doc = result.document;
    ids.push({ id: result.affected[0] as string, kind });
  }
  const lines = ids.filter((s) => s.kind === 'line').map((s) => s.id);
  const circles = ids.filter((s) => s.kind === 'circle').map((s) => s.id);
  const endOf = (): Record<string, string> => ref(pick(lines), pick(['start', 'end'] as const));
  for (let i = 0; i < tries; i++) {
    const options: Record<string, unknown>[] = [];
    if (lines.length > 0) {
      options.push({ kind: pick(['horizontal', 'vertical'] as const), a: ref(pick(lines)) });
      options.push({ kind: 'aligned', a: ref(pick(lines)), value: 2 + Math.round(random() * 2000) / 100 });
      options.push({ kind: 'fix', a: endOf() });
    }
    if (lines.length > 1) {
      options.push({ kind: pick(['parallel', 'perpendicular', 'equal', 'collinear'] as const), a: ref(pick(lines)), b: ref(pick(lines)) });
      options.push({ kind: 'coincident', a: endOf(), b: endOf() });
      options.push({ kind: 'distance', a: endOf(), b: endOf(), value: 1 + Math.round(random() * 2000) / 100 });
    }
    if (circles.length > 0) options.push({ kind: 'radius', a: ref(pick(circles)), value: 1 + Math.round(random() * 900) / 100 });
    if (circles.length > 1) options.push({ kind: pick(['concentric', 'equal'] as const), a: ref(pick(circles)), b: ref(pick(circles)) });
    if (circles.length > 0 && lines.length > 0) options.push({ kind: 'tangent', a: ref(pick(lines)), b: ref(pick(circles)) });
    doc = execute(doc, 'add_constraint', { constraint: pick(options) }).document;
  }
  return doc;
}

describe('property: a solved random sketch satisfies every constraint and DOF = unknowns − rank', () => {
  it.each(Array.from({ length: 40 }, (_, seed) => seed + 1))('seed %i', (seed) => {
    const doc = randomSketch(seed, 8);
    const result = execute(doc, 'solve_constraints', {});
    const data = result.data as { converged: boolean; dof: number; isFullyConstrained: boolean };
    expect(data.converged).toBe(true);
    expect(worstResidual(result.document).residual).toBeLessThan(1e-9);
    expect(data.dof).toBe(oracleDof(result.document));
    expect(data.isFullyConstrained).toBe(data.dof === 0);
  });
});
