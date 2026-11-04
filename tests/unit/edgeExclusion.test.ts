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

  it('excludes a mesh with only overlay materials (not drawn, or no depth test: the TransformControls gizmo), not one with a world material among them', () => {
    const undrawn = new THREE.MeshBasicMaterial({ visible: false });
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.PlaneGeometry(), undrawn))).toBe(true);
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.PlaneGeometry(), [undrawn, undrawn]))).toBe(true);
    const pulse = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.RingGeometry(), pulse))).toBe(true);
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.RingGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 })))).toBe(
      false,
    );
    const overlay = new THREE.MeshBasicMaterial({ depthTest: false });
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.BoxGeometry(), overlay))).toBe(true);
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.PlaneGeometry(), [undrawn, overlay]))).toBe(true);
    expect(isEdgeExcluded(new THREE.Mesh(new THREE.PlaneGeometry(), [undrawn, new THREE.MeshBasicMaterial()]))).toBe(false);
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
