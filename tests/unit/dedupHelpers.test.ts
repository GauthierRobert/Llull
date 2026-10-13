import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { flipTriangleWinding, orientOutward, signedMeshVolume, soupIndices } from '@core/geometry/meshVolume';
import { boundsDiagonalRadius, entityBounds } from '@core/geometry/bounds';
import { fitFraming } from '@core/geometry/viewFraming';
import { closedShapeArea } from '@core/geometry/shapeArea';
import { entityLocalToWorld, entityPlanPoint } from '@core/geometry/entityFrame';
import { segmentIntersection } from '@lib/polygon';
import { polylineLength, segmentLengths } from '@lib/polyline';
import { centroid2, lerp2, orient2, planPoint } from '@lib/vec2';
import { lerp3 } from '@lib/vec3';
import { clamp, clamp01 } from '@lib/clamp';
import { angleFromCosine, toDegrees, toRadians } from '@lib/angle';
import { xy, xyz } from '../helpers/xy';
import { tupleExtent } from '@lib/extent';
import { fixedNumber, roundTo } from '@lib/compactNumber';
import { polar, ellipsePoint } from '@lib/arc';
import { instanceToWorld } from '@core/geometry/instanceTransform';
import { orderedEntities } from '@core/commands/entity/entityOps';
import { docWith } from '../helpers/fixtureDocument';
import { isStringArray } from '@lib/isStringArray';
import { roundedMetres, unitsToMm } from '@aec/shared/numeric';
import { paperMap, readableDimensionLabel, svgPoints } from '@aec/shared/sheetFrame';

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
    expect(segmentLengths(xy(0, 0, 3, 4, 3, 10))).toEqual([5, 6]);
    expect(polylineLength(xyz(0, 0, 0, 0, 0, 2, 0, 3, 2))).toBe(5);
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
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [2, 2, 2] as [number, number, number] };
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
    const point = { min: [1, 1, 1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const normal = fitFraming(point, 1, 1);
    expect(normal.distance).toBeGreaterThan(0);
    expect(fitFraming(point, 1, 1, { degenerateRadius: 2 }).distance).toBeCloseTo(normal.distance * 2, 9);
    const tiny = { min: [0, 0, 0] as [number, number, number], max: [0.002, 0, 0] as [number, number, number] };
    expect(fitFraming(tiny, 1, 1, { degenerateBelow: 0 }).distance).toBeLessThan(normal.distance);
  });
  it('entityLocalToWorld rotates about the entity origin then translates', () => {
    const world = entityLocalToWorld({ position: [10, 0, 0], rotation: [0, 0, Math.PI / 2] }, [1, 0, 0]);
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
    expect(closedShapeArea(make('draw_ellipse', { center: [0, 0], radiusX: 2, radiusY: 1 }))).toBeCloseTo(2 * Math.PI, 12);
    expect(closedShapeArea(make('draw_rectangle', { width: 3, height: 2 }))).toBe(6);
    const closed = make('draw_polyline', { points: xy(0, 0, 4, 0, 4, 3), closed: true });
    expect(closedShapeArea(closed)).toBe(6);
    const open = make('draw_polyline', { points: xy(0, 0, 4, 0, 4, 3), closed: false });
    expect(closedShapeArea(open)).toBeNull();
    expect(closedShapeArea(make('add_box', { size: [1, 1, 1] }))).toBeNull();
  });
});

describe('measure_area via closedShapeArea', () => {
  it('measures an ellipse and still rejects open polylines and solids', () => {
    const ellipse = execute(createEmptyDocument(), 'draw_ellipse', { center: [0, 0], radiusX: 3, radiusY: 2 });
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
    expect(centroid2(xy(0, 0, 4, 0, 4, 2, 0, 2))).toEqual([2, 1]);
    expect(centroid2([])).toEqual([0, 0]);
  });
});

describe('second-pass core helpers', () => {
  it('tupleExtent reads component tuples and ignores a trailing partial one', () => {
    expect(tupleExtent([1, 5, -2, 3, 9], 2)).toEqual({ min: [-2, 3], max: [1, 5] });
    expect(tupleExtent([], 3)).toEqual({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  });
  it('fixedNumber drops trailing zeros; roundTo rounds to decimals', () => {
    expect(fixedNumber(1.5, 3)).toBe('1.5');
    expect(fixedNumber(2.34567, 2)).toBe('2.35');
    expect(roundTo(1.23456789, 6)).toBe(1.234568);
    expect(roundTo(-0.5, 0)).toBe(-0);
  });
  it('orient2 is positive for a left turn, negative for a right turn, zero when collinear', () => {
    expect(orient2([0, 0], [1, 0], [0, 1])).toBeGreaterThan(0);
    expect(orient2([0, 0], [1, 0], [0, -1])).toBeLessThan(0);
    expect(orient2([0, 0], [1, 1], [2, 2])).toBe(0);
  });
  it('polar places a point at radius and angle about a centre', () => {
    const [x, y] = polar([1, 2], 2, Math.PI / 2);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(4);
  });
  it('instanceToWorld scales, rotates about the origin, then translates', () => {
    expect(instanceToWorld([2, 2, 2], [0, 0, 0], [10, 0, 0])([1, 1, 1])).toEqual([12, 2, 2]);
    const [x, y, z] = instanceToWorld([1, 1, 1], [0, 0, Math.PI / 2], [0, 0, 5])([1, 0, 0]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(5);
  });
});

describe('ellipsePoint', () => {
  it('samples the axis-aligned ellipse about the centre', () => {
    expect(ellipsePoint([1, 2], 3, 5, 0)).toEqual([4, 2]);
    const [x, y] = ellipsePoint([1, 2], 3, 5, Math.PI / 2);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(7, 12);
  });
});

describe('planPoint', () => {
  it('rotates (u, v) counter-clockwise then offsets by the centre (x, y)', () => {
    const [x, y] = planPoint([10, 20, 99], Math.PI / 2, [2, 0]);
    expect(x).toBeCloseTo(10, 12);
    expect(y).toBeCloseTo(22, 12);
  });
  it('matches the inline expression bit for bit', () => {
    const angle = 0.7;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    expect(planPoint([1.1, 2.2], angle, [3.3, 4.4])).toEqual([1.1 + 3.3 * cos - 4.4 * sin, 2.2 + 3.3 * sin + 4.4 * cos]);
  });
  it('is what entityPlanPoint applies about the entity Z rotation', () => {
    const entity = { position: [5, 6, 7], rotation: [0, 0, 0.3] } as const;
    expect(entityPlanPoint(entity, [1, 2])).toEqual(planPoint(entity.position, 0.3, [1, 2]));
  });
});

describe('isStringArray', () => {
  it('accepts arrays of strings only', () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
    expect(isStringArray(undefined)).toBe(false);
  });
});

describe('sheet frame helpers', () => {
  it('svgPoints joins rounded x,y pairs with spaces', () => {
    expect(svgPoints(xy(1, 2.456, 3.001, 4))).toBe('1,2.46 3,4');
    expect(svgPoints([])).toBe('');
  });
  it('paperMap centres the model point in the viewport and flips Y', () => {
    const map = paperMap({ x: 10, y: 20, width: 100, height: 60 }, [5, 5], 2);
    expect(map([5, 5])).toEqual([60, 50]);
    expect(map([6, 7])).toEqual([62, 46]);
  });
  it('readableDimensionLabel flips upside-down text and offsets the anchor', () => {
    const up = readableDimensionLabel([0, 0], [10, 0], 1, 0);
    expect(up.angle).toBe(0);
    expect(up.middle[0]).toBeCloseTo(5, 12);
    expect(up.middle[1]).toBeCloseTo(-1.2, 12);
    // A leftward baseline reads left-to-right: the same direction as 0° (formerly reported as 360°).
    expect(readableDimensionLabel([0, 0], [10, 0], -1, 0).angle).toBe(0);
    expect(readableDimensionLabel([0, 0], [0, 10], 0, -1).angle).toBe(90);
  });
});

describe('numeric helpers', () => {
  it('roundedMetres converts mm to metres at 2 decimals', () => {
    expect(roundedMetres(1234)).toBe(1.23);
    expect(roundedMetres(0)).toBe(0);
  });
  it('unitsToMm converts document-unit lengths to millimetres', () => {
    expect(unitsToMm({ units: 'm' })(1.5)).toBe(1500);
    expect(unitsToMm({ units: 'mm' })(42)).toBe(42);
  });
});

describe('check_model positive-field table', () => {
  it('flags NaN / Infinity sizes as degenerate (previously leaked through `x <= 0`)', () => {
    for (const radius of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const doc = docWith({ id: 'c', kind: 'cylinder', radius, height: 2 });
      const data = execute(doc, 'check_model', {}).data as { issues: Array<{ code: string; entityId?: string }> };
      expect(data.issues.some((i) => i.code === 'degenerate_size' && i.entityId === 'c')).toBe(true);
    }
    const healthy = docWith({ id: 'c', kind: 'cylinder', radius: 1, height: 2 });
    const data = execute(healthy, 'check_model', {}).data as { issues: Array<{ code: string }> };
    expect(data.issues.some((i) => i.code === 'degenerate_size')).toBe(false);
  });
});

describe('orderedEntities', () => {
  it('lists entities in document order and skips dangling ids', () => {
    const doc = docWith({ id: 'b', kind: 'point' }, { id: 'a', kind: 'point' });
    expect(orderedEntities(doc).map((e) => e.id)).toEqual(['b', 'a']);
    expect(orderedEntities({ ...doc, order: ['a', 'ghost'] }).map((e) => e.id)).toEqual(['a']);
  });
});
