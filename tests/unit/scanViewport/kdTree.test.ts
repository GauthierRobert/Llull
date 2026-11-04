import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildKdTree } from '../../../src/ui/viewport/3d/scan/kdTree';
import { nearestScreenPoint, type SnapTile, type SnapView } from '../../../src/ui/viewport/3d/scan/pointSnap';
import { edlParams, edlShade } from '../../../src/ui/viewport/3d/scan/edlShading';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomTile(count: number, seed: number, origin: [number, number, number] = [100, 200, 5]): SnapTile {
  const next = rng(seed);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = next() * 10 - 5;
    positions[i + 1] = next() * 10 - 5;
    positions[i + 2] = next() * 10 - 5;
  }
  return { origin, positions, centre: origin, radius: 9 };
}

function viewAt(position: [number, number, number], target: [number, number, number]): SnapView {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { viewProjection: [...m.elements], renderOrigin: [0, 0, 0], width: 1000, height: 800, focalPx: 800 / (2 * Math.tan(Math.PI / 6)) };
}

const triples = (a: Float32Array): string[] =>
  Array.from({ length: a.length / 3 }, (_, i) => `${a[3 * i]},${a[3 * i + 1]},${a[3 * i + 2]}`).sort();

describe('kd-tree', () => {
  it('keeps every point exactly once', () => {
    const tile = randomTile(2_000, 1);
    const tree = buildKdTree(tile.positions);
    expect(triples(tree.positions)).toEqual(triples(tile.positions));
  });

  it('handles empty and tiny tiles', () => {
    expect(buildKdTree(new Float32Array(0)).left.length).toBe(0);
    expect(buildKdTree(Float32Array.from([1, 2, 3])).left.length).toBe(1);
  });

  it('finds the same snap point as the linear scan on random tiles, cameras and pointers', () => {
    const next = rng(42);
    let hits = 0;
    for (let trial = 0; trial < 40; trial++) {
      const tile = randomTile(1_500 + trial * 50, trial + 7);
      const tree = buildKdTree(tile.positions);
      const eye: [number, number, number] = [100 + next() * 30 - 15, 200 - 20 - next() * 10, 5 + next() * 20 - 5];
      const view = viewAt(eye, [100, 200, 5]);
      const pointer = { x: 300 + next() * 400, y: 250 + next() * 300 };
      const linear = nearestScreenPoint([tile], view, pointer, 12);
      if (linear !== null) hits++;
      expect(nearestScreenPoint([tile], view, pointer, 12, () => tree)).toEqual(linear);
    }
    expect(hits).toBeGreaterThan(10);
  });

  it('agrees when the camera is inside the tile (boxes straddle the eye plane)', () => {
    const tile = randomTile(3_000, 5);
    const tree = buildKdTree(tile.positions);
    const view = viewAt([100, 200, 5], [100, 205, 5]);
    for (const pointer of [
      { x: 500, y: 400 },
      { x: 300, y: 200 },
      { x: 900, y: 700 },
    ]) {
      expect(nearestScreenPoint([tile], view, pointer, 12, () => tree)).toEqual(nearestScreenPoint([tile], view, pointer, 12));
    }
  });
});

describe('eye-dome lighting parameters', () => {
  it('maps strength and radius to texture-space offsets and clamps them', () => {
    const p = edlParams(1000, 500, 0.4, 2);
    expect(p.texel).toEqual([0.001, 0.002]);
    expect(p.offsets).toEqual([0.002, 0, -0.002, 0, 0, 0.004, 0, -0.004]);
    expect(p.factor).toBeCloseTo(120);
    expect(edlParams(1000, 500, 99, 99).factor).toBeCloseTo(1200);
    expect(edlParams(0, 0, -1, 0).factor).toBe(0);
  });

  it('leaves flat surfaces unshaded and darkens a point behind nearer neighbours', () => {
    expect(edlShade(10, [10, 10, 10, 10], 120)).toBe(1);
    expect(edlShade(10, [0, 0, 0, 0], 120)).toBe(1);
    expect(edlShade(10, [5, 5, 5, 5], 120)).toBeLessThan(0.001);
    expect(edlShade(5, [10, 10, 10, 10], 120)).toBe(1);
  });
});
