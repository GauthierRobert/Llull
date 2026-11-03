import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { nearestScreenPoint, projectToScreen, type SnapTile, type SnapView } from '../../../src/ui/viewport/3d/scan/pointSnap';
import { parseCloudInfo, parseTileAnswer } from '../../../src/ui/viewport/3d/scan/cloudClient';

function viewFrom(position: [number, number, number], renderOrigin: [number, number, number] = [0, 0, 0]): SnapView {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(position[0] - renderOrigin[0], position[1] - renderOrigin[1], position[2] - renderOrigin[2]);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { viewProjection: [...m.elements], renderOrigin, width: 1000, height: 1000, focalPx: 1000 / (2 * Math.tan(Math.PI / 6)) };
}

const tile = (origin: [number, number, number], points: number[], radius = 5): SnapTile => ({
  origin,
  positions: Float32Array.from(points),
  centre: origin,
  radius,
});

describe('projectToScreen', () => {
  it('puts the look-at point at the screen centre and rejects points behind the camera', () => {
    const view = viewFrom([0, -10, 0]);
    const centre = projectToScreen(view, 0, 0, 0);
    expect(centre?.x).toBeCloseTo(500, 3);
    expect(centre?.y).toBeCloseTo(500, 3);
    expect(projectToScreen(view, 0, -50, 0)).toBeNull();
  });

  it('works in render space: the document point minus the render origin is what is projected', () => {
    const view = viewFrom([1e6, 1e6 - 10, 0], [1e6, 1e6, 0]);
    expect(projectToScreen(view, 1e6, 1e6, 0)?.x).toBeCloseTo(500, 3);
  });
});

describe('nearestScreenPoint', () => {
  const view = viewFrom([0, -10, 0]);

  it('finds the point nearest to the pointer within the tolerance', () => {
    const tiles = [tile([0, 0, 0], [0.05, 0, 0, 3, 0, 3, -0.4, 0, 0])];
    const pointer = projectToScreen(view, 0, 0, 0);
    if (pointer === null) throw new Error('not visible');
    const hit = nearestScreenPoint(tiles, view, pointer, 12);
    expect(hit?.position[0]).toBeCloseTo(0.05, 5);
    expect(hit?.pixelDistance).toBeLessThan(12);
  });

  it('returns null when nothing is within the pixel tolerance', () => {
    expect(nearestScreenPoint([tile([0, 0, 0], [3, 0, 3])], view, { x: 500, y: 500 }, 12)).toBeNull();
    expect(nearestScreenPoint([], view, { x: 500, y: 500 }, 12)).toBeNull();
  });

  it('adds the tile origin back so the hit is in document coordinates', () => {
    const shifted = nearestScreenPoint([tile([0.2, 0, 0], [-0.2, 0, 0])], view, { x: 500, y: 500 }, 5);
    expect(shifted?.position[0]).toBeCloseTo(0, 5);
  });

  it('skips a tile whose bounding sphere is far from the pointer on screen', () => {
    const far = tile([4, 0, 0], [0, 0, 0], 0.1);
    expect(nearestScreenPoint([far], view, { x: 500, y: 500 }, 5)).toBeNull();
  });

  it('breaks a pixel tie in favour of the nearer point along the view axis', () => {
    const hit = nearestScreenPoint([tile([0, 0, 0], [0, 4, 0, 0, -3, 0])], view, { x: 500, y: 500 }, 5);
    expect(hit?.position[1]).toBeCloseTo(-3, 5);
  });
});

describe('cloud client parsers', () => {
  it('reads the describe_point_cloud bounds, count and attributes', () => {
    expect(parseCloudInfo({ pointCount: 5, bounds: { min: [0, 0, 0], max: [1, 2, 3] }, attributes: ['rgb', 4] })).toEqual({
      pointCount: 5,
      bounds: { min: [0, 0, 0], max: [1, 2, 3] },
      attributes: ['rgb'],
    });
    expect(parseCloudInfo({ pointCount: 5 })).toBeNull();
    expect(parseCloudInfo(null)).toBeNull();
    expect(parseCloudInfo({ pointCount: 1, bounds: { min: [0], max: [1, 1, 1] } })).toBeNull();
  });

  it('reads the query_cloud_points points, truncation and optional columns', () => {
    const answer = parseTileAnswer({ points: [1, 2, 3], truncated: true, intensity: [7] });
    expect(answer?.positions).toEqual(Float64Array.from([1, 2, 3]));
    expect(answer?.truncated).toBe(true);
    expect(answer?.attributes?.intensity).toEqual([7]);
    expect(parseTileAnswer({ points: [1, 'x'] })).toBeNull();
    expect(parseTileAnswer({ count: 0 })).toBeNull();
    expect(parseTileAnswer({ points: [] })?.attributes).toBeUndefined();
  });
});
