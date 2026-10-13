/**
 * Spatial + fuzzy filter tests for `find_entities`.
 *
 * Covers: nearPoint, insideBBox, overlapsBBox, touchingId, nameFuzzy, tagFuzzy
 * and their failure/validation paths.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

type Doc = ReturnType<typeof createEmptyDocument>;
type Vec3 = [number, number, number];

/** Add boxes at the given positions (default size 2); returns the doc and ids in order. */
function addBoxes(positions: Vec3[], size: Vec3 = [2, 2, 2], start: Doc = createEmptyDocument()): { doc: Doc; ids: string[] } {
  let doc = start;
  const ids: string[] = [];
  for (const position of positions) {
    const r = execute(doc, 'add_box', { size, position });
    doc = r.document;
    ids.push(r.affected[0] as string);
  }
  return { doc, ids };
}

/** Run find_entities; returns matched ids, count and the raw result. */
function find(doc: Doc, params: Record<string, unknown>): { result: ReturnType<typeof execute>; ids: string[]; count: number } {
  const result = execute(doc, 'find_entities', params);
  const data = result.data as { matches?: Array<{ id: string }>; count: number };
  return { result, ids: (data?.matches ?? []).map((m) => m.id), count: data?.count };
}

function annotate(doc: Doc, id: string, params: Record<string, unknown>): Doc {
  return execute(doc, 'set_entity_name', { id, ...params }).document;
}

/** Two boxes 5 apart, annotated with `first` and `second`; returns the doc and the first id. */
function annotatedPair(first: Record<string, unknown>, second: Record<string, unknown>): { doc: Doc; a: string } {
  const boxes = addBoxes([
    [0, 0, 0],
    [5, 0, 0],
  ]);
  const [a, b] = boxes.ids as [string, string];
  return { doc: annotate(annotate(boxes.doc, a, first), b, second), a };
}

const box = (min: Vec3, max: Vec3): [Vec3, Vec3] => [min, max];

describe('find_entities — spatial & fuzzy filters', () => {
  describe('nearPoint', () => {
    it('returns only entities whose bbox centroid is within radius of point', () => {
      // Box A centroid at origin; box B centroid at [20,0,0] — far away
      const { doc, ids } = addBoxes([
        [0, 0, 0],
        [20, 0, 0],
      ]);
      const {
        result,
        ids: found,
        count,
      } = find(doc, {
        nearPoint: { point: [0, 0, 0], radius: 5 },
      });

      expect(count).toBe(1);
      expect(found[0]).toBe(ids[0]);
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('includes entities whose centroid is exactly at the radius boundary', () => {
      const { doc } = addBoxes([[5, 0, 0]], [0.001, 0.001, 0.001]);
      expect(find(doc, { nearPoint: { point: [0, 0, 0], radius: 5 } }).count).toBe(1);
    });

    it.each([
      ['radius <= 0', { point: [0, 0, 0], radius: 0 }, 'radius'],
      ['radius is negative', { point: [0, 0, 0], radius: -1 }, 'radius'],
      ['point is not a 3-array', { point: [0, 0], radius: 5 }, 'nearPoint.point'],
      ['point contains non-finite number', { point: [0, Infinity, 0], radius: 5 }, undefined],
    ])('returns no-op when %s', (_label, nearPoint, summaryPart) => {
      const doc = createEmptyDocument();
      const { result } = find(doc, { nearPoint });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      if (summaryPart) expect(result.summary).toContain(summaryPart);
    });

    it('is pure — document is not mutated', () => {
      const { doc } = addBoxes([[0, 0, 0]]);
      const snapshot = JSON.stringify(doc);
      find(doc, { nearPoint: { point: [0, 0, 0], radius: 10 } });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  describe('insideBBox', () => {
    it('returns entities whose AABB is fully inside the query box', () => {
      // A: AABB [-1..1] fits inside [-5..5]; B: AABB [9..11] is outside
      const { doc, ids } = addBoxes([
        [0, 0, 0],
        [10, 10, 10],
      ]);
      const { ids: found, count } = find(doc, { insideBBox: box([-5, -5, -5], [5, 5, 5]) });
      expect(count).toBe(1);
      expect(found[0]).toBe(ids[0]);
    });

    it('excludes entities that merely overlap the query box', () => {
      // Box at [4,0,0] size [4,2,2] → AABB [2,-1,-1]..[6,1,1]: overlaps but NOT fully inside.
      const { doc } = addBoxes([[4, 0, 0]], [4, 2, 2]);
      expect(find(doc, { insideBBox: box([-5, -5, -5], [5, 5, 5]) }).count).toBe(0);
    });

    it('returns no-op when insideBBox min > max on an axis', () => {
      const doc = createEmptyDocument();
      const { result } = find(doc, { insideBBox: box([5, 0, 0], [0, 10, 10]) });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('insideBBox');
    });

    it('returns no-op when insideBBox is malformed (wrong length)', () => {
      const doc = createEmptyDocument();
      const { result } = find(doc, { insideBBox: [[0, 0, 0]] });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
    });
  });

  describe('overlapsBBox', () => {
    it('returns entities whose AABB intersects the query box', () => {
      const { doc, ids } = addBoxes([
        [0, 0, 0],
        [20, 20, 20],
      ]);
      const { ids: found, count } = find(doc, { overlapsBBox: box([-2, -2, -2], [2, 2, 2]) });
      expect(count).toBe(1);
      expect(found[0]).toBe(ids[0]);
    });

    it('includes a partially overlapping entity', () => {
      // AABB [2,-1,-1]..[6,1,1]; query [-1,-1,-1]..[3,1,1] overlaps from x=2 to x=3.
      const { doc } = addBoxes([[4, 0, 0]], [4, 2, 2]);
      expect(find(doc, { overlapsBBox: box([-1, -1, -1], [3, 1, 1]) }).count).toBe(1);
    });

    it('returns no-op when overlapsBBox min > max on an axis', () => {
      const doc = createEmptyDocument();
      const { result } = find(doc, { overlapsBBox: box([0, 5, 0], [10, 0, 10]) });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('overlapsBBox');
    });

    it('returns no-op when overlapsBBox is malformed', () => {
      const doc = createEmptyDocument();
      const { result } = find(doc, { overlapsBBox: 'bad' });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
    });
  });

  describe('touchingId', () => {
    it('returns entities whose AABB overlaps the reference entity AABB', () => {
      // B at [1.5,0,0] overlaps A at origin; C at [20,0,0] is far away
      const { doc, ids } = addBoxes([
        [0, 0, 0],
        [1.5, 0, 0],
        [20, 0, 0],
      ]);
      const [a, b, c] = ids;
      const { ids: found, count } = find(doc, { touchingId: a });

      expect(count).toBe(1);
      expect(found[0]).toBe(b);
      // Reference entity itself is excluded
      expect(found).not.toContain(a);
      expect(found).not.toContain(c);
    });

    it('returns no-op when touchingId does not exist', () => {
      const doc = createEmptyDocument();
      const { result } = find(doc, { touchingId: 'ghost-id' });
      expect(result.document).toBe(doc);
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('ghost-id');
    });
  });

  describe('nameFuzzy', () => {
    it('matches entities whose name contains the substring (case-insensitive)', () => {
      const { doc, a } = annotatedPair({ name: 'Left WALL' }, { name: 'Right Floor' });

      const { ids, count } = find(doc, { nameFuzzy: 'wall' });
      expect(count).toBe(1);
      expect(ids[0]).toBe(a);
    });

    it('returns no matches when no entity name contains the substring', () => {
      const { doc } = addBoxes([[0, 0, 0]]);
      expect(find(doc, { nameFuzzy: 'anything' }).count).toBe(0);
    });

    it('does not throw and returns empty when document is empty', () => {
      const doc = createEmptyDocument();
      const { result, count } = find(doc, { nameFuzzy: 'x' });
      expect(result.document).toBe(doc);
      expect(count).toBe(0);
    });
  });

  describe('tagFuzzy', () => {
    it('matches entities with a tag containing the substring (case-insensitive)', () => {
      const { doc, a } = annotatedPair({ tags: ['STRUCTURAL', 'visible'] }, { tags: ['decorative'] });

      const { ids, count } = find(doc, { tagFuzzy: 'struct' });
      expect(count).toBe(1);
      expect(ids[0]).toBe(a);
    });

    it.each([
      ['matches any tag in the array, not just the first', ['alpha', 'BetaGamma'], 'betagamma', 1],
      ['returns no matches when no tag contains the substring', ['foo'], 'bar', 0],
    ])('%s', (_label, tags, query, expected) => {
      const boxes = addBoxes([[0, 0, 0]]);
      const doc = annotate(boxes.doc, boxes.ids[0]!, { tags });
      expect(find(doc, { tagFuzzy: query }).count).toBe(expected);
    });

    it('returns no matches for entities without any tags', () => {
      const { doc } = addBoxes([[0, 0, 0]]);
      expect(find(doc, { tagFuzzy: 'anything' }).count).toBe(0);
    });
  });

  describe('combined filters', () => {
    it('ANDs nearPoint with kind filter', () => {
      const r = execute(addBoxes([[0, 0, 0]]).doc, 'add_sphere', {
        radius: 0.5,
        position: [0, 0, 0],
      });
      // nearPoint radius=5 AND kind=sphere → only the sphere
      const { ids, count } = find(r.document, {
        nearPoint: { point: [0, 0, 0], radius: 5 },
        kind: 'sphere',
      });
      expect(count).toBe(1);
      expect(ids[0]).toBe(r.affected[0]);
    });

    it('ANDs nameFuzzy with tagFuzzy — must satisfy both', () => {
      // A: name "wall", tag "struct"; B: name "wall" but tag does NOT contain "struct"
      const { doc, a } = annotatedPair({ name: 'Left Wall', tags: ['structural'] }, { name: 'Right Wall', tags: ['decorative'] });

      const { ids, count } = find(doc, { nameFuzzy: 'wall', tagFuzzy: 'struct' });
      expect(count).toBe(1);
      expect(ids[0]).toBe(a);
    });
  });

  it('find_entities is pure with spatial filters — document not mutated', () => {
    const { doc } = addBoxes([
      [0, 0, 0],
      [20, 0, 0],
    ]);
    const snapshot = JSON.stringify(doc);

    find(doc, {
      nearPoint: { point: [0, 0, 0], radius: 5 },
      insideBBox: box([-10, -10, -10], [10, 10, 10]),
      overlapsBBox: box([-5, -5, -5], [5, 5, 5]),
      nameFuzzy: 'test',
      tagFuzzy: 'tag',
    });

    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
