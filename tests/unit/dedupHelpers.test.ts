import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  flipTriangleWinding,
  orientOutward,
  signedMeshVolume,
  soupIndices,
} from '@core/geometry/meshVolume';
import { boundsDiagonalRadius, entityBounds } from '@core/geometry/bounds';
import { fitFraming } from '@core/geometry/viewFraming';
import { closedShapeArea } from '@core/geometry/shapeArea';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { segmentIntersection } from '@lib/polygon';
import { polylineLength, segmentLengths } from '@lib/polyline';
import { centroid2, lerp2 } from '@lib/vec2';
import { lerp3 } from '@lib/vec3';
import { clamp, clamp01 } from '@lib/clamp';
import { angleFromCosine, toDegrees, toRadians } from '@lib/angle';

/** Unit tetrahedron wound outward as a triangle soup. */
const SOUP_TETRA = [
  ...[0, 0, 0, 0, 1, 0, 1, 0, 0],
  ...[0, 0, 0, 1, 0, 0, 0, 0, 1],
  ...[0, 0, 0, 0, 0, 1, 0, 1, 0],
  ...[1, 0, 0, 0, 1, 0, 0, 0, 1],
];

function withMesh(positions: number[], indices: number[]): CadDocument {
  const doc = createEmptyDocument();
  const entity: Entity = {
    id: 'm1',
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
    mesh: { positions, indices },
  };
  return { ...doc, entities: { m1: entity }, order: ['m1'] };
}

describe('meshVolume helpers', () => {
  it('soupIndices numbers every corner', () => {
    expect(soupIndices([0, 0, 0, 1, 1, 1, 2, 2, 2])).toEqual([0, 1, 2]);
    expect(soupIndices([])).toEqual([]);
  });

  it('signedMeshVolume treats empty indices as a triangle soup', () => {
    const soup = signedMeshVolume(SOUP_TETRA, []);
    expect(Math.abs(soup)).toBeCloseTo(1 / 6, 10);
    expect(signedMeshVolume(SOUP_TETRA, soupIndices(SOUP_TETRA))).toBeCloseTo(soup, 12);
  });

  it('orientOutward flips inside-out meshes and leaves outward ones alone', () => {
    const outward = orientOutward(SOUP_TETRA, []);
    expect(signedMeshVolume(SOUP_TETRA, outward)).toBeGreaterThan(0);
    const reversed = [...outward];
    flipTriangleWinding(reversed);
    expect(signedMeshVolume(SOUP_TETRA, reversed)).toBeLessThan(0);
    expect(signedMeshVolume(SOUP_TETRA, orientOutward(SOUP_TETRA, reversed))).toBeGreaterThan(0);
    expect(reversed).not.toEqual(outward);
  });

  it('mass_properties measures a soup mesh (empty indices) instead of returning 0', () => {
    const doc = withMesh(SOUP_TETRA, []);
    const result = execute(doc, 'mass_properties', { entityId: 'm1' });
    expect((result.data as { volume: number }).volume).toBeCloseTo(1 / 6, 9);
  });
});

describe('polyline / clamp / angle helpers', () => {
  it('measures segments in 2D and 3D', () => {
    expect(
      segmentLengths([
        [0, 0],
        [3, 4],
        [3, 10],
      ]),
    ).toEqual([5, 6]);
    expect(
      polylineLength([
        [0, 0, 0],
        [0, 0, 2],
        [0, 3, 2],
      ]),
    ).toBe(5);
    expect(polylineLength([[1, 1]])).toBe(0);
  });

  it('clamps', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
  });

  it('converts angles', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 12);
    expect(toDegrees(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(toDegrees(Math.PI / 3, 2)).toBe(60);
    expect(angleFromCosine(1.0000001)).toBe(0);
    expect(angleFromCosine(-2)).toBeCloseTo(Math.PI, 12);
  });
});

describe('UI-shared geometry helpers', () => {
  const bounds = {
    min: [0, 0, 0] as [number, number, number],
    max: [2, 2, 2] as [number, number, number],
  };

  it('boundsDiagonalRadius is half the box diagonal', () => {
    expect(boundsDiagonalRadius(bounds)).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('fitFraming matches fit_view and widens for narrow viewports', () => {
    const square = fitFraming(bounds, 1, 1.2);
    expect(square.center).toEqual([1, 1, 1]);
    const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    const fitted = execute(box.document, 'fit_view', { direction: 'front' }).document.camera;
    const boxBounds = entityBounds(box.document.entities[box.affected[0] as string] as Entity);
    expect(fitted.distance).toBeCloseTo(fitFraming(boxBounds, 1, 1.2).distance, 9);
    expect(fitFraming(bounds, 0.5).distance).toBeGreaterThan(square.distance);
    expect(fitFraming(bounds, 2).distance).toBeCloseTo(square.distance, 12);
    expect(fitFraming(bounds, 1, 2).distance).toBeCloseTo(square.distance * (2 / 1.2), 9);
  });

  it('fitFraming gives a pointlike box a default radius', () => {
    const point = {
      min: [1, 1, 1] as [number, number, number],
      max: [1, 1, 1] as [number, number, number],
    };
    const normal = fitFraming(point, 1, 1);
    expect(normal.distance).toBeGreaterThan(0);
    expect(fitFraming(point, 1, 1, { degenerateRadius: 2 }).distance).toBeCloseTo(
      normal.distance * 2,
      9,
    );
    const tiny = {
      min: [0, 0, 0] as [number, number, number],
      max: [0.002, 0, 0] as [number, number, number],
    };
    expect(fitFraming(tiny, 1, 1, { degenerateBelow: 0 }).distance).toBeLessThan(normal.distance);
  });

  it('entityLocalToWorld rotates about the entity origin then translates', () => {
    const world = entityLocalToWorld(
      { position: [10, 0, 0], rotation: [0, 0, Math.PI / 2] },
      [1, 0, 0],
    );
    expect(world[0]).toBeCloseTo(10, 12);
    expect(world[1]).toBeCloseTo(1, 12);
    expect(world[2]).toBeCloseTo(0, 12);
  });

  it('segmentIntersection returns the crossing point or null', () => {
    expect(segmentIntersection([0, 0], [2, 2], [0, 2], [2, 0])).toEqual([1, 1]);
    expect(segmentIntersection([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
    expect(segmentIntersection([0, 0], [1, 0], [2, -1], [2, 1])).toBeNull();
  });

  it('closedShapeArea covers closed 2D kinds and rejects the rest', () => {
    let doc = createEmptyDocument();
    const make = (command: string, params: Record<string, unknown>): Entity => {
      const result = execute(doc, command, params);
      doc = result.document;
      return doc.entities[result.affected[0] as string] as Entity;
    };
    expect(
      closedShapeArea(make('draw_ellipse', { center: [0, 0], radiusX: 2, radiusY: 1 })),
    ).toBeCloseTo(2 * Math.PI, 12);
    expect(closedShapeArea(make('draw_rectangle', { width: 3, height: 2 }))).toBe(6);
    const closed = make('draw_polyline', {
      points: [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
      closed: true,
    });
    expect(closedShapeArea(closed)).toBe(6);
    const open = make('draw_polyline', {
      points: [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
      closed: false,
    });
    expect(closedShapeArea(open)).toBeNull();
    expect(closedShapeArea(make('add_box', { size: [1, 1, 1] }))).toBeNull();
  });
});

describe('measure_area via closedShapeArea', () => {
  it('measures an ellipse and still rejects open polylines and solids', () => {
    const ellipse = execute(createEmptyDocument(), 'draw_ellipse', {
      center: [0, 0],
      radiusX: 3,
      radiusY: 2,
    });
    const id = ellipse.affected[0] as string;
    const measured = execute(ellipse.document, 'measure_area', { entityId: id });
    expect((measured.data as { area: number }).area).toBeCloseTo(6 * Math.PI, 9);
    const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const rejected = execute(box.document, 'measure_area', { entityId: box.affected[0] });
    expect(rejected.data).toBeUndefined();
    expect(rejected.summary).toContain("kind 'box'");
  });
});

describe('lerp and centroid helpers', () => {
  it('interpolates and averages', () => {
    expect(lerp2([0, 0], [4, 2], 0.5)).toEqual([2, 1]);
    expect(lerp3([0, 0, 0], [2, 4, 6], 0.25)).toEqual([0.5, 1, 1.5]);
    expect(
      centroid2([
        [0, 0],
        [4, 0],
        [4, 2],
        [0, 2],
      ]),
    ).toEqual([2, 1]);
    expect(centroid2([])).toEqual([0, 0]);
  });
});
