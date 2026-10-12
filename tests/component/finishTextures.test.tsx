/**
 * Viewport finish textures: the hook builds three.js DataTextures from the core procedural maps
 * (repeat-wrapped, sRGB albedo) and disposes them when the finish changes; applyBoxUvs writes a
 * box-projected uv attribute. WebGL does not run in jsdom, so we check the three.js objects.
 *
 * @layer tests/component
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as THREE from 'three';
import type { Material } from '@core/model/types';
import { applyBoxUvs, useFinishTextures } from '@ui/viewport/3d/useFinishTextures';

const carbon: Material = {
  name: 'carbon',
  density: 0.0016,
  color: '#16181b',
  metalness: 0.2,
  roughness: 0.35,
  finish: { pattern: 'carbon_twill', scale: 20, clearcoat: 1, normalStrength: 1.5 },
};

describe('useFinishTextures', () => {
  it('builds repeat-wrapped maps and disposes them when the material changes', () => {
    const { result, rerender } = renderHook(({ material }) => useFinishTextures(material), {
      initialProps: { material: carbon as Material | undefined },
    });
    const first = result.current;
    expect(first).not.toBeNull();
    expect(first?.map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(first?.normalMap.wrapS).toBe(THREE.RepeatWrapping);
    expect(first?.clearcoat).toBe(1);
    expect(first?.normalScale).toBe(1.5);
    let disposed = 0;
    first?.map.addEventListener('dispose', () => disposed++);
    rerender({ material: undefined });
    expect(result.current).toBeNull();
    expect(disposed).toBe(1);
  });

  it('applyBoxUvs projects each vertex on its dominant normal plane', () => {
    const geometry = new THREE.BoxGeometry(40, 20, 10);
    applyBoxUvs(geometry, 20);
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(normal.getZ(i)) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(position.getX(i) / 20, 6);
        expect(uv.getY(i)).toBeCloseTo(position.getY(i) / 20, 6);
      }
    }
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    applyBoxUvs(bare, 1);
    expect(bare.getAttribute('uv').count).toBe(3);
  });
});
