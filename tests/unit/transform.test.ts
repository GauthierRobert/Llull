import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument, DEFAULT_LAYER_ID } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

describe('transform commands', () => {
  beforeEach(() => __resetIdCounter());

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function docWithBox(position = [0, 0, 0] as [number, number, number]): ReturnType<typeof execute> {
    const doc = createEmptyDocument();
    return execute(doc, 'add_box', { size: [2, 4, 6], position });
  }

  // -------------------------------------------------------------------------
  // rotate_entity
  // -------------------------------------------------------------------------

  describe('rotate_entity', () => {
    it('adds the delta to the existing rotation', () => {
      const created = docWithBox();
      const id = created.affected[0]!;

      const result = execute(created.document, 'rotate_entity', {
        id,
        delta: [0.1, 0.2, 0.3],
      });

      expect(result.affected).toEqual([id]);
      const entity = result.document.entities[id]!;
      expect(entity.rotation[0]).toBeCloseTo(0.1);
      expect(entity.rotation[1]).toBeCloseTo(0.2);
      expect(entity.rotation[2]).toBeCloseTo(0.3);
    });

    it('accumulates correctly from a non-zero initial rotation', () => {
      const created = docWithBox();
      const id = created.affected[0]!;
      // First rotate
      const r1 = execute(created.document, 'rotate_entity', { id, delta: [1, 0, 0] });
      // Second rotate
      const r2 = execute(r1.document, 'rotate_entity', { id, delta: [0, 0, 0.5] });

      const entity = r2.document.entities[id]!;
      expect(entity.rotation[0]).toBeCloseTo(1);
      expect(entity.rotation[2]).toBeCloseTo(0.5);
    });

    it('does not change position or geometry', () => {
      const created = docWithBox([3, 5, 7]);
      const id = created.affected[0]!;
      const before = created.document.entities[id]!;

      const result = execute(created.document, 'rotate_entity', { id, delta: [0.5, 0, 0] });
      const after = result.document.entities[id]!;

      expect(after.position).toEqual(before.position);
      if (before.kind === 'box' && after.kind === 'box') {
        expect(after.size).toEqual(before.size);
      }
    });

    it('is a no-op for a missing id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'rotate_entity', { id: 'ghost', delta: [1, 0, 0] });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('is pure — input document is not mutated', () => {
      const created = docWithBox();
      const doc = created.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'rotate_entity', { id: created.affected[0]!, delta: [1, 2, 3] });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // scale_entity
  // -------------------------------------------------------------------------

  describe('scale_entity', () => {
    it('scales a box size by the factor', () => {
      const created = docWithBox();
      const id = created.affected[0]!;

      const result = execute(created.document, 'scale_entity', { id, factor: 2 });

      expect(result.affected).toEqual([id]);
      const entity = result.document.entities[id]!;
      expect(entity.kind).toBe('box');
      if (entity.kind === 'box') {
        expect(entity.size).toEqual([4, 8, 12]);
      }
    });

    it('scales a cylinder radius and height', () => {
      const doc = createEmptyDocument();
      // No add_cylinder command yet, so build a cylinder fixture directly.
      const cylinderId = 'cyl-test';
      const docWithCyl = {
        ...doc,
        entities: {
          [cylinderId]: {
            id: cylinderId,
            kind: 'cylinder' as const,
            radius: 3,
            height: 10,
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            layerId: DEFAULT_LAYER_ID,
            color: '#aabbcc',
          },
        },
        order: [cylinderId],
      };

      const result = execute(docWithCyl, 'scale_entity', { id: cylinderId, factor: 0.5 });
      const entity = result.document.entities[cylinderId]!;
      expect(entity.kind).toBe('cylinder');
      if (entity.kind === 'cylinder') {
        expect(entity.radius).toBeCloseTo(1.5);
        expect(entity.height).toBeCloseTo(5);
      }
    });

    it('scales a sphere radius', () => {
      const doc = createEmptyDocument();
      const sphereId = 'sph-test';
      const docWithSphere = {
        ...doc,
        entities: {
          [sphereId]: {
            id: sphereId,
            kind: 'sphere' as const,
            radius: 6,
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            layerId: DEFAULT_LAYER_ID,
            color: '#112233',
          },
        },
        order: [sphereId],
      };

      const result = execute(docWithSphere, 'scale_entity', { id: sphereId, factor: 3 });
      const entity = result.document.entities[sphereId]!;
      expect(entity.kind).toBe('sphere');
      if (entity.kind === 'sphere') {
        expect(entity.radius).toBeCloseTo(18);
      }
    });

    it('scales an extrusion profile and depth', () => {
      const doc = createEmptyDocument();
      const extResult = execute(doc, 'extrude_profile', {
        profile: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        depth: 5,
      });
      const id = extResult.affected[0]!;

      const result = execute(extResult.document, 'scale_entity', { id, factor: 2 });
      const entity = result.document.entities[id]!;
      expect(entity.kind).toBe('extrusion');
      if (entity.kind === 'extrusion') {
        expect(entity.depth).toBeCloseTo(10);
        expect(entity.profile[0]).toEqual([0, 0]);
        expect(entity.profile[1]).toEqual([2, 0]);
        expect(entity.profile[2]).toEqual([2, 2]);
        expect(entity.profile[3]).toEqual([0, 2]);
      }
    });

    it('is a no-op for a missing id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'scale_entity', { id: 'nope', factor: 2 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('is a no-op when factor <= 0', () => {
      const created = docWithBox();
      const id = created.affected[0]!;

      const zero = execute(created.document, 'scale_entity', { id, factor: 0 });
      expect(zero.affected).toHaveLength(0);
      expect(zero.document).toBe(created.document);

      const negative = execute(created.document, 'scale_entity', { id, factor: -1 });
      expect(negative.affected).toHaveLength(0);
      expect(negative.document).toBe(created.document);
    });

    it('is pure — input document is not mutated', () => {
      const created = docWithBox();
      const doc = created.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'scale_entity', { id: created.affected[0]!, factor: 3 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // mirror_entity
  // -------------------------------------------------------------------------

  describe('mirror_entity', () => {
    it('mirrors across x-axis by negating position.x', () => {
      const created = docWithBox([4, 5, 6]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'mirror_entity', { id, axis: 'x' });

      expect(result.affected).toEqual([id]);
      expect(result.document.entities[id]!.position).toEqual([-4, 5, 6]);
    });

    it('mirrors across y-axis by negating position.y', () => {
      const created = docWithBox([1, 2, 3]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'mirror_entity', { id, axis: 'y' });
      expect(result.document.entities[id]!.position).toEqual([1, -2, 3]);
    });

    it('mirrors across z-axis by negating position.z', () => {
      const created = docWithBox([1, 2, 3]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'mirror_entity', { id, axis: 'z' });
      expect(result.document.entities[id]!.position).toEqual([1, 2, -3]);
    });

    it('does not change geometry or rotation', () => {
      const created = docWithBox([5, 0, 0]);
      const id = created.affected[0]!;
      const before = created.document.entities[id]!;

      const result = execute(created.document, 'mirror_entity', { id, axis: 'x' });
      const after = result.document.entities[id]!;

      expect(after.rotation).toEqual(before.rotation);
      if (before.kind === 'box' && after.kind === 'box') {
        expect(after.size).toEqual(before.size);
      }
    });

    it('is a no-op for a missing id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'mirror_entity', { id: 'missing', axis: 'x' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('missing');
    });

    it('is a no-op for an invalid axis', () => {
      const created = docWithBox();
      const id = created.affected[0]!;

      const result = execute(created.document, 'mirror_entity', { id, axis: 'w' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(created.document);
      expect(result.summary).toContain("'w'");
    });

    it('is pure — input document is not mutated', () => {
      const created = docWithBox([1, 2, 3]);
      const doc = created.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'mirror_entity', { id: created.affected[0]!, axis: 'y' });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // array_linear
  // -------------------------------------------------------------------------

  describe('array_linear', () => {
    it('creates count-1 copies with correct positions', () => {
      const created = docWithBox([0, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_linear', {
        id,
        count: 4,
        offset: [2, 0, 0],
      });

      expect(result.affected).toHaveLength(3);
      const doc = result.document;
      // Copy k=1 at [2,0,0], k=2 at [4,0,0], k=3 at [6,0,0]
      const copy1 = doc.entities[result.affected[0]!]!;
      const copy2 = doc.entities[result.affected[1]!]!;
      const copy3 = doc.entities[result.affected[2]!]!;
      expect(copy1.position).toEqual([2, 0, 0]);
      expect(copy2.position).toEqual([4, 0, 0]);
      expect(copy3.position).toEqual([6, 0, 0]);
    });

    it('preserves the original entity at its position', () => {
      const created = docWithBox([1, 2, 3]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_linear', {
        id,
        count: 3,
        offset: [5, 0, 0],
      });

      // Original must still be at [1,2,3]
      expect(result.document.entities[id]!.position).toEqual([1, 2, 3]);
    });

    it('appends all copy ids to document.order', () => {
      const created = docWithBox([0, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_linear', {
        id,
        count: 3,
        offset: [1, 0, 0],
      });

      const order = result.document.order;
      expect(order).toContain(id);
      for (const copyId of result.affected) {
        expect(order).toContain(copyId);
      }
    });

    it('copies preserve geometry, rotation, color, and layer from the original', () => {
      const created = docWithBox([0, 0, 0]);
      const id = created.affected[0]!;
      const original = created.document.entities[id]!;

      const result = execute(created.document, 'array_linear', {
        id,
        count: 2,
        offset: [3, 0, 0],
      });

      const copy = result.document.entities[result.affected[0]!]!;
      expect(copy.kind).toBe(original.kind);
      expect(copy.rotation).toEqual(original.rotation);
      expect(copy.color).toBe(original.color);
      expect(copy.layerId).toBe(original.layerId);
      if (original.kind === 'box' && copy.kind === 'box') {
        expect(copy.size).toEqual(original.size);
      }
    });

    it('is a no-op for a missing id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'array_linear', { id: 'ghost', count: 3, offset: [1, 0, 0] });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('is a no-op when count < 2', () => {
      const created = docWithBox();
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_linear', {
        id,
        count: 1,
        offset: [1, 0, 0],
      });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(created.document);
    });

    it('is a no-op when offset contains non-finite values', () => {
      const created = docWithBox();
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_linear', {
        id,
        count: 3,
        offset: [Infinity, 0, 0],
      });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(created.document);
    });

    it('is pure — input document is not mutated', () => {
      const created = docWithBox([0, 0, 0]);
      const doc = created.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'array_linear', { id: created.affected[0]!, count: 3, offset: [2, 0, 0] });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // array_polar
  // -------------------------------------------------------------------------

  describe('array_polar', () => {
    it('creates count-1 copies for a full-circle array', () => {
      const created = docWithBox([2, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 4,
        center: [0, 0, 0],
      });

      // Original + 3 copies = 4 total
      expect(result.affected).toHaveLength(3);
    });

    it('places copies at correct positions for a full-circle 4-count array', () => {
      // Box at [2,0,0], center [0,0,0], 4 instances = step 90° each
      const created = docWithBox([2, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 4,
        center: [0, 0, 0],
      });

      const doc = result.document;
      const copy1 = doc.entities[result.affected[0]!]!; // 90°  → [0,  2, 0]
      const copy2 = doc.entities[result.affected[1]!]!; // 180° → [-2, 0, 0]
      const copy3 = doc.entities[result.affected[2]!]!; // 270° → [0, -2, 0]

      expect(copy1.position[0]).toBeCloseTo(0);
      expect(copy1.position[1]).toBeCloseTo(2);
      expect(copy2.position[0]).toBeCloseTo(-2);
      expect(copy2.position[1]).toBeCloseTo(0);
      expect(copy3.position[0]).toBeCloseTo(0);
      expect(copy3.position[1]).toBeCloseTo(-2);
    });

    it('increments rotation[2] of each copy by the step angle', () => {
      const created = docWithBox([3, 0, 0]);
      const id = created.affected[0]!;
      const step = (2 * Math.PI) / 4;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 4,
        center: [0, 0, 0],
      });

      const copy1 = result.document.entities[result.affected[0]!]!;
      expect(copy1.rotation[2]).toBeCloseTo(step);
    });

    it('preserves the original entity', () => {
      const created = docWithBox([5, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 3,
        center: [0, 0, 0],
      });

      expect(result.document.entities[id]!.position).toEqual([5, 0, 0]);
    });

    it('respects a partial sweep angle', () => {
      // Box at [1,0,0], center [0,0,0], count=3, angle=PI (180°)
      // step = PI/3 = 60°
      // copy1 at 60°, copy2 at 120°
      const created = docWithBox([1, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 3,
        center: [0, 0, 0],
        angle: Math.PI,
      });

      expect(result.affected).toHaveLength(2);
      const copy1 = result.document.entities[result.affected[0]!]!;
      expect(copy1.position[0]).toBeCloseTo(Math.cos(Math.PI / 3));
      expect(copy1.position[1]).toBeCloseTo(Math.sin(Math.PI / 3));
    });

    it('appends copy ids to document.order', () => {
      const created = docWithBox([2, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 3,
        center: [0, 0, 0],
      });

      const order = result.document.order;
      expect(order).toContain(id);
      for (const copyId of result.affected) {
        expect(order).toContain(copyId);
      }
    });

    it('is a no-op for a missing id', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'array_polar', { id: 'nope', count: 4, center: [0, 0, 0] });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('nope');
    });

    it('is a no-op when count < 2', () => {
      const created = docWithBox([2, 0, 0]);
      const id = created.affected[0]!;

      const result = execute(created.document, 'array_polar', {
        id,
        count: 1,
        center: [0, 0, 0],
      });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(created.document);
    });

    it('is pure — input document is not mutated', () => {
      const created = docWithBox([2, 0, 0]);
      const doc = created.document;
      const snapshot = JSON.stringify(doc);
      execute(doc, 'array_polar', { id: created.affected[0]!, count: 4, center: [0, 0, 0] });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });
});
