import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OutputShader } from 'three/examples/jsm/shaders/OutputShader.js';
import { backgroundOutputFragment, srgb } from '@ui/viewport/3d/effects/BackgroundOutputPass';

describe('background output pass', () => {
  const fragment = backgroundOutputFragment();
  it('composites the background after the tone mapping and sRGB transfer of three output shader', () => {
    expect(fragment).toContain('uniform vec3 backgroundColor;');
    expect(fragment).not.toContain('gl_FragColor = texture2D( tDiffuse, vUv );');
    expect(fragment.indexOf('ACESFilmicToneMapping( gl_FragColor.rgb )')).toBeLessThan(fragment.indexOf('mix( backgroundColor'));
    expect(fragment.indexOf('sRGBTransferOETF')).toBeLessThan(fragment.indexOf('mix( backgroundColor'));
    expect(fragment.trimEnd().endsWith('}')).toBe(true);
    expect(fragment.length).toBeGreaterThan(OutputShader.fragmentShader.length);
  });
  it('hands the shader the sRGB values of a linear working-space colour', () => {
    const [r, g, b] = srgb(new THREE.Color('#eceef2'));
    expect(r).toBeCloseTo(0xec / 255, 2);
    expect(g).toBeCloseTo(0xee / 255, 2);
    expect(b).toBeCloseTo(0xf2 / 255, 2);
  });
});
