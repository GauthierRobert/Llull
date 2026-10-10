import { describe, it, expect } from 'vitest';
import { type CadDocument, type LineEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function twoLines(
  a: { start: [number, number]; end: [number, number] },
  b: { start: [number, number]; end: [number, number] },
): { doc: CadDocument; idA: string; idB: string } {
  const first = execute(createEmptyDocument(), 'draw_line', a);
  const second = execute(first.document, 'draw_line', b);
  return { doc: second.document, idA: first.affected[0]!, idB: second.affected[0]! };
}

function constrain(
  doc: CadDocument,
  kind: string,
  idA: string,
  idB: string,
  value?: number,
): CadDocument {
  return execute(doc, 'add_constraint', {
    constraint: {
      kind,
      a: { entityId: idA },
      b: { entityId: idB },
      ...(value === undefined ? {} : { value }),
    },
  }).document;
}

function direction(doc: CadDocument, id: string): [number, number] {
  const line = doc.entities[id] as LineEntity;
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const length = Math.hypot(dx, dy);
  return [dx / length, dy / length];
}

function lineLength(doc: CadDocument, id: string): number {
  const line = doc.entities[id] as LineEntity;
  return Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
}

function solve(doc: CadDocument): {
  document: CadDocument;
  data: { converged: boolean; residual: number };
} {
  const result = execute(doc, 'solve_constraints', {});
  return {
    document: result.document,
    data: result.data as { converged: boolean; residual: number },
  };
}

describe('solve_constraints on line orientation constraints', () => {
  const { doc, idA, idB } = twoLines(
    { start: [0, 0], end: [10, 0] },
    { start: [0, 5], end: [10, 8] },
  );

  it('parallel rotates line b until it is parallel to line a, keeping its length', () => {
    const solved = solve(constrain(doc, 'parallel', idA, idB));
    expect(solved.data.converged).toBe(true);
    const [bx, by] = direction(solved.document, idB);
    expect(Math.abs(bx * 0 - by * 1)).toBeLessThan(1e-3);
    expect(lineLength(solved.document, idB)).toBeCloseTo(lineLength(doc, idB), 6);
  });

  it('parallel also accepts an anti-parallel line', () => {
    const flipped = twoLines({ start: [0, 0], end: [10, 0] }, { start: [10, 4], end: [0, 5] });
    const solved = solve(constrain(flipped.doc, 'parallel', flipped.idA, flipped.idB));
    expect(solved.data.converged).toBe(true);
    expect(Math.abs(direction(solved.document, flipped.idB)[1])).toBeLessThan(1e-3);
  });

  it('perpendicular rotates line b to 90 degrees from line a', () => {
    const solved = solve(constrain(doc, 'perpendicular', idA, idB));
    expect(solved.data.converged).toBe(true);
    expect(Math.abs(direction(solved.document, idB)[0])).toBeLessThan(1e-3);
  });

  it('angle rotates line b to the requested angle from line a', () => {
    const solved = solve(constrain(doc, 'angle', idA, idB, Math.PI / 4));
    expect(solved.data.converged).toBe(true);
    const [bx, by] = direction(solved.document, idB);
    expect(Math.atan2(by, bx)).toBeCloseTo(Math.PI / 4, 3);
  });

  it('leaves line a untouched and does not mutate the input document', () => {
    const constrained = constrain(doc, 'parallel', idA, idB);
    const snapshot = JSON.stringify(constrained);
    const solved = solve(constrained);
    expect(JSON.stringify(constrained)).toBe(snapshot);
    expect(solved.document.entities[idA]).toEqual(constrained.entities[idA]);
  });

  it('conflicting constraints report non-convergence with a residual describing the returned document', () => {
    let conflicted = constrain(doc, 'parallel', idA, idB);
    conflicted = constrain(conflicted, 'perpendicular', idA, idB);
    const solved = solve(conflicted);
    expect(solved.data.converged).toBe(false);
    expect(solved.data.residual).toBeGreaterThan(1e-3);
    expect(Number.isFinite(solved.data.residual)).toBe(true);
  });

  it('constraints on a point-sized or missing line are skipped without NaN', () => {
    const degenerate = twoLines({ start: [0, 0], end: [10, 0] }, { start: [3, 3], end: [3, 3] });
    const solved = solve(constrain(degenerate.doc, 'parallel', degenerate.idA, degenerate.idB));
    const line = solved.document.entities[degenerate.idB] as LineEntity;
    expect(line.start.every(Number.isFinite) && line.end.every(Number.isFinite)).toBe(true);
  });
});
