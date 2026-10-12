import { describe, it, expect } from 'vitest';
import { createEmptyDocument, is2D, is3D } from '@core/model/types';
import type {
  LineEntity,
  PolylineEntity,
  ArcEntity,
  CircleEntity,
  RectangleEntity,
  PointEntity,
} from '@core/model/types';
import { execute } from '@core/commands/registry';

function expectPure(name: string, params: unknown): void {
  const doc = createEmptyDocument();
  const snapshot = JSON.stringify(doc);
  execute(doc, name, params);
  expect(JSON.stringify(doc)).toBe(snapshot);
}

describe('2D draw commands', () => {
  // draw_polyline, open 2-point form

  describe('draw_polyline with 2 open points', () => {
    it('creates a line entity with correct geometry', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [5, 3],
        ],
      });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const entity = result.document.entities[id]! as LineEntity;
      expect(entity.kind).toBe('line');
      expect(entity.start).toEqual([0, 0]);
      expect(entity.end).toEqual([5, 3]);
      expect(result.document.order).toContain(id);
      expect(result.summary).toContain(id);
    });

    it('uses default position [0,0,0] and default color', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_polyline', {
        points: [
          [1, 2],
          [3, 4],
        ],
      });
      const id = result.affected[0]!;
      const entity = result.document.entities[id]!;
      expect(entity.position).toEqual([0, 0, 0]);
      expect(entity.color).toBe('#4a90d9');
    });

    it('accepts a custom position and color', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [1, 1],
        ],
        position: [2, 3, 4],
        color: '#ff0000',
      });
      const entity = result.document.entities[result.affected[0]!]!;
      expect(entity.position).toEqual([2, 3, 4]);
      expect(entity.color).toBe('#ff0000');
    });

    it('keeps the line id prefix, and a closed 2-point series stays a polyline', () => {
      const doc = createEmptyDocument();
      const line = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [5, 3],
        ],
      });
      expect(line.affected[0]).toMatch(/^line-/);
      const closed = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [5, 3],
        ],
        closed: true,
      });
      expect(closed.document.entities[closed.affected[0]!]!.kind).toBe('polyline');
      const three = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [5, 3],
          [6, 6],
        ],
      });
      expect(three.document.entities[three.affected[0]!]!.kind).toBe('polyline');
    });

    it('is a no-op when a point is missing', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_polyline', { points: [null, [1, 1]] });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('draw_polyline');
    });

    it('is pure — input document is not mutated', () => {
      expectPure('draw_polyline', {
        points: [
          [0, 0],
          [1, 1],
        ],
      });
    });
  });

  // draw_polyline

  describe('draw_polyline', () => {
    it('creates a polyline entity with correct geometry', () => {
      const doc = createEmptyDocument();
      const pts = [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ];
      const result = execute(doc, 'draw_polyline', { points: pts });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const entity = result.document.entities[id]! as PolylineEntity;
      expect(entity.kind).toBe('polyline');
      expect(entity.points).toHaveLength(4);
      expect(entity.points[0]).toEqual([0, 0]);
      expect(entity.points[2]).toEqual([2, 2]);
      expect(entity.closed).toBe(false);
      expect(result.document.order).toContain(id);
    });

    it('creates a closed polyline when closed=true', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        closed: true,
      });
      const entity = result.document.entities[result.affected[0]!]! as PolylineEntity;
      expect(entity.closed).toBe(true);
      expect(result.summary).toContain('closed');
    });

    it('is a no-op with fewer than 2 points', () => {
      const doc = createEmptyDocument();
      const one = execute(doc, 'draw_polyline', { points: [[0, 0]] });
      expect(one.affected).toHaveLength(0);
      expect(one.document).toBe(doc);
      expect(one.summary).toContain('draw_polyline');

      const zero = execute(doc, 'draw_polyline', { points: [] });
      expect(zero.affected).toHaveLength(0);
      expect(zero.document).toBe(doc);
    });

    it('is pure — input document is not mutated', () => {
      expectPure('draw_polyline', {
        points: [
          [0, 0],
          [1, 1],
        ],
      });
    });
  });

  // draw_arc

  describe('draw_arc', () => {
    it('creates an arc entity with correct geometry', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_arc', {
        center: [1, 2],
        radius: 5,
        startAngle: 0,
        endAngle: Math.PI,
      });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const entity = result.document.entities[id]! as ArcEntity;
      expect(entity.kind).toBe('arc');
      expect(entity.center).toEqual([1, 2]);
      expect(entity.radius).toBe(5);
      expect(entity.startAngle).toBe(0);
      expect(entity.endAngle).toBeCloseTo(Math.PI);
      expect(result.document.order).toContain(id);
      expect(result.summary).toContain(id);
      expect(result.summary).toContain('5');
    });

    it('wraps a sweep larger than 2π into (0, 2π] and keeps CCW wrap and full sweeps', () => {
      const doc = createEmptyDocument();
      const base = { center: [0, 0], radius: 2 };
      const arcOf = (result: ReturnType<typeof execute>): ArcEntity =>
        result.document.entities[result.affected[0]!] as ArcEntity;
      const over = execute(doc, 'draw_arc', { ...base, startAngle: -2.04, endAngle: 4.71 });
      expect(arcOf(over).endAngle - arcOf(over).startAngle).toBeCloseTo(6.75 - 2 * Math.PI, 9);
      expect(over.summary).toContain('wrapped');
      const overNeg = execute(doc, 'draw_arc', { ...base, startAngle: 4.71, endAngle: -2.04 });
      expect(arcOf(overNeg).endAngle - arcOf(overNeg).startAngle).toBeCloseTo(
        4 * Math.PI - 6.75,
        9,
      );
      const wrap = execute(doc, 'draw_arc', { ...base, startAngle: 5, endAngle: 1 });
      expect(arcOf(wrap)).toMatchObject({ startAngle: 5, endAngle: 1 });
      expect(wrap.summary).not.toContain('wrapped');
      const full = execute(doc, 'draw_arc', { ...base, startAngle: 0, endAngle: 2 * Math.PI });
      expect(arcOf(full).endAngle).toBeCloseTo(2 * Math.PI, 12);
      for (const turns of [2, 5]) {
        const s0 = 5.886628178167261;
        const whole = execute(doc, 'draw_arc', {
          ...base,
          startAngle: s0,
          endAngle: s0 + turns * 2 * Math.PI,
        });
        expect(arcOf(whole).endAngle - arcOf(whole).startAngle).toBeCloseTo(2 * Math.PI, 9);
      }
      const justOver = execute(doc, 'draw_arc', {
        ...base,
        startAngle: 1,
        endAngle: 1 + 2 * Math.PI + 2e-9,
      });
      expect(arcOf(justOver).endAngle - arcOf(justOver).startAngle).toBeCloseTo(2 * Math.PI, 9);
      const nan = execute(doc, 'draw_arc', { ...base, startAngle: 0, endAngle: Number.NaN });
      expect(nan.affected).toEqual([]);
    });

    it('is a no-op when radius <= 0', () => {
      const doc = createEmptyDocument();
      const zero = execute(doc, 'draw_arc', {
        center: [0, 0],
        radius: 0,
        startAngle: 0,
        endAngle: 1,
      });
      expect(zero.affected).toHaveLength(0);
      expect(zero.document).toBe(doc);
      expect(zero.summary).toContain('draw_arc');

      const neg = execute(doc, 'draw_arc', {
        center: [0, 0],
        radius: -3,
        startAngle: 0,
        endAngle: 1,
      });
      expect(neg.affected).toHaveLength(0);
      expect(neg.document).toBe(doc);
    });

    it('is pure — input document is not mutated', () => {
      expectPure('draw_arc', { center: [0, 0], radius: 3, startAngle: 0, endAngle: 1 });
    });
  });

  // draw_arc without angles (full circle)

  describe('draw_arc without angles', () => {
    it('creates a circle entity with correct geometry', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_arc', { center: [3, 4], radius: 7 });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const entity = result.document.entities[id]! as CircleEntity;
      expect(entity.kind).toBe('circle');
      expect(entity.center).toEqual([3, 4]);
      expect(entity.radius).toBe(7);
      expect(result.document.order).toContain(id);
      expect(result.summary).toContain(id);
      expect(result.summary).toContain('7');
      expect(id).toMatch(/^circ-/);
    });

    it('is a no-op when only one of startAngle / endAngle is given', () => {
      const doc = createEmptyDocument();
      const half = execute(doc, 'draw_arc', { center: [0, 0], radius: 2, startAngle: 0 });
      expect(half.affected).toHaveLength(0);
      expect(half.document).toBe(doc);
      expect(half.summary).toContain('both startAngle and endAngle');
    });

    it('is a no-op when radius <= 0', () => {
      const doc = createEmptyDocument();
      const zero = execute(doc, 'draw_arc', { center: [0, 0], radius: 0 });
      expect(zero.affected).toHaveLength(0);
      expect(zero.document).toBe(doc);
      expect(zero.summary).toContain('draw_arc');

      const neg = execute(doc, 'draw_arc', { center: [0, 0], radius: -1 });
      expect(neg.affected).toHaveLength(0);
      expect(neg.document).toBe(doc);
    });

    it('is pure — input document is not mutated', () => {
      expectPure('draw_arc', { center: [0, 0], radius: 5 });
    });
  });

  // draw_rectangle

  describe('draw_rectangle', () => {
    it('creates a rectangle entity with correct geometry', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_rectangle', { width: 10, height: 5 });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const entity = result.document.entities[id]! as RectangleEntity;
      expect(entity.kind).toBe('rectangle');
      expect(entity.width).toBe(10);
      expect(entity.height).toBe(5);
      expect(result.document.order).toContain(id);
      expect(result.summary).toContain(id);
      expect(result.summary).toContain('10');
      expect(result.summary).toContain('5');
    });

    it('is a no-op when width or height <= 0', () => {
      const doc = createEmptyDocument();
      const zeroW = execute(doc, 'draw_rectangle', { width: 0, height: 5 });
      expect(zeroW.affected).toHaveLength(0);
      expect(zeroW.document).toBe(doc);
      expect(zeroW.summary).toContain('draw_rectangle');

      const negH = execute(doc, 'draw_rectangle', { width: 3, height: -2 });
      expect(negH.affected).toHaveLength(0);
      expect(negH.document).toBe(doc);
    });

    it('is pure — input document is not mutated', () => {
      expectPure('draw_rectangle', { width: 4, height: 3 });
    });
  });

  // draw_point

  describe('draw_point', () => {
    it('creates a point entity at the given position', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_point', { position: [1, 2, 3] });

      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const entity = result.document.entities[id]! as PointEntity;
      expect(entity.kind).toBe('point');
      expect(entity.position).toEqual([1, 2, 3]);
      expect(result.document.order).toContain(id);
      expect(result.summary).toContain(id);
    });

    it('defaults to position [0,0,0] when not provided', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'draw_point', {});
      const entity = result.document.entities[result.affected[0]!]!;
      expect(entity.position).toEqual([0, 0, 0]);
    });

    it('is pure — input document is not mutated', () => {
      expectPure('draw_point', { position: [0, 0, 0] });
    });
  });

  // is2D / is3D helpers

  describe('is2D / is3D', () => {
    it('is2D returns true for all 2D shape kinds', () => {
      const doc = createEmptyDocument();

      const line = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [1, 1],
        ],
      });
      expect(is2D(line.document.entities[line.affected[0]!]!)).toBe(true);
      expect(is3D(line.document.entities[line.affected[0]!]!)).toBe(false);

      const poly = execute(doc, 'draw_polyline', {
        points: [
          [0, 0],
          [1, 1],
        ],
      });
      expect(is2D(poly.document.entities[poly.affected[0]!]!)).toBe(true);

      const arc = execute(doc, 'draw_arc', {
        center: [0, 0],
        radius: 1,
        startAngle: 0,
        endAngle: 1,
      });
      expect(is2D(arc.document.entities[arc.affected[0]!]!)).toBe(true);

      const circ = execute(doc, 'draw_arc', { center: [0, 0], radius: 2 });
      expect(is2D(circ.document.entities[circ.affected[0]!]!)).toBe(true);

      const rect = execute(doc, 'draw_rectangle', { width: 2, height: 2 });
      expect(is2D(rect.document.entities[rect.affected[0]!]!)).toBe(true);

      const pt = execute(doc, 'draw_point', { position: [0, 0, 0] });
      expect(is2D(pt.document.entities[pt.affected[0]!]!)).toBe(true);
    });

    it('is3D returns true for all 3D solid kinds, is2D returns false', () => {
      const doc = createEmptyDocument();
      const box = execute(doc, 'add_box', { size: [1, 1, 1] });
      expect(is3D(box.document.entities[box.affected[0]!]!)).toBe(true);
      expect(is2D(box.document.entities[box.affected[0]!]!)).toBe(false);
    });
  });

  // scale_entity — 2D branches

  describe('scale_entity on 2D shapes', () => {
    it('scales a line start and end points', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_polyline', {
        points: [
          [1, 2],
          [3, 4],
        ],
      });
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 2 });
      const entity = result.document.entities[id]! as LineEntity;
      expect(entity.kind).toBe('line');
      expect(entity.start).toEqual([2, 4]);
      expect(entity.end).toEqual([6, 8]);
      expect(result.affected).toEqual([id]);
    });

    it('scales a polyline points', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_polyline', {
        points: [
          [1, 0],
          [2, 0],
          [2, 1],
        ],
      });
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 3 });
      const entity = result.document.entities[id]! as PolylineEntity;
      expect(entity.points[0]).toEqual([3, 0]);
      expect(entity.points[1]).toEqual([6, 0]);
      expect(entity.points[2]).toEqual([6, 3]);
    });

    it('scales an arc center and radius', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_arc', {
        center: [2, 4],
        radius: 5,
        startAngle: 0,
        endAngle: Math.PI,
      });
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 2 });
      const entity = result.document.entities[id]! as ArcEntity;
      expect(entity.center).toEqual([4, 8]);
      expect(entity.radius).toBeCloseTo(10);
    });

    it('scales a circle center and radius', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_arc', { center: [1, 2], radius: 4 });
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 0.5 });
      const entity = result.document.entities[id]! as CircleEntity;
      expect(entity.center).toEqual([0.5, 1]);
      expect(entity.radius).toBeCloseTo(2);
    });

    it('scales a rectangle width and height', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_rectangle', { width: 4, height: 6 });
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 3 });
      const entity = result.document.entities[id]! as RectangleEntity;
      expect(entity.width).toBeCloseTo(12);
      expect(entity.height).toBeCloseTo(18);
    });

    it('scaling a point is a no-geometry-change (returns point unchanged in geometry)', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_point', { position: [1, 2, 3] });
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 5 });
      const entity = result.document.entities[id]! as PointEntity;
      expect(entity.kind).toBe('point');
      // position is not scaled (scale_entity scales local geometry, not world position)
      expect(entity.position).toEqual([1, 2, 3]);
      expect(result.affected).toEqual([id]);
    });

    it('scale_entity is pure on 2D shapes', () => {
      const doc = createEmptyDocument();
      const created = execute(doc, 'draw_arc', { center: [0, 0], radius: 3 });
      const scaledDoc = created.document;
      const snapshot = JSON.stringify(scaledDoc);
      execute(scaledDoc, 'scale_entity', { id: created.affected[0]!, factor: 2 });
      expect(JSON.stringify(scaledDoc)).toBe(snapshot);
    });
  });
});
