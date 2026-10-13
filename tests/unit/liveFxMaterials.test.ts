import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GlowTracker, hologramize, setOpacity } from '@ui/viewport/liveFx/materialFx';
import { toneColor, toneHex, toneStrength } from '@ui/viewport/liveFx/liveFxTones';

function scene(): { root: THREE.Group; solid: THREE.MeshStandardMaterial; line: THREE.LineBasicMaterial } {
  const solid = new THREE.MeshStandardMaterial({ color: '#808080', emissive: '#000000', emissiveIntensity: 1 });
  const line = new THREE.LineBasicMaterial({ color: '#ffffff' });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), solid), new THREE.Line(new THREE.BufferGeometry(), line));
  return { root, solid, line };
}

describe('GlowTracker', () => {
  it('tints emissive (solids) or colour (lines) and restores them exactly', () => {
    const { root, solid, line } = scene();
    const glow = new GlowTracker();
    glow.apply(root, toneColor('cli'), 1);
    expect(solid.emissive.getHexString()).toBe(toneColor('cli').getHexString());
    expect(solid.emissiveIntensity).toBeCloseTo(1.6);
    expect(line.color.getHexString()).not.toBe('ffffff');
    glow.apply(root, toneColor('cli'), 0.5); // re-applies from the saved original, never compounds
    expect(solid.emissiveIntensity).toBeCloseTo(1.3);
    glow.restore();
    expect(solid.emissive.getHexString()).toBe('000000');
    expect(solid.emissiveIntensity).toBe(1);
    expect(line.color.getHexString()).toBe('ffffff');
  });

  it('keeps a colour React sets mid-glow (selection, recolour) instead of restoring a stale one', () => {
    const { root, solid } = scene();
    const glow = new GlowTracker();
    glow.apply(root, toneColor('cli'), 1);
    solid.emissive.set('#ff0000'); // r3f applies a new prop value
    glow.apply(root, toneColor('cli'), 0);
    expect(solid.emissive.getHexString()).toBe('ff0000');
    glow.apply(root, toneColor('cli'), 1);
    solid.color.set('#00ff00');
    glow.restore();
    expect(solid.color.getHexString()).toBe('00ff00');
  });
});

describe('hologramize', () => {
  it('swaps in translucent, unpickable clones and leaves the originals untouched', () => {
    const { root, solid } = scene();
    const clones = hologramize(root, toneColor('mcp'));
    expect(clones).toHaveLength(2);
    const mesh = root.children[0] as THREE.Mesh;
    expect(mesh.material).not.toBe(solid);
    expect((mesh.material as THREE.Material).transparent).toBe(true);
    expect(solid.transparent).toBe(false);
    const hits: THREE.Intersection[] = [];
    mesh.raycast(new THREE.Raycaster(), hits);
    expect(hits).toHaveLength(0);
    setOpacity(clones, 0.3);
    expect(clones.every((material) => material.opacity === 0.3)).toBe(true);
  });
});

describe('liveFxTones', () => {
  it('gives each origin its own accent and softens local edits', () => {
    expect(toneHex('cli')).not.toBe(toneHex('mcp'));
    expect(toneColor('rest')).toBe(toneColor('rest'));
    expect(toneStrength('local')).toBeLessThan(toneStrength('cli'));
  });
});
