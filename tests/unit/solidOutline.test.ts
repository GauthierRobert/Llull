import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Entity, Vec2 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  convexHull,
  ringsDistSq,
  ringsToSegmentPositions,
  solidOutline,
} from '../../src/ui/viewport/2d/solidOutline';
import { entitiesInBox } from '../../src/ui/viewport/2d/boxSelect';
import { nearestEntityId } from '../../src/ui/viewport/2d/modifyHelpers';

function add(doc: CadDocument, name: string, params: unknown): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] as string };
}

const extent = (ring: ReadonlyArray<Vec2>): [number, number, number, number] => [
  Math.min(...ring.map((p) => p[0])),
  Math.max(...ring.map((p) => p[0])),
  Math.min(...ring.map((p) => p[1])),
  Math.max(...ring.map((p) => p[1])),
];

const outlineOf = (doc: CadDocument, id: string): ReadonlyArray<Vec2>[] =>
  solidOutline(doc, doc.entities[id] as Entity) as ReadonlyArray<Vec2>[];

describe('convexHull', () => {
  it('drops interior and collinear points', () => {
    const hull = convexHull([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [2, 2],
      [2, 0],
    ]);
    expect(hull).toHaveLength(4);
  });
});

describe('solidOutline — exact upright outlines', () => {
  it('draws a cylinder as a circle of its radius around its position', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', {
      radius: 3,
      height: 2,
      position: [10, 5, 0],
    });
    const [ring] = outlineOf(doc, id);
    const [minX, maxX, minY, maxY] = extent(ring as Vec2[]);
    expect([minX, maxX, minY, maxY].map((v) => Math.round(v * 1000) / 1000)).toEqual([7, 13, 2, 8]);
    expect((ring as Vec2[]).length).toBeGreaterThanOrEqual(32);
  });

  it('draws a sphere as a circle and a cone by its base circle', () => {
    const sphere = add(createEmptyDocument(), 'add_sphere', { radius: 2, position: [0, 0, 0] });
    const [sRing] = outlineOf(sphere.doc, sphere.id);
    const [minX, maxX] = extent(sRing as Vec2[]);
    expect(maxX - minX).toBeCloseTo(4);
    const cone = add(createEmptyDocument(), 'add_cone', {
      radius: 3,
      height: 5,
      position: [0, 0, 0],
    });
    const [cRing] = outlineOf(cone.doc, cone.id);
    expect(extent(cRing as Vec2[])[1]).toBeCloseTo(3);
  });

  it('draws a torus as an outer and an inner ring', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_torus', {
      ringRadius: 5,
      tubeRadius: 1,
      position: [0, 0, 0],
    });
    const rings = outlineOf(doc, id);
    expect(rings).toHaveLength(2);
    expect(extent(rings[0] as Vec2[])[1]).toBeCloseTo(6);
    expect(extent(rings[1] as Vec2[])[1]).toBeCloseTo(4);
  });

  it('honours Z rotation for a box (rotated rectangle) and an extrusion (rotated profile)', () => {
    const box = add(createEmptyDocument(), 'add_box', {
      size: [4, 2, 1],
      position: [10, 5, 0],
      rotation: [0, 0, Math.PI / 2],
    });
    const [boxRing] = outlineOf(box.doc, box.id);
    const [minX, maxX, minY, maxY] = extent(boxRing as Vec2[]);
    expect([minX, maxX, minY, maxY].map((v) => Math.round(v * 1000) / 1000)).toEqual([9, 11, 3, 7]);

    const extrusion = add(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [4, 0],
        [0, 2],
      ],
      depth: 3,
    });
    const rings = outlineOf(extrusion.doc, extrusion.id);
    expect(rings[0]).toHaveLength(3);
  });

  it('uses the hull of projected vertices for a tilted solid', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [2, 2, 2],
      position: [0, 0, 0],
      rotation: [Math.PI / 4, 0, 0],
    });
    const [ring] = outlineOf(doc, id);
    const [, , minY, maxY] = extent(ring as Vec2[]);
    // Tilting about X stretches the Y extent to 2*(cos45 + sin45)/2 = 2*sqrt(2)/... > 2.
    expect(maxY - minY).toBeGreaterThan(2.5);
  });

  it('returns null for 2D shapes', () => {
    const { doc, id } = add(createEmptyDocument(), 'draw_circle', { center: [0, 0], radius: 1 });
    expect(solidOutline(doc, doc.entities[id] as Entity)).toBeNull();
  });
});

describe('ring helpers and 2D interaction', () => {
  it('measures distance to ring segments and builds LineSegments pairs', () => {
    const square: Vec2[] = [
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ];
    expect(ringsDistSq([square], [5, 1])).toBe(1);
    expect(ringsDistSq([square], [2, 1.5])).toBeCloseTo(0.25);
    expect(ringsToSegmentPositions([square])).toHaveLength(4 * 6);
  });

  it('lets selection picking hit a cylinder outline, but not its interior', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', {
      radius: 3,
      height: 2,
      position: [0, 0, 0],
    });
    expect(nearestEntityId(doc, [3.05, 0], 0.2)).toBe(id);
    expect(nearestEntityId(doc, [0, 0], 0.2)).toBeNull();
  });

  it('includes solids in box selection (window needs the whole outline inside)', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', {
      radius: 3,
      height: 2,
      position: [0, 0, 0],
    });
    expect(entitiesInBox(doc, [-4, -4], [4, 4])).toEqual([id]);
    expect(entitiesInBox(doc, [-4, -4], [0, 0])).toEqual([]);
    expect(entitiesInBox(doc, [4, 4], [0, 0])).toEqual([id]);
  });
});
