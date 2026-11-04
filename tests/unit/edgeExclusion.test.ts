import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { hideEdgeExcluded, isEdgeExcluded } from '@ui/viewport/3d/effects/edgeExclusion';

describe('edge pass exclusion', () => {
  const solid = (): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());

  it('excludes lines, points, sprites and objects flagged noEdges, but not solids', () => {
    expect(isEdgeExcluded(new THREE.Line())).toBe(true);
    expect(isEdgeExcluded(new THREE.LineSegments())).toBe(true);
    expect(isEdgeExcluded(new THREE.Points())).toBe(true);
    expect(isEdgeExcluded(new THREE.Sprite())).toBe(true);
    const grid = solid();
    grid.userData['noEdges'] = true;
    expect(isEdgeExcluded(grid)).toBe(true);
    expect(isEdgeExcluded(solid())).toBe(false);
  });

  it('hides them for the normal render and restores exactly what it hid', () => {
    const scene = new THREE.Scene();
    const keep = solid();
    const line = new THREE.Line();
    const alreadyHidden = new THREE.Points();
    alreadyHidden.visible = false;
    scene.add(keep, line, alreadyHidden);
    const restore = hideEdgeExcluded(scene);
    expect(keep.visible).toBe(true);
    expect(line.visible).toBe(false);
    restore();
    expect(line.visible).toBe(true);
    expect(alreadyHidden.visible).toBe(false);
  });
});
