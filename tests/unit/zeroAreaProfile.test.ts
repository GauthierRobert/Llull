import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const empty = createEmptyDocument();
const collinear = [
  [0, 0],
  [5, 0],
  [10, 0],
];
const repeated = [
  [3, 3],
  [3, 3],
  [3, 3],
];
const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('profiles that enclose no area are refused', () => {
  it.each([
    ['extrude_profile', { depth: 2 }],
    ['revolve_profile', {}],
  ])('%s rejects collinear and coincident points', (name, extra) => {
    for (const profile of [collinear, repeated]) {
      const result = execute(empty, name, { profile, ...extra });
      expect(result.document).toBe(empty);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('encloses no area');
    }
  });

  it('extrude_profile still accepts a real polygon, including one with a collinear vertex', () => {
    const withMidpoint = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(execute(empty, 'extrude_profile', { profile: square, depth: 2 }).affected).toHaveLength(
      1,
    );
    expect(
      execute(empty, 'extrude_profile', { profile: withMidpoint, depth: 2 }).affected,
    ).toHaveLength(1);
  });

  it('revolve_profile still accepts a real polygon', () => {
    const profile = [
      [1, 0],
      [2, 0],
      [2, 1],
    ];
    expect(execute(empty, 'revolve_profile', { profile }).affected).toHaveLength(1);
  });

  it('a very small but proper polygon is not mistaken for flat', () => {
    const tiny = square.map(([x, y]) => [x! * 1e-6, y! * 1e-6]);
    expect(execute(empty, 'extrude_profile', { profile: tiny, depth: 1e-6 }).affected).toHaveLength(
      1,
    );
  });
});
