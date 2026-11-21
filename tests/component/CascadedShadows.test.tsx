import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot, extend } from '@react-three/fiber';
import { cascadeNormalBias, CSM_CASCADES, csmConfigFor, csmConfigKey } from '@ui/viewport/3d/effects/csmConfig';
import { CascadeController, newReceiverMaterials } from '@ui/viewport/3d/effects/CascadeController';
import { computeKeyLightRig } from '@ui/viewport/3d/keyLightRig';
import { SceneLighting } from '@ui/viewport/3d/SceneLighting';
import { settingsFor, type RenderQualitySettings } from '@ui/viewport/3d/useRenderQuality';
import { cellDirection, cellOf, octDecode, octEncode, splitImpostors, ATLAS_GRID } from '@ui/viewport/3d/plant/impostorMath';

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

/** The tier without the parts that need a GL context (environment cube map, baked contact shadows). */
function headless(quality: RenderQualitySettings): RenderQualitySettings {
  return { ...quality, environmentEnabled: false, contactShadowsEnabled: false };
}

async function mountLighting(
  quality: RenderQualitySettings,
): Promise<{ shadowLights: () => THREE.DirectionalLight[]; root: ReturnType<typeof createRoot> }> {
  const root = createRoot(document.createElement('canvas'));
  let store!: ReturnType<typeof root.render>;
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    store = root.render(<SceneLighting quality={headless(quality)} contactShadowOpacity={0.4} groundShadowOpacity={0.3} />);
  });
  const shadowLights = (): THREE.DirectionalLight[] => {
    const found: THREE.DirectionalLight[] = [];
    store.getState().scene.traverse((o) => o instanceof THREE.DirectionalLight && o.castShadow && found.push(o));
    return found;
  };
  return { shadowLights, root };
}

describe('cascaded shadow maps by tier', () => {
  it('only the High realism tier asks for cascades', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      expect(settingsFor(tier, 'high').cascadedShadows).toBe(true);
      expect(settingsFor(tier, 'standard').cascadedShadows).toBe(false);
      expect(settingsFor(tier, 'draft').cascadedShadows).toBe(false);
    }
  });

  it('High mounts one shadow light per cascade; Standard keeps the single key light; Draft has none', async () => {
    const high = await mountLighting(settingsFor('low', 'high'));
    expect(high.shadowLights()).toHaveLength(CSM_CASCADES);
    await act(async () => high.root.unmount());

    const standard = await mountLighting(settingsFor('high', 'standard'));
    expect(standard.shadowLights()).toHaveLength(1);
    await act(async () => standard.root.unmount());

    const draft = await mountLighting(settingsFor('high', 'draft'));
    expect(draft.shadowLights()).toHaveLength(0);
    await act(async () => draft.root.unmount());
  });

  it('leaving High removes the cascade lights and restores the shader chunks', async () => {
    const before = THREE.ShaderChunk.lights_fragment_begin;
    const high = await mountLighting(settingsFor('high', 'high'));
    expect(THREE.ShaderChunk.lights_fragment_begin).not.toBe(before);
    await act(async () => high.root.unmount());
    expect(THREE.ShaderChunk.lights_fragment_begin).toBe(before);
  });
});

describe('CascadeController', () => {
  const rig = computeKeyLightRig(null, [0, 0, 0]);
  const config = csmConfigFor(rig);

  it('config is bounded and keyed by extent and direction only', () => {
    expect(config.cascades).toBe(3);
    expect(config.maxFar).toBe(rig.halfExtent * 2);
    expect(Math.hypot(...config.lightDirection)).toBeCloseTo(1, 12);
    expect(csmConfigKey(config)).toBe(csmConfigKey(csmConfigFor({ ...rig })));
    expect(cascadeNormalBias(2048, 2048)).toBeCloseTo(1.5, 12);
  });

  it('adds the lights, fits them to a moving camera, patches receivers once and removes everything on dispose', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 500);
    camera.position.set(10, -20, 15);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.receiveShadow = true;
    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShadowMaterial());
    shadowCatcher.receiveShadow = true;
    scene.add(mesh, shadowCatcher);

    const controller = new CascadeController(scene, camera, config, 1.8, 3);
    expect(controller.csm.lights).toHaveLength(3);
    expect(scene.children.filter((o) => o instanceof THREE.DirectionalLight)).toHaveLength(3);
    expect(controller.sweep()).toBe(1);
    expect(controller.sweep()).toBe(0);
    expect(controller.update()).toBe(true);
    expect(controller.update()).toBe(false);
    camera.position.x += 5;
    camera.updateMatrixWorld();
    expect(controller.update()).toBe(true);
    for (const light of controller.csm.lights) expect(light.shadow.normalBias).toBeGreaterThan(0);

    controller.dispose();
    expect(scene.children.filter((o) => o instanceof THREE.DirectionalLight)).toHaveLength(0);
    expect(controller.update()).toBe(false);
    expect((mesh.material as THREE.MeshStandardMaterial).defines?.['USE_CSM']).toBeUndefined();
  });

  it('receivers: lit materials of shadow-receiving meshes only', () => {
    const scene = new THREE.Scene();
    const lit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    lit.receiveShadow = true;
    const notReceiving = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const basic = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    basic.receiveShadow = true;
    scene.add(lit, notReceiving, basic);
    expect(newReceiverMaterials(scene, new WeakSet())).toEqual([lit.material]);
  });
});

describe('octahedral atlas maths', () => {
  it('encode and decode are inverse, cells map back to their own direction', () => {
    for (const direction of [
      [0, 0, 1],
      [0, 0, -1],
      [0.6, -0.8, 0],
      [-0.3, 0.4, -0.8660254],
    ] as const) {
      const length = Math.hypot(...direction);
      const unit: [number, number, number] = [direction[0] / length, direction[1] / length, direction[2] / length];
      const [u, v] = octEncode(unit);
      const back = octDecode(u, v);
      expect(back[0]).toBeCloseTo(unit[0], 9);
      expect(back[1]).toBeCloseTo(unit[1], 9);
      expect(back[2]).toBeCloseTo(unit[2], 9);
    }
    for (let row = 0; row < ATLAS_GRID; row++) {
      for (let column = 0; column < ATLAS_GRID; column++) expect(cellOf(cellDirection(column, row))).toEqual([column, row]);
    }
  });

  it('a prototype repeated less than the minimum never splits off', () => {
    const scene = {
      instances: [{ id: 'a', prototype: 0, materialClass: 0, aabb: { min: [0, 0, 0], max: [1, 1, 1] }, diagonal: 1.7 }],
      prototypeKeys: ['p'],
      materialClasses: [''],
      prototypeTriangles: [12],
      prototypeCounts: [2],
      hiddenCount: 0,
    } as unknown as Parameters<typeof splitImpostors>[0];
    const camera = {
      projection: 'perspective',
      eye: [1000, 0, 0],
      direction: [-1, 0, 0],
      up: [0, 0, 1],
      fovDeg: 50,
      viewHeight: 0,
      widthPx: 100,
      heightPx: 100,
    } as const;
    expect(splitImpostors(scene, [0], camera, undefined)).toEqual({ near: [0], far: [] });
    expect(splitImpostors(scene, [0], camera, undefined, 1)).toEqual({ near: [], far: [0] });
  });
});
