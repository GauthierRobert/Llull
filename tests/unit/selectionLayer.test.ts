import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SELECTION_LAYER, setOnSelectionLayer } from '@ui/viewport/3d/effects/selectionLayer';

describe('selection layer', () => {
  it('adds and removes the selection layer without touching layer 0 (drawing, raycasts, shadows)', () => {
    const mesh = new THREE.Mesh();
    const selectionOnly = new THREE.Layers();
    selectionOnly.set(SELECTION_LAYER);
    const defaultOnly = new THREE.Layers();

    setOnSelectionLayer(mesh, true);
    expect(mesh.layers.test(selectionOnly)).toBe(true);
    expect(mesh.layers.test(defaultOnly)).toBe(true);

    setOnSelectionLayer(mesh, false);
    expect(mesh.layers.test(selectionOnly)).toBe(false);
    expect(mesh.layers.test(defaultOnly)).toBe(true);
  });
});
