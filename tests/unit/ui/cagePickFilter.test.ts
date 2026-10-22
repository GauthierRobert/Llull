import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type SubdivisionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { pickCage } from '@core/geometry/subd/pick';
import { loopEdgeIds, withoutOccluded } from '@ui/viewport/3d/cage/cagePickFilter';

const made = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 1 });
const cage = made.document.entities[made.affected[0] as string] as SubdivisionEntity;

describe('withoutOccluded', () => {
  const hit = { id: 'v', index: 0, distance: 0, t: 20 };
  const face = { id: 'f', index: 0, distance: 8, point: [0, 0, 0] as const };
  it('drops vertex and edge hits behind the nearest face', () => {
    const pick = withoutOccluded({ face, vertex: hit, edge: { ...hit, a: 0, b: 1 } }, 0.5);
    expect(pick.vertex).toBeNull();
    expect(pick.edge).toBeNull();
  });
  it('keeps hits on the face, hits without t, and everything when no face is hit', () => {
    expect(withoutOccluded({ face, vertex: { ...hit, t: 8.2 }, edge: null }, 0.5).vertex).not.toBeNull();
    const noT = { id: hit.id, index: hit.index, distance: hit.distance };
    expect(withoutOccluded({ face, vertex: noT, edge: null }, 0.5).vertex).not.toBeNull();
    expect(withoutOccluded({ face: null, vertex: hit, edge: null }, 0.5).vertex).not.toBeNull();
  });
  it('culls the far corners of a real cage seen from above', () => {
    const ray = { origin: [1, 1, 10] as const, direction: [0, 0, -1] as const };
    const raw = pickCage(cage, ray, 0.1);
    expect(raw.vertex).not.toBeNull();
    const top = (cage.vertices[raw.vertex?.index ?? 0]?.[2] ?? 0) > 0;
    expect(withoutOccluded(raw, 0.2).vertex === null).toBe(!top);
  });
});

describe('loopEdgeIds', () => {
  const a = cage.elementIds.vertices;
  const edge = (i: number, j: number): string => `e:${a[i]}|${a[j]}`;
  const id = (u: number, v: number): string => {
    const [x, y] = [a[u] as string, a[v] as string];
    return x < y ? `e:${x}|${y}` : `e:${y}|${x}`;
  };
  it('returns the loop and the ring through an edge, both containing it', () => {
    const all = cage.faces.flatMap((f) => f.map((v, i) => id(v, f[(i + 1) % f.length] as number)));
    const e = all.reduce(
      (best, c) => (loopEdgeIds(cage, c, false).length > loopEdgeIds(cage, best, false).length ? c : best),
      all[0] as string,
    );
    const loop = loopEdgeIds(cage, e, false);
    const ring = loopEdgeIds(cage, e, true);
    expect(loop).toContain(e);
    expect(loop.length).toBeGreaterThan(2);
    expect(ring.length).toBeGreaterThan(2);
    expect(new Set(ring).size).toBe(ring.length);
  });
  it('is empty for unknown edges', () => {
    expect(loopEdgeIds(cage, 'bad', false)).toEqual([]);
    expect(loopEdgeIds(cage, 'e:nope|x', true)).toEqual([]);
    expect(edge(0, 1)).toContain('e:');
  });
});
