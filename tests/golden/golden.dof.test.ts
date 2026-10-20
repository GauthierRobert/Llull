/**
 * SC-Q4b: degrees-of-freedom property judge for the sketch solver. Seeded random sketches get random constraints one at a time; the
 * reported `dof` (unknowns minus Jacobian rank) must fall by exactly the rows of every accepted single-row constraint, stay put on a
 * refusal, climb back when a constraint is deleted, not depend on the order constraints were added, and leave a converged,
 * idempotent solution. Reads only `solve_constraints` data and entities, like the other judges.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { addCircle, addLine, constrain, emptySketch, lineOf, ref, solve, type Sketch } from '../unit/helpers/sketch';

/** mulberry32: small seeded PRNG, so a failing seed reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Move {
  label: string;
  /** Rows the constraint removes when it is independent of the others. */
  rows: number;
  apply: (s: Sketch) => { id?: string; refused?: string };
}

interface Sample {
  sketch: Sketch;
  lines: string[];
  circles: string[];
  moves: Move[];
}

function randomSketch(seed: number): Sample {
  const next = prng(seed);
  const between = (lo: number, hi: number): number => lo + next() * (hi - lo);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const sketch = emptySketch();
  const lines = Array.from({ length: 4 }, () => addLine(sketch, [between(0, 40), between(0, 40)], [between(0, 40), between(0, 40)]));
  const circles = Array.from({ length: 2 }, () => addCircle(sketch, [between(0, 40), between(0, 40)], between(1, 4)));
  const moves: Move[] = [];
  for (let i = 0; i < 40; i++) {
    const a = pick(lines);
    const b = pick(lines);
    const c = pick(circles);
    const end = pick(['start', 'end'] as const);
    const choice = Math.floor(next() * 9);
    const value = Math.round(between(3, 30) * 10) / 10;
    if (choice === 0) moves.push({ label: `horizontal ${a}`, rows: 1, apply: (s) => constrain(s, 'horizontal', ref(a)) });
    else if (choice === 1) moves.push({ label: `vertical ${a}`, rows: 1, apply: (s) => constrain(s, 'vertical', ref(a)) });
    else if (choice === 2)
      moves.push({ label: `length ${a}`, rows: 1, apply: (s) => constrain(s, 'aligned', ref(a), undefined, { value }) });
    else if (choice === 3) moves.push({ label: `parallel ${a} ${b}`, rows: 1, apply: (s) => constrain(s, 'parallel', ref(a), ref(b)) });
    else if (choice === 4) moves.push({ label: `equal ${a} ${b}`, rows: 1, apply: (s) => constrain(s, 'equal', ref(a), ref(b)) });
    else if (choice === 5) moves.push({ label: `fix ${a}.${end}`, rows: 2, apply: (s) => constrain(s, 'fix', ref(a, end)) });
    else if (choice === 6)
      moves.push({ label: `radius ${c}`, rows: 1, apply: (s) => constrain(s, 'radius', ref(c), undefined, { value: value / 6 }) });
    else if (choice === 7)
      moves.push({
        label: `coincident ${a} ${b}`,
        rows: 2,
        apply: (s) => constrain(s, 'coincident', ref(a, end), ref(b, pick(['start', 'end'] as const))),
      });
    else
      moves.push({
        label: `distance ${a} ${b}`,
        rows: 1,
        apply: (s) => constrain(s, 'distance', ref(a, 'start'), ref(b, 'end'), { value }),
      });
  }
  return { sketch, lines, circles, moves };
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];

describe('solver degrees of freedom (property)', () => {
  it('a free sketch has 4 per line and 3 per circle', () => {
    const { sketch, lines, circles } = randomSketch(7);
    const data = solve(sketch);
    expect(data.dof).toBe(4 * lines.length + 3 * circles.length);
    expect(data.isFullyConstrained).toBe(false);
    expect(data.fullyConstrained).toEqual([]);
  });

  for (const seed of SEEDS) {
    it(`seed ${seed}: accepted constraints lower dof, refused ones leave the document alone, deletion restores it`, () => {
      const { sketch, moves } = randomSketch(seed);
      const history: { id: string; dof: number; label: string }[] = [];
      let dof = solve(sketch).dof;
      let accepted = 0;
      for (const move of moves) {
        const before = sketch.doc;
        const result = move.apply(sketch);
        if (result.id === undefined) {
          expect(sketch.doc).toBe(before);
          expect(result.refused).toMatch(/refused|redundant|conflict|adds no restriction|needs|must/);
          continue;
        }
        accepted++;
        const after = solve(sketch);
        expect(after.converged, move.label).toBe(true);
        expect(after.skipped, move.label).toEqual([]);
        expect(after.dof, move.label).toBeLessThan(dof);
        if (move.rows === 1) expect(after.dof, move.label).toBe(dof - 1);
        expect(after.dof, move.label).toBeGreaterThanOrEqual(dof - move.rows);
        expect(after.isFullyConstrained).toBe(after.dof === 0);
        history.push({ id: result.id, dof, label: move.label });
        dof = after.dof;
      }
      expect(accepted).toBeGreaterThan(3);
      for (const entry of history.reverse()) {
        const removed = execute(sketch.doc, 'delete_constraint', { id: entry.id });
        expect(removed.summary).toContain(`removed`);
        expect(removed.document.constraintOrder).toHaveLength(sketch.doc.constraintOrder.length - 1);
        sketch.doc = removed.document;
        expect(solve(sketch).dof, `after deleting ${entry.label}`).toBe(entry.dof);
      }
      expect(sketch.doc.constraintOrder).toEqual([]);
    });

    it(`seed ${seed}: the solution satisfies every constraint and solving again changes nothing`, () => {
      const { sketch, lines, moves } = randomSketch(seed);
      for (const move of moves) move.apply(sketch);
      const first = solve(sketch);
      expect(first.converged).toBe(true);
      expect(first.residual).toBeLessThan(1e-9);
      const again = solve(sketch);
      expect(again.dof).toBe(first.dof);
      expect(again.residual).toBeLessThan(1e-9);
      const settled = lines.map((id) => [...lineOf(sketch, id).start, ...lineOf(sketch, id).end]);
      solve(sketch);
      lines.forEach((id, index) => {
        const now = [...lineOf(sketch, id).start, ...lineOf(sketch, id).end];
        now.forEach((value, k) => expect(value).toBeCloseTo(settled[index]![k]!, 6));
      });
      for (const id of first.fullyConstrained) expect(sketch.doc.entities[id]).toBeDefined();
    });
  }

  it('dof does not depend on the order the constraints were added', () => {
    const { sketch, moves } = randomSketch(21);
    for (const move of moves) move.apply(sketch);
    const forward = solve(sketch);
    const kept = sketch.doc.constraintOrder.map((id) => sketch.doc.constraints[id]!);
    expect(kept.length).toBeGreaterThan(3);
    const rebuilt = randomSketch(21).sketch;
    for (const stored of [...kept].reverse()) {
      const constraint = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'id'));
      const result = execute(rebuilt.doc, 'add_constraint', { constraint });
      expect(result.affected, result.summary).toHaveLength(1);
      rebuilt.doc = result.document;
    }
    expect(rebuilt.doc.constraintOrder).toHaveLength(kept.length);
    expect(solve(rebuilt).dof).toBe(forward.dof);
  });
});
