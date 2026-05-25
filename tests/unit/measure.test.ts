/**
 * Tests for measure.ts — read-only measurement commands.
 *
 * Every test asserts:
 *   - affected: []
 *   - document is unchanged (same reference for no-ops; same content for happy paths)
 *   - data shape matches the documented record type
 *   - summary is factual (contains the numeric result or an explanatory message)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

describe('measure commands', () => {
  beforeEach(() => __resetIdCounter());

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function addBox(
    doc: CadDocument,
    size: readonly [number, number, number] = [2, 4, 6],
  ): ReturnType<typeof execute> {
    return execute(doc, 'add_box', { size, position: [0, 0, 0] });
  }

  function addSphere(doc: CadDocument, radius = 3): ReturnType<typeof execute> {
    return execute(doc, 'add_sphere', { radius, position: [0, 0, 0] });
  }

  function addCylinder(doc: CadDocument, radius = 2, height = 5): ReturnType<typeof execute> {
    return execute(doc, 'add_cylinder', { radius, height, position: [0, 0, 0] });
  }

  // ---------------------------------------------------------------------------
  // 1. measure_distance
  // ---------------------------------------------------------------------------

  describe('measure_distance', () => {
    it('happy: point↔point distance', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_distance', {
        point1: [0, 0, 0],
        point2: [3, 4, 0],
      });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeDefined();
      const d = result.data as { distance: number; unit: string };
      expect(d.distance).toBeCloseTo(5, 10);
      expect(d.unit).toBe('mm');
      expect(result.summary).toContain('5');
    });

    it('happy: entity↔entity centroid distance', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2], position: [10, 0, 0] });
      doc = r2.document;
      const id1 = r1.affected[0]!;
      const id2 = r2.affected[0]!;

      const result = execute(doc, 'measure_distance', { entityId1: id1, entityId2: id2 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { distance: number; unit: string };
      expect(d.distance).toBeCloseTo(10, 10);
    });

    it('happy: point↔entity', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_distance', {
        point1: [0, 0, 0],
        entityId2: id,
      });
      expect(result.affected).toEqual([]);
      const d = result.data as { distance: number; unit: string };
      // centroid of box at [5,0,0] is [5,0,0]
      expect(d.distance).toBeCloseTo(5, 10);
    });

    it('failure: missing entity id returns same doc reference', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_distance', { entityId1: 'ghost', point2: [0, 0, 0] });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('ghost');
    });

    it('failure: no locations provided', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_distance', {});
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('purity: input doc not mutated', () => {
      const doc = createEmptyDocument();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'measure_distance', { point1: [0, 0, 0], point2: [1, 1, 1] });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. measure_angle
  // ---------------------------------------------------------------------------

  describe('measure_angle', () => {
    it('happy: 90° angle from three points', () => {
      const doc = createEmptyDocument();
      // Vertex at origin, arm1 along +X, arm2 along +Y → 90°
      const result = execute(doc, 'measure_angle', {
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { degrees: number; radians: number };
      expect(d.degrees).toBeCloseTo(90, 10);
      expect(d.radians).toBeCloseTo(Math.PI / 2, 10);
      expect(result.summary).toContain('90');
    });

    it('happy: 180° (collinear points)', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_angle', {
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [-1, 0, 0],
        ],
      });
      const d = result.data as { degrees: number; radians: number };
      expect(d.degrees).toBeCloseTo(180, 10);
    });

    it('happy: angle between two line entities', () => {
      let doc = createEmptyDocument();
      const l1 = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
      doc = l1.document;
      const l2 = execute(doc, 'draw_line', { start: [0, 0], end: [0, 1] });
      doc = l2.document;
      const id1 = l1.affected[0]!;
      const id2 = l2.affected[0]!;

      const result = execute(doc, 'measure_angle', { lineId1: id1, lineId2: id2 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { degrees: number; radians: number };
      expect(d.degrees).toBeCloseTo(90, 10);
    });

    it('failure: lineId1 not found', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_angle', { lineId1: 'ghost', lineId2: 'also-ghost' });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('ghost');
    });

    it('failure: entity is not a line', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const id = r.affected[0]!;
      const result = execute(doc, 'measure_angle', { lineId1: id, lineId2: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('box');
    });

    it('failure: degenerate zero-length vector', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_angle', {
        points: [
          [0, 0, 0],
          [0, 0, 0], // arm1 == vertex → zero vector
          [1, 0, 0],
        ],
      });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('failure: no params', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_angle', {});
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('purity: input doc not mutated', () => {
      const doc = createEmptyDocument();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'measure_angle', { points: [[0,0,0],[1,0,0],[0,1,0]] });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. measure_area
  // ---------------------------------------------------------------------------

  describe('measure_area', () => {
    it('happy: circle area', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_circle', { center: [0, 0], radius: 5 });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_area', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { area: number; unit: string };
      expect(d.area).toBeCloseTo(Math.PI * 25, 5);
      expect(d.unit).toBe('mm²');
    });

    it('happy: rectangle area', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_rectangle', { width: 4, height: 3 });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_area', { entityId: id });
      const d = result.data as { area: number; unit: string };
      expect(d.area).toBeCloseTo(12, 10);
    });

    it('happy: closed polyline area (unit square)', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_polyline', {
        points: [[0, 0], [1, 0], [1, 1], [0, 1]],
        closed: true,
      });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_area', { entityId: id });
      const d = result.data as { area: number; unit: string };
      expect(d.area).toBeCloseTo(1, 10);
    });

    it('happy: explicit polygon points', () => {
      const doc = createEmptyDocument();
      // right triangle with legs 3, 4 → area = 6
      const result = execute(doc, 'measure_area', {
        points: [[0, 0], [3, 0], [0, 4]],
      });
      const d = result.data as { area: number; unit: string };
      expect(d.area).toBeCloseTo(6, 10);
    });

    it('failure: open polyline', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_polyline', { points: [[0, 0], [1, 0], [1, 1]], closed: false });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_area', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('not closed');
    });

    it('failure: missing entity id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_area', { entityId: 'ghost' });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('failure: unsupported entity kind (box)', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_area', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('failure: no params', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_area', {});
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('failure: fewer than 3 explicit points', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_area', { points: [[0, 0], [1, 0]] });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('purity: input doc not mutated', () => {
      const doc = createEmptyDocument();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'measure_area', { points: [[0,0],[1,0],[0,1]] });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. measure_perimeter
  // ---------------------------------------------------------------------------

  describe('measure_perimeter', () => {
    it('happy: line length', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_line', { start: [0, 0], end: [3, 4] });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { perimeter: number; unit: string };
      expect(d.perimeter).toBeCloseTo(5, 10);
      expect(d.unit).toBe('mm');
    });

    it('happy: circle circumference', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_circle', { center: [0, 0], radius: 1 });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      const d = result.data as { perimeter: number; unit: string };
      expect(d.perimeter).toBeCloseTo(2 * Math.PI, 10);
    });

    it('happy: rectangle perimeter', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_rectangle', { width: 3, height: 4 });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      const d = result.data as { perimeter: number; unit: string };
      expect(d.perimeter).toBeCloseTo(14, 10);
    });

    it('happy: open polyline length', () => {
      let doc = createEmptyDocument();
      // 3-4-5 right triangle open: two legs = 3 + 4 = 7
      const r = execute(doc, 'draw_polyline', {
        points: [[0, 0], [3, 0], [3, 4]],
        closed: false,
      });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      const d = result.data as { perimeter: number; unit: string };
      expect(d.perimeter).toBeCloseTo(7, 10);
    });

    it('happy: closed polyline adds closing segment', () => {
      let doc = createEmptyDocument();
      // unit square: perimeter 4
      const r = execute(doc, 'draw_polyline', {
        points: [[0, 0], [1, 0], [1, 1], [0, 1]],
        closed: true,
      });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      const d = result.data as { perimeter: number; unit: string };
      expect(d.perimeter).toBeCloseTo(4, 10);
    });

    it('happy: arc length (quarter circle r=2 → π)', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_arc', {
        center: [0, 0],
        radius: 2,
        startAngle: 0,
        endAngle: Math.PI / 2,
      });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      const d = result.data as { perimeter: number; unit: string };
      expect(d.perimeter).toBeCloseTo(Math.PI, 10);
    });

    it('failure: missing entity id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_perimeter', { entityId: 'ghost' });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('ghost');
    });

    it('failure: unsupported entity kind (box)', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_perimeter', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('purity: input doc not mutated', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
      doc = r.document;
      const id = r.affected[0]!;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'measure_perimeter', { entityId: id });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. measure_bounding_box
  // ---------------------------------------------------------------------------

  describe('measure_bounding_box', () => {
    it('happy: single entity AABB', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'add_box', { size: [4, 6, 8], position: [0, 0, 0] });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_bounding_box', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { min: number[]; max: number[]; size: number[] };
      expect(d.min).toEqual([-2, -3, -4]);
      expect(d.max).toEqual([2, 3, 4]);
      expect(d.size).toEqual([4, 6, 8]);
    });

    it('happy: whole document AABB (no params)', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2], position: [10, 0, 0] });
      doc = r2.document;

      const result = execute(doc, 'measure_bounding_box', {});
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { min: number[]; max: number[]; size: number[] };
      // Combined AABB spans from [-1,-1,-1] to [11,1,1]
      expect(d.min[0]).toBeCloseTo(-1, 10);
      expect(d.max[0]).toBeCloseTo(11, 10);
      expect(d.size[0]).toBeCloseTo(12, 10);
    });

    it('happy: selection AABB', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2], position: [20, 0, 0] });
      doc = r2.document;
      const id1 = r1.affected[0]!;
      // Select only the first entity
      doc = { ...doc, selection: [id1] };

      const result = execute(doc, 'measure_bounding_box', { useSelection: true });
      const d = result.data as { min: number[]; max: number[]; size: number[] };
      // AABB of box at [0,0,0] with size [2,2,2]: min [-1,-1,-1], max [1,1,1]
      expect(d.max[0]).toBeCloseTo(1, 10);
    });

    it('failure: missing entity id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_bounding_box', { entityId: 'ghost' });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('ghost');
    });

    it('failure: empty document with no params', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_bounding_box', {});
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('empty');
    });

    it('purity: input doc not mutated', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'measure_bounding_box', { entityId: r.affected[0]! });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. measure_volume
  // ---------------------------------------------------------------------------

  describe('measure_volume', () => {
    it('happy: box volume', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc, [2, 4, 6]);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_volume', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { volume: number; unit: string };
      expect(d.volume).toBeCloseTo(48, 10);
      expect(d.unit).toBe('mm³');
      expect(result.summary).toContain('48');
    });

    it('happy: sphere volume', () => {
      let doc = createEmptyDocument();
      const r = addSphere(doc, 3);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_volume', { entityId: id });
      const d = result.data as { volume: number; unit: string };
      const expected = (4 / 3) * Math.PI * 27;
      expect(d.volume).toBeCloseTo(expected, 5);
    });

    it('happy: cylinder volume', () => {
      let doc = createEmptyDocument();
      const r = addCylinder(doc, 2, 5);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_volume', { entityId: id });
      const d = result.data as { volume: number; unit: string };
      expect(d.volume).toBeCloseTo(Math.PI * 4 * 5, 5);
    });

    it('happy: extrusion volume (unit square × depth)', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'extrude_profile', {
        profile: [[0, 0], [1, 0], [1, 1], [0, 1]],
        depth: 3,
      });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_volume', { entityId: id });
      const d = result.data as { volume: number; unit: string };
      expect(d.volume).toBeCloseTo(3, 10);
    });

    it('failure: missing entity id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'measure_volume', { entityId: 'ghost' });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('ghost');
    });

    it('failure: 2D entity (line) not a solid', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'measure_volume', { entityId: id });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('line');
    });

    it('happy: indexed unit-cube mesh → volume ≈ 1', () => {
      // 8 unique corner vertices of [0,1]³, 12 triangles (2 per face × 6 faces),
      // consistently wound outward. This exercises the INDEXED path in meshVolume.
      // The old triangle-soup formula would process only 8/3 ≈ 2 pseudo-triangles
      // and return a meaningless value; the fixed formula must return ≈ 1.
      const positions: number[] = [
        // v0..v7 — corners of unit cube [0,1]³
        0, 0, 0,  // 0
        1, 0, 0,  // 1
        1, 1, 0,  // 2
        0, 1, 0,  // 3
        0, 0, 1,  // 4
        1, 0, 1,  // 5
        1, 1, 1,  // 6
        0, 1, 1,  // 7
      ];
      const indices: number[] = [
        // -Z face (z=0, normal -Z, CCW when viewed from -Z)
        0, 2, 1,  0, 3, 2,
        // +Z face (z=1, normal +Z, CCW when viewed from +Z)
        4, 5, 6,  4, 6, 7,
        // -Y face (y=0, normal -Y)
        0, 1, 5,  0, 5, 4,
        // +Y face (y=1, normal +Y)
        3, 6, 2,  3, 7, 6,
        // -X face (x=0, normal -X)
        0, 4, 7,  0, 7, 3,
        // +X face (x=1, normal +X)
        1, 2, 6,  1, 6, 5,
      ];

      // Inject a mesh entity directly (no command creates a standalone mesh;
      // boolean commands do, but we test the volume formula here).
      const doc = createEmptyDocument();
      const meshEntity = {
        id: 'mesh-test-1',
        kind: 'mesh' as const,
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        layerId: 'layer-default',
        color: '#ffffff',
        mesh: { positions, indices },
      };
      const docWithMesh = {
        ...doc,
        entities: { ...doc.entities, 'mesh-test-1': meshEntity },
        order: [...doc.order, 'mesh-test-1'],
      };

      const result = execute(docWithMesh, 'measure_volume', { entityId: 'mesh-test-1' });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(docWithMesh);
      const d = result.data as { volume: number; unit: string };
      expect(d.volume).toBeCloseTo(1, 10);
      expect(d.unit).toBe('mm³');
      expect(result.summary).toContain('1');
    });

    it('purity: input doc not mutated', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'measure_volume', { entityId: r.affected[0]! });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. mass_properties
  // ---------------------------------------------------------------------------

  describe('mass_properties', () => {
    it('happy: steel box mass', () => {
      let doc = createEmptyDocument();
      // box 2×4×6 = volume 48 mm³; density 0.00785 g/mm³ → mass 0.3768 g
      const r = addBox(doc, [2, 4, 6]);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'mass_properties', { entityId: id, density: 0.00785 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      const d = result.data as { volume: number; density: number; mass: number; unit: string };
      expect(d.volume).toBeCloseTo(48, 10);
      expect(d.density).toBe(0.00785);
      expect(d.mass).toBeCloseTo(48 * 0.00785, 10);
      expect(d.unit).toBe('g');
      expect(result.summary).toContain('mass');
    });

    it('happy: sphere mass', () => {
      let doc = createEmptyDocument();
      const r = addSphere(doc, 3);
      doc = r.document;
      const id = r.affected[0]!;
      const density = 0.0027;

      const result = execute(doc, 'mass_properties', { entityId: id, density });
      const d = result.data as { volume: number; density: number; mass: number; unit: string };
      const expectedVolume = (4 / 3) * Math.PI * 27;
      expect(d.volume).toBeCloseTo(expectedVolume, 5);
      expect(d.mass).toBeCloseTo(expectedVolume * density, 5);
    });

    it('happy: indexed unit-cube mesh mass = volume × density', () => {
      // Same unit-cube mesh as in measure_volume. volume ≈ 1 mm³.
      const positions: number[] = [
        0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
        0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
      ];
      const indices: number[] = [
        0, 2, 1,  0, 3, 2,
        4, 5, 6,  4, 6, 7,
        0, 1, 5,  0, 5, 4,
        3, 6, 2,  3, 7, 6,
        0, 4, 7,  0, 7, 3,
        1, 2, 6,  1, 6, 5,
      ];
      const meshEntity = {
        id: 'mesh-mass-1',
        kind: 'mesh' as const,
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        layerId: 'layer-default',
        color: '#ffffff',
        mesh: { positions, indices },
      };
      const doc = createEmptyDocument();
      const docWithMesh = {
        ...doc,
        entities: { ...doc.entities, 'mesh-mass-1': meshEntity },
        order: [...doc.order, 'mesh-mass-1'],
      };
      const density = 0.00785; // steel g/mm³
      const result = execute(docWithMesh, 'mass_properties', { entityId: 'mesh-mass-1', density });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(docWithMesh);
      const d = result.data as { volume: number; density: number; mass: number; unit: string };
      expect(d.volume).toBeCloseTo(1, 10);
      expect(d.mass).toBeCloseTo(density, 10);
      expect(d.unit).toBe('g');
    });

    it('failure: entity not found', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'mass_properties', { entityId: 'ghost', density: 0.001 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('ghost');
    });

    it('failure: density <= 0', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'mass_properties', { entityId: id, density: 0 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('density');
    });

    it('failure: negative density', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'mass_properties', { entityId: id, density: -1 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('failure: 2D entity (circle) not a solid', () => {
      let doc = createEmptyDocument();
      const r = execute(doc, 'draw_circle', { center: [0, 0], radius: 5 });
      doc = r.document;
      const id = r.affected[0]!;

      const result = execute(doc, 'mass_properties', { entityId: id, density: 0.001 });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
    });

    it('purity: input doc not mutated', () => {
      let doc = createEmptyDocument();
      const r = addBox(doc);
      doc = r.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'mass_properties', { entityId: r.affected[0]!, density: 0.001 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });
});
