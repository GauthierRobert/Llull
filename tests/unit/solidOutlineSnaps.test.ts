import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, type Vec2, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { solidOutline, solidSnapPoints } from '../../src/ui/viewport/2d/solidOutline';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';

function add(doc: CadDocument, name: string, params: unknown): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] as string };
}

const entityOf = (doc: CadDocument, id: string): Entity => doc.entities[id] as Entity;
const width = (ring: ReadonlyArray<Vec2>): number =>
  Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));

describe('solidOutline — revolution and instance', () => {
  it('draws an upright full revolution as a circle (with an inner ring for a hollow profile)', () => {
    const solid = add(createEmptyDocument(), 'revolve_profile', {
      profile: [
        [2, 0],
        [3, 0],
        [3, 4],
        [2, 4],
      ],
      axis: [0, 0, 1],
      position: [10, 0, 0],
    });
    const rings = solidOutline(solid.doc, entityOf(solid.doc, solid.id)) as ReadonlyArray<Vec2>[];
    expect(rings).toHaveLength(2);
    expect(width(rings[0] as Vec2[])).toBeCloseTo(6);
    expect(width(rings[1] as Vec2[])).toBeCloseTo(4);
  });

  it('draws an instance as the union of its children outlines, placed by the instance', () => {
    let doc = add(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    const cylinder = add(doc.doc, 'add_cylinder', { radius: 1, height: 2, position: [5, 0, 0] });
    const comp = add(cylinder.doc, 'create_component', {
      name: 'Pair',
      entityIds: [doc.id, cylinder.id],
    });
    doc = comp;
    const rings = solidOutline(doc.doc, entityOf(doc.doc, doc.id)) as ReadonlyArray<Vec2>[];
    expect(rings).toHaveLength(2); // one ring per child, not a single bounding rectangle
    expect(rings.some((ring) => ring.length >= 32)).toBe(true);
  });
});

describe('solid snap points', () => {
  it('gives a circular solid a centre plus four quadrant points', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', {
      radius: 3,
      height: 2,
      position: [10, 5, 0],
    });
    const snaps = solidSnapPoints(doc, entityOf(doc, id));
    const center = snaps.find((s) => s.type === 'center');
    expect(center?.x).toBeCloseTo(10);
    expect(center?.y).toBeCloseTo(5);
    const quadrants = snaps.filter((s) => s.type === 'endpoint');
    expect(quadrants).toHaveLength(4);
    expect(Math.max(...quadrants.map((s) => s.x))).toBeCloseTo(13);
  });

  it('gives a polygonal solid its vertices and edge midpoints', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [4, 2, 1],
      position: [0, 0, 0],
    });
    const snaps = solidSnapPoints(doc, entityOf(doc, id));
    expect(snaps.filter((s) => s.type === 'endpoint')).toHaveLength(4);
    expect(snaps.filter((s) => s.type === 'midpoint')).toHaveLength(4);
  });

  it('feeds collectSnapCandidates and respects the endpoint/midpoint/centre switches', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [4, 2, 1],
      position: [0, 0, 0],
    });
    expect(id).toBeTruthy();
    const all = collectSnapCandidates(doc);
    expect(all.filter((s) => s.type === 'endpoint')).toHaveLength(4);
    const none = collectSnapCandidates(doc, { endpoints: false, midpoints: false, centers: false });
    expect(none.filter((s) => s.type !== 'perpendicular' && s.type !== 'tangent')).toHaveLength(0);
  });
});
