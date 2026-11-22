import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot, extend } from '@react-three/fiber';
import { createEmptyDocument } from '@core/model/types';
import { sunAt } from '@core/model/siteContext';
import { SKY_SUN_DISTANCE } from '@lib/preethamSky';
import { SiteSky } from '@ui/viewport/3d/SiteSky';
import { useStore } from '@ui/store';

extend(THREE as unknown as Parameters<typeof extend>[0]);

function headlessRenderer(): THREE.WebGLRenderer {
  return {
    domElement: document.createElement('canvas'),
    xr: { addEventListener: (): void => {}, removeEventListener: (): void => {}, setAnimationLoop: (): void => {}, enabled: false },
    shadowMap: {},
    setPixelRatio: (): void => {},
    setSize: (): void => {},
    render: (): void => {},
    dispose: (): void => {},
    getPixelRatio: (): number => 1,
  } as unknown as THREE.WebGLRenderer;
}

const SITE = { latitudeDeg: 0, longitudeDeg: 0, northAngleDeg: 0 };

async function skyObject(dateTime: string | null): Promise<THREE.Mesh | undefined> {
  const site = dateTime === null ? undefined : { ...SITE, dateTime };
  useStore.setState({ document: { ...createEmptyDocument(), ...(site === undefined ? {} : { siteContext: site }) } });
  const root = createRoot(document.createElement('canvas'));
  let store!: ReturnType<typeof root.render>;
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    store = root.render(<SiteSky />);
  });
  let found: THREE.Mesh | undefined;
  store.getState().scene.traverse((o) => {
    if ((o as { isSky?: boolean }).isSky === true) found = o as THREE.Mesh;
  });
  await act(async () => root.unmount());
  return found;
}

describe('viewport sky from the site context', () => {
  it('adds no sky without a site context', async () => {
    expect(await skyObject(null)).toBeUndefined();
  });

  it('adds the three.js Sky with the computed sun, Z-up, and no clouds', async () => {
    const dateTime = '2026-03-20T08:00:00Z';
    const sky = await skyObject(dateTime);
    const sun = sunAt({ ...SITE, dateTime })!;
    const material = sky!.material as THREE.ShaderMaterial;
    const position = material.uniforms['sunPosition']!.value as THREE.Vector3;
    expect(position.x).toBeCloseTo(sun.direction[0] * SKY_SUN_DISTANCE, 3);
    expect(position.y).toBeCloseTo(sun.direction[2] * SKY_SUN_DISTANCE, 3);
    expect(position.z).toBeCloseTo(sun.direction[1] * SKY_SUN_DISTANCE, 3);
    expect(material.uniforms['cloudCoverage']!.value).toBe(0);
    expect(material.fragmentShader).toContain('normalize( vWorldPosition - cameraPosition ).xzy;');
    expect(sky!.userData['noEdges']).toBe(true);
  });

  it('keeps the sky below the horizon (the model draws its night colour)', async () => {
    expect(await skyObject('2026-03-20T00:00:00Z')).toBeDefined();
  });
});
