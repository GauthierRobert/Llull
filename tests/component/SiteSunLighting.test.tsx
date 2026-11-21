import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot, extend } from '@react-three/fiber';
import { createEmptyDocument } from '@core/model/types';
import { sunAt } from '@core/model/siteContext';
import { SceneLighting } from '@ui/viewport/3d/SceneLighting';
import { computeKeyLightRig } from '@ui/viewport/3d/keyLightRig';
import { settingsFor } from '@ui/viewport/3d/useRenderQuality';
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

async function keyLight(dateTime: string | null): Promise<THREE.DirectionalLight | undefined> {
  const site = dateTime === null ? undefined : { ...SITE, dateTime };
  useStore.setState({ document: { ...createEmptyDocument(), ...(site === undefined ? {} : { siteContext: site }) } });
  const root = createRoot(document.createElement('canvas'));
  let store!: ReturnType<typeof root.render>;
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    const quality = { ...settingsFor('high', 'standard'), environmentEnabled: false, contactShadowsEnabled: false };
    store = root.render(<SceneLighting quality={quality} contactShadowOpacity={0.4} groundShadowOpacity={0.3} />);
  });
  let found: THREE.DirectionalLight | undefined;
  // the shadow-capable key light is the one whose shadow camera the rig configures (the cool fill light is the other directional light)
  store.getState().scene.traverse((o) => {
    if (o instanceof THREE.DirectionalLight && o.color.getHexString() !== 'a8c8ff') found = o;
  });
  await act(async () => root.unmount());
  return found;
}

describe('viewport sun from the site context', () => {
  it('keeps the default light without a site context', async () => {
    const light = await keyLight(null);
    expect(light?.intensity).toBe(1.8);
    expect(light?.position.toArray()).toEqual([-4, -9, 14]);
  });

  it('aims the key light along the computed sun, rotated by the north angle', async () => {
    const dateTime = '2026-03-20T08:00:00Z';
    const light = await keyLight(dateTime);
    const sun = sunAt({ ...SITE, dateTime })!;
    expect(sun.up).toBe(true);
    const expected = computeKeyLightRig(null, [0, 0, 0], sun.direction).position;
    expect(light?.intensity).toBe(1.8);
    expect(light?.castShadow).toBe(true);
    light?.position.toArray().forEach((value, axis) => expect(value).toBeCloseTo(expected[axis]!, 6));
  });

  it('switches the key light and its shadow off when the sun is below the horizon (sky light only)', async () => {
    const light = await keyLight('2026-03-20T00:00:00Z');
    expect(light?.intensity).toBe(0);
    expect(light?.castShadow).toBe(false);
  });
});
