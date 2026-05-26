/**
 * Spatial + fuzzy filter tests for `find_entities` (EN3).
 *
 * Covers: nearPoint, insideBBox, overlapsBBox, touchingId, nameFuzzy, tagFuzzy
 * and their failure/validation paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

// Helper: add a box at a given position and return its id.
function addBox(
  doc: ReturnType<typeof createEmptyDocument>,
  position: [number, number, number],
  size: [number, number, number] = [2, 2, 2],
): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const r = execute(doc, 'add_box', { size, position });
  return { doc: r.document, id: r.affected[0] as string };
}

describe('find_entities — spatial & fuzzy filters (EN3)', () => {
  beforeEach(() => __resetIdCounter());

  // -----------------------------------------------------------------------
  // nearPoint
  // -----------------------------------------------------------------------

  describe('nearPoint', () => {
    it('returns only entities whose bbox centroid is within radius of point', () => {
      let doc = createEmptyDocument();
      // Box A: centroid at origin (size 2x2x2 → bbox [-1,-1,-1] to [1,1,1], centroid [0,0,0])
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      // Box B: centroid at [20,0,0] — far away
      const b = addBox(doc, [20, 0, 0]);
      doc = b.doc;

      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, 0, 0], radius: 5 },
      });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(a.id);
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('includes entities whose centroid is exactly at the radius boundary', () => {
      let doc = createEmptyDocument();
      // Box centroid at [5, 0, 0]; radius = 5 → dist = exactly 5
      const a = addBox(doc, [5, 0, 0], [0.001, 0.001, 0.001]);
      doc = a.doc;

      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, 0, 0], radius: 5 },
      });
      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('returns no-op when radius <= 0', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, 0, 0], radius: 0 },
      });

      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('radius');
    });

    it('returns no-op when radius is negative', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, 0, 0], radius: -1 },
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('radius');
    });

    it('returns no-op when point is not a 3-array', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, 0] as unknown as [number, number, number], radius: 5 },
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('nearPoint.point');
    });

    it('returns no-op when point contains non-finite number', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, Infinity, 0], radius: 5 },
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
    });

    it('is pure — document is not mutated', () => {
      let doc = createEmptyDocument();
      doc = addBox(doc, [0, 0, 0]).doc;
      const snapshot = JSON.stringify(doc);

      execute(doc, 'find_entities', { nearPoint: { point: [0, 0, 0], radius: 10 } });

      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -----------------------------------------------------------------------
  // insideBBox
  // -----------------------------------------------------------------------

  describe('insideBBox', () => {
    it('returns entities whose AABB is fully inside the query box', () => {
      let doc = createEmptyDocument();
      // Box A: AABB [-1,-1,-1] to [1,1,1] — fits inside [-5,-5,-5] to [5,5,5]
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      // Box B: AABB [9,9,9] to [11,11,11] — outside
      const b = addBox(doc, [10, 10, 10]);
      doc = b.doc;

      const result = execute(doc, 'find_entities', {
        insideBBox: [[-5, -5, -5], [5, 5, 5]],
      });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(a.id);
    });

    it('excludes entities that merely overlap the query box', () => {
      let doc = createEmptyDocument();
      // Box centered at [4,0,0] with size [4,2,2] → AABB [2,-1,-1] to [6,1,1]
      // This overlaps [-5,-5,-5] to [5,5,5] but is NOT fully inside.
      const a = addBox(doc, [4, 0, 0], [4, 2, 2]);
      doc = a.doc;

      const result = execute(doc, 'find_entities', {
        insideBBox: [[-5, -5, -5], [5, 5, 5]],
      });
      const data = result.data as { count: number };
      expect(data.count).toBe(0);
    });

    it('returns no-op when insideBBox min > max on an axis', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        insideBBox: [[5, 0, 0], [0, 10, 10]],
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('insideBBox');
    });

    it('returns no-op when insideBBox is malformed (wrong length)', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        insideBBox: [[0, 0, 0]] as unknown as [[number, number, number], [number, number, number]],
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // overlapsBBox
  // -----------------------------------------------------------------------

  describe('overlapsBBox', () => {
    it('returns entities whose AABB intersects the query box', () => {
      let doc = createEmptyDocument();
      // Box A: AABB [-1,-1,-1] to [1,1,1]
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      // Box B: AABB [19,19,19] to [21,21,21]
      const b = addBox(doc, [20, 20, 20]);
      doc = b.doc;

      const result = execute(doc, 'find_entities', {
        overlapsBBox: [[-2, -2, -2], [2, 2, 2]],
      });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(a.id);
    });

    it('includes a partially overlapping entity', () => {
      let doc = createEmptyDocument();
      // Box at [4,0,0] size [4,2,2] → AABB [2,-1,-1] to [6,1,1]
      // Query box [-1,-1,-1] to [3,1,1] — overlaps from x=2 to x=3.
      const a = addBox(doc, [4, 0, 0], [4, 2, 2]);
      doc = a.doc;

      const result = execute(doc, 'find_entities', {
        overlapsBBox: [[-1, -1, -1], [3, 1, 1]],
      });
      const data = result.data as { count: number };
      expect(data.count).toBe(1);
    });

    it('returns no-op when overlapsBBox min > max on an axis', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        overlapsBBox: [[0, 5, 0], [10, 0, 10]],
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('overlapsBBox');
    });

    it('returns no-op when overlapsBBox is malformed', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', {
        overlapsBBox: 'bad' as unknown as [[number, number, number], [number, number, number]],
      });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // touchingId
  // -----------------------------------------------------------------------

  describe('touchingId', () => {
    it('returns entities whose AABB overlaps the reference entity AABB', () => {
      let doc = createEmptyDocument();
      // Box A at origin: AABB [-1,-1,-1] to [1,1,1]
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      // Box B at [1.5,0,0]: AABB [0.5,-1,-1] to [2.5,1,1] — overlaps A
      const b = addBox(doc, [1.5, 0, 0]);
      doc = b.doc;
      // Box C at [20,0,0]: far away, no overlap
      const c = addBox(doc, [20, 0, 0]);
      doc = c.doc;

      const result = execute(doc, 'find_entities', { touchingId: a.id });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(b.id);
      // Reference entity itself is excluded
      expect(data.matches.map((m) => m.id)).not.toContain(a.id);
      expect(data.matches.map((m) => m.id)).not.toContain(c.id);
    });

    it('returns no-op when touchingId does not exist', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', { touchingId: 'ghost-id' });

      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('ghost-id');
    });
  });

  // -----------------------------------------------------------------------
  // nameFuzzy
  // -----------------------------------------------------------------------

  describe('nameFuzzy', () => {
    it('matches entities whose name contains the substring (case-insensitive)', () => {
      let doc = createEmptyDocument();
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      const b = addBox(doc, [5, 0, 0]);
      doc = b.doc;

      doc = execute(doc, 'set_entity_name', { id: a.id, name: 'Left WALL' }).document;
      doc = execute(doc, 'set_entity_name', { id: b.id, name: 'Right Floor' }).document;

      const result = execute(doc, 'find_entities', { nameFuzzy: 'wall' });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(a.id);
    });

    it('returns no matches when no entity name contains the substring', () => {
      let doc = createEmptyDocument();
      doc = addBox(doc, [0, 0, 0]).doc;
      // entity has no name set

      const result = execute(doc, 'find_entities', { nameFuzzy: 'anything' });
      const data = result.data as { count: number };
      expect(data.count).toBe(0);
    });

    it('does not throw and returns empty when document is empty', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'find_entities', { nameFuzzy: 'x' });
      expect(result.document).toBe(doc);
      expect((result.data as { count: number }).count).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // tagFuzzy
  // -----------------------------------------------------------------------

  describe('tagFuzzy', () => {
    it('matches entities with a tag containing the substring (case-insensitive)', () => {
      let doc = createEmptyDocument();
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      const b = addBox(doc, [5, 0, 0]);
      doc = b.doc;

      doc = execute(doc, 'set_entity_name', { id: a.id, tags: ['STRUCTURAL', 'visible'] }).document;
      doc = execute(doc, 'set_entity_name', { id: b.id, tags: ['decorative'] }).document;

      const result = execute(doc, 'find_entities', { tagFuzzy: 'struct' });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(a.id);
    });

    it('matches any tag in the array, not just the first', () => {
      let doc = createEmptyDocument();
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      doc = execute(doc, 'set_entity_name', { id: a.id, tags: ['alpha', 'BetaGamma'] }).document;

      const result = execute(doc, 'find_entities', { tagFuzzy: 'betagamma' });
      expect((result.data as { count: number }).count).toBe(1);
    });

    it('returns no matches when no tag contains the substring', () => {
      let doc = createEmptyDocument();
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      doc = execute(doc, 'set_entity_name', { id: a.id, tags: ['foo'] }).document;

      const result = execute(doc, 'find_entities', { tagFuzzy: 'bar' });
      expect((result.data as { count: number }).count).toBe(0);
    });

    it('returns no matches for entities without any tags', () => {
      let doc = createEmptyDocument();
      doc = addBox(doc, [0, 0, 0]).doc;

      const result = execute(doc, 'find_entities', { tagFuzzy: 'anything' });
      expect((result.data as { count: number }).count).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Combined filters (AND semantics)
  // -----------------------------------------------------------------------

  describe('combined filters', () => {
    it('ANDs nearPoint with kind filter', () => {
      let doc = createEmptyDocument();
      // Box at origin
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      // Sphere at origin
      const r = execute(doc, 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
      doc = r.document;

      // nearPoint radius=5 AND kind=sphere → only the sphere
      const result = execute(doc, 'find_entities', {
        nearPoint: { point: [0, 0, 0], radius: 5 },
        kind: 'sphere',
      });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(r.affected[0]);
    });

    it('ANDs nameFuzzy with tagFuzzy — must satisfy both', () => {
      let doc = createEmptyDocument();
      const a = addBox(doc, [0, 0, 0]);
      doc = a.doc;
      const b = addBox(doc, [5, 0, 0]);
      doc = b.doc;

      // Entity A: name contains "wall", tag contains "struct"
      doc = execute(doc, 'set_entity_name', { id: a.id, name: 'Left Wall', tags: ['structural'] }).document;
      // Entity B: name contains "wall" but tag does NOT contain "struct"
      doc = execute(doc, 'set_entity_name', { id: b.id, name: 'Right Wall', tags: ['decorative'] }).document;

      const result = execute(doc, 'find_entities', {
        nameFuzzy: 'wall',
        tagFuzzy: 'struct',
      });
      const data = result.data as { matches: Array<{ id: string }>; count: number };

      expect(data.count).toBe(1);
      expect(data.matches[0]!.id).toBe(a.id);
    });
  });

  // -----------------------------------------------------------------------
  // Purity (EN3 requirement: `is pure` test must hold)
  // -----------------------------------------------------------------------

  it('find_entities is pure with spatial filters — document not mutated', () => {
    let doc = createEmptyDocument();
    doc = addBox(doc, [0, 0, 0]).doc;
    doc = addBox(doc, [20, 0, 0]).doc;
    const snapshot = JSON.stringify(doc);

    execute(doc, 'find_entities', {
      nearPoint: { point: [0, 0, 0], radius: 5 },
      insideBBox: [[-10, -10, -10], [10, 10, 10]],
      overlapsBBox: [[-5, -5, -5], [5, 5, 5]],
      nameFuzzy: 'test',
      tagFuzzy: 'tag',
    });

    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
