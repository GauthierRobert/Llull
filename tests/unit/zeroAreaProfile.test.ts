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

  describe('extrude_sketch', () => {
    it('refuses a closed polyline whose points are collinear', () => {
      const line = execute(empty, 'draw_polyline', { points: collinear, closed: true });
      const result = execute(line.document, 'extrude_sketch', { id: line.affected[0]!, depth: 2 });
      expect(result.document).toBe(line.document);
      expect(result.summary).toContain('encloses no area');
    });

    it('refuses a rectangle or circle whose size collapsed to zero', () => {
      const rectangle = execute(empty, 'draw_rectangle', { width: 4, height: 3 });
      const circle = execute(rectangle.document, 'draw_circle', { center: [0, 0], radius: 2 });
      const rectangleId = rectangle.affected[0]!;
      const circleId = circle.affected[0]!;
      const collapsed = {
        ...circle.document,
        entities: {
          ...circle.document.entities,
          [rectangleId]: { ...circle.document.entities[rectangleId]!, width: 0 },
          [circleId]: { ...circle.document.entities[circleId]!, radius: 0 },
        },
      } as typeof empty;
      for (const id of [rectangleId, circleId]) {
        const result = execute(collapsed, 'extrude_sketch', { id, depth: 1 });
        expect(result.document).toBe(collapsed);
        expect(result.summary).toContain('encloses no area');
      }
    });

    it('still extrudes a proper rectangle', () => {
      const rectangle = execute(empty, 'draw_rectangle', { width: 4, height: 3 });
      const result = execute(rectangle.document, 'extrude_sketch', {
        id: rectangle.affected[0]!,
        depth: 1,
      });
      expect(result.affected).toHaveLength(1);
    });
  });
});
