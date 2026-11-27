import { ensureBvhSetup } from '@ui/viewport/3d/bvhSetup';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BoxEntity, CameraEntity, Entity, LightEntity, SphereEntity } from '@core/model/types';
import type { TextureRecord } from '@core/model/appearance';
import { useStore } from '@ui/store';
import { SOLID_MESHES } from '@ui/viewport/3d/entities/solidMeshes';
import { LightObject } from '@ui/viewport/3d/lights/LightObject';
import { CameraObject } from '@ui/viewport/3d/lights/CameraObject';
import { HdrEnvironment } from '@ui/viewport/3d/appearance/HdrEnvironment';
import { SceneEnvironment } from '@ui/viewport/3d/appearance/SceneEnvironment';
import { environmentLook } from '@ui/viewport/3d/appearance/environmentPlan';
import { resetImageTextureCache } from '@ui/viewport/3d/appearance/imageTextureCache';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { mountScene, documentOf } from '../helpers/headlessScene';

const base = { rotation: [0, 0, 0], layerId: 'layer-default', color: '#c8553d' } as const;
const box = (extra: Partial<BoxEntity> = {}): BoxEntity => ({
  ...base,
  id: 'box-1',
  kind: 'box',
  position: [0, 0, 0],
  size: [2, 2, 2],
  ...extra,
});
const sphere = (extra: Partial<SphereEntity> = {}): SphereEntity => ({
  ...base,
  id: 'sph-1',
  kind: 'sphere',
  position: [0, 0, 0],
  radius: 1,
  ...extra,
});
const light = (id: string, extra: Partial<LightEntity> = {}): LightEntity => ({
  ...base,
  id,
  kind: 'light',
  position: [1, 2, 3],
  lightType: 'point',
  intensity: 100,
  lightColor: '#ffd9a8',
  radius: 0,
  castShadows: false,
  ...extra,
});
const camera = (extra: Partial<CameraEntity> = {}): CameraEntity => ({
  ...base,
  id: 'cam-1',
  kind: 'camera',
  position: [5, 0, 2],
  focalLength: 50,
  sensorWidth: 36,
  sensorHeight: 24,
  focusDistance: 4,
  ...extra,
});
const texture = (id: string, key: string, format: TextureRecord['format'] = 'png'): TextureRecord => ({
  id,
  name: `${id}.${format}`,
  key,
  format,
  width: 2,
  height: 2,
  bytes: 4,
  colorSpace: 'srgb',
});

ensureBvhSetup();

const noop = (): void => undefined;
const BoxMesh = SOLID_MESHES.box as (props: {
  entity: BoxEntity;
  selected: boolean;
  onSelect: typeof noop;
  pbrMaterial?: object;
}) => React.ReactElement;
const SphereMesh = SOLID_MESHES.sphere as (props: { entity: SphereEntity; selected: boolean; onSelect: typeof noop }) => React.ReactElement;

function meshMaterial(scene: THREE.Scene, id: string): THREE.Material {
  const mesh = scene.getObjectByName(id) as THREE.Mesh | undefined;
  if (mesh === undefined) throw new Error(`no mesh ${id}`);
  return mesh.material as THREE.Material;
}

function lightsOf<T extends THREE.Light>(scene: THREE.Scene, type: abstract new (...args: never[]) => T): T[] {
  const found: T[] = [];
  scene.traverse((object) => object instanceof type && found.push(object));
  return found;
}

/** Calls the r3f `onClick` of the first object that has one (jsdom has no canvas events). */
function clickPickVolume(scene: THREE.Scene): void {
  let clicked = false;
  scene.traverse((object) => {
    const handlers = (object as unknown as { __r3f?: { props: { onClick?: (event: unknown) => void } } }).__r3f?.props;
    if (clicked || handlers?.onClick === undefined) return;
    clicked = true;
    handlers.onClick({
      stopPropagation: noop,
      point: new THREE.Vector3(),
      nativeEvent: { shiftKey: false, ctrlKey: false, metaKey: false },
    });
  });
  expect(clicked).toBe(true);
}

beforeEach(() => resetImageTextureCache(() => Promise.reject(new Error('no backend'))));
afterEach(() => resetImageTextureCache());

describe('appearance material resolution on a solid', () => {
  it('keeps the plain material for a solid without an appearance', async () => {
    documentOf([box()]);
    const { scene } = await mountScene(<BoxMesh entity={box()} selected={false} onSelect={noop} />);
    expect(meshMaterial(scene, 'box-1')).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(meshMaterial(scene, 'box-1')).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it('draws glass from an entity appearance: transmission, ior, coat', async () => {
    const glass = sphere({ appearance: { transmission: { value: 1 }, ior: 1.45, coat: { value: 0.4 }, roughness: { value: 0.05 } } });
    documentOf([glass]);
    const { scene } = await mountScene(<SphereMesh entity={glass} selected={false} onSelect={noop} />);
    const material = meshMaterial(scene, 'sph-1') as THREE.MeshPhysicalMaterial;
    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(material.transmission).toBe(1);
    expect(material.ior).toBeCloseTo(1.45);
    expect(material.clearcoat).toBeCloseTo(0.4);
    expect(material.roughness).toBeCloseTo(0.05);
    expect(material.thickness).toBeGreaterThan(0);
  });

  it('takes the material appearance, with the entity override winning per channel, and emission', async () => {
    const pbrMaterial = {
      color: '#888888',
      metalness: 0,
      roughness: 0.5,
      appearance: { baseColor: { value: '#336699' }, roughness: { value: 0.8 }, metalness: { value: 0.3 } },
    };
    const entity = box({ appearance: { roughness: { value: 0.2 }, emission: { value: '#ff0000' }, emissionStrength: 2 } });
    documentOf([entity]);
    const { scene } = await mountScene(<BoxMesh entity={entity} selected={false} onSelect={noop} pbrMaterial={pbrMaterial} />);
    const material = meshMaterial(scene, 'box-1') as THREE.MeshPhysicalMaterial;
    expect(material.color.getHexString()).toBe(new THREE.Color('#336699').getHexString());
    expect(material.roughness).toBeCloseTo(0.2);
    expect(material.metalness).toBeCloseTo(0.3);
    expect(material.emissive.getHexString()).toBe('ff0000');
    expect(material.emissiveIntensity).toBe(2);
  });

  it('loads a referenced image once, box-projects UVs, and disposes the texture with its last user', async () => {
    const loaded = new THREE.Texture();
    const requested: string[] = [];
    resetImageTextureCache((key) => {
      requested.push(key);
      return Promise.resolve(loaded);
    });
    let disposed = 0;
    loaded.addEventListener('dispose', () => (disposed += 1));
    const entity = box({ appearance: { baseColor: { texture: 't1' }, normal: { texture: 't1', normalScale: 0.5 } } });
    documentOf([entity], { appearance: { textures: { t1: texture('t1', 'a'.repeat(64)) }, textureOrder: ['t1'] } });
    const { scene, settle, unmount } = await mountScene(<BoxMesh entity={entity} selected={false} onSelect={noop} />);
    await settle();
    const material = meshMaterial(scene, 'box-1') as THREE.MeshPhysicalMaterial;
    expect(material.map).toBe(loaded);
    expect(material.normalMap).toBe(loaded);
    expect(material.normalScale.x).toBe(0.5);
    expect(material.color.getHexString()).toBe('ffffff');
    expect((scene.getObjectByName('box-1') as THREE.Mesh).geometry.getAttribute('uv')).toBeDefined();
    // Same key, two channels of different colour space: one entry each, requested once per entry.
    expect(requested).toHaveLength(2);
    await unmount();
    expect(disposed).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the material colour when the texture cannot be fetched (one warning)', async () => {
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => void warnings.push(args);
    try {
      const entity = box({ appearance: { baseColor: { texture: 't1' }, roughness: { texture: 't1' } } });
      documentOf([entity], { appearance: { textures: { t1: texture('t1', 'b'.repeat(64)) }, textureOrder: ['t1'] } });
      const { scene, settle } = await mountScene(
        <BoxMesh entity={entity} selected={false} onSelect={noop} pbrMaterial={{ color: '#112233', metalness: 0.1, roughness: 0.6 }} />,
      );
      await settle();
      const material = meshMaterial(scene, 'box-1') as THREE.MeshPhysicalMaterial;
      expect(material.map).toBeNull();
      expect(material.color.getHexString()).toBe(new THREE.Color('#112233').getHexString());
      expect(material.roughness).toBeCloseTo(0.6);
      expect(warnings.filter((args) => String(args).includes('texture unavailable'))).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });
});

describe('light entity branch', () => {
  const noShadows = (): void => undefined;
  it.each([
    ['sun', THREE.DirectionalLight],
    ['point', THREE.PointLight],
    ['spot', THREE.SpotLight],
    ['area', THREE.RectAreaLight],
  ] as const)('a %s light draws a glyph and adds its three.js light at the entity pose', async (lightType, constructor) => {
    const entity = light('l-1', { lightType, coneAngle: 1, blend: 0.3, width: 2, height: 1, rotation: [0, 0.5, 0] });
    documentOf([entity]);
    const { scene } = await mountScene(<LightObject entity={entity} selected={false} onSelect={noShadows} />);
    const [added] = lightsOf<THREE.Light>(scene, constructor);
    expect(added).toBeDefined();
    expect(added?.intensity).toBeGreaterThan(0);
    expect(added?.color.getHexString()).toBe(new THREE.Color('#ffd9a8').getHexString());
    const group = scene.getObjectByName('l-1');
    expect(group?.position.toArray()).toEqual([1, 2, 3]);
    expect(group?.rotation.y).toBeCloseTo(0.5);
    let lines = 0;
    scene.traverse((object) => object instanceof THREE.LineSegments && (lines += 1));
    expect(lines).toBe(1);
  });

  it('drives the spot light by cone and blend', async () => {
    const entity = light('s-1', { lightType: 'spot', coneAngle: 1, blend: 0.3 });
    documentOf([entity]);
    const { scene } = await mountScene(<LightObject entity={entity} selected={false} onSelect={noShadows} />);
    const [spot] = lightsOf(scene, THREE.SpotLight);
    expect(spot?.angle).toBeCloseTo(0.5);
    expect(spot?.penumbra).toBeCloseTo(0.3);
  });

  it('casts shadows only for castShadows lights, at most three', async () => {
    const entities = ['a', 'b', 'c', 'd'].map((id) => light(id, { castShadows: true }));
    const off = light('e', { castShadows: false });
    documentOf([...entities, off]);
    const { scene } = await mountScene(
      <>
        {[...entities, off].map((entity) => (
          <LightObject key={entity.id} entity={entity} selected={false} onSelect={noShadows} />
        ))}
      </>,
    );
    const casting = lightsOf(scene, THREE.PointLight).filter((l) => l.castShadow);
    expect(casting).toHaveLength(3);
  });

  it('is pickable: a click on the glyph selects the entity', async () => {
    const entity = light('l-9', { lightType: 'point' });
    documentOf([entity]);
    const picked: Array<[string, boolean]> = [];
    const { scene } = await mountScene(
      <LightObject entity={entity} selected={false} onSelect={(id, additive) => picked.push([id, additive])} />,
    );
    clickPickVolume(scene);
    expect(picked).toEqual([['l-9', false]]);
  });
});

describe('camera entity branch', () => {
  it('draws a pickable frustum glyph and no light', async () => {
    const entity = camera();
    documentOf([entity]);
    const picked: string[] = [];
    const { scene } = await mountScene(<CameraObject entity={entity} selected={false} onSelect={(id) => picked.push(id)} />);
    expect(scene.getObjectByName('cam-1')?.position.toArray()).toEqual([5, 0, 2]);
    expect(lightsOf(scene, THREE.Light)).toHaveLength(0);
    let lines = 0;
    scene.traverse((object) => object instanceof THREE.LineSegments && (lines += 1));
    expect(lines).toBe(1);
    clickPickVolume(scene);
    expect(picked).toEqual(['cam-1']);
  });
});

describe('environment branch', () => {
  it('leaves the scene as before without an environment', async () => {
    documentOf([box()]);
    const { scene } = await mountScene(<HdrEnvironment background />);
    expect(scene.environment).toBeNull();
    expect(scene.background).toBeNull();
    expect(environmentLook(undefined, '#eceef1').ambient).toBeNull();
  });

  it('adds an ambient tint for a colour environment', async () => {
    documentOf([box()], {
      appearance: { textures: {}, textureOrder: [], environment: { source: 'color', color: '#203040', intensity: 2 } },
    });
    const look = environmentLook({ source: 'color', color: '#203040', intensity: 2 }, '#fff');
    const { scene } = await mountScene(<SceneEnvironment look={look} hdrBackground={false} />);
    const [ambient] = lightsOf(scene, THREE.AmbientLight);
    expect(ambient?.color.getHexString()).toBe(new THREE.Color('#203040').getHexString());
    expect(ambient?.intensity).toBeCloseTo(0.6);
  });

  it('applies a loaded HDR as light, background, rotation and intensity, and restores the scene on unmount', async () => {
    const hdr = new THREE.DataTexture(new Float32Array(16), 2, 2, THREE.RGBAFormat, THREE.FloatType);
    resetImageTextureCache(() => Promise.resolve(hdr));
    documentOf([box()], {
      appearance: {
        textures: { h: texture('h', 'c'.repeat(64), 'hdr') },
        textureOrder: ['h'],
        environment: { source: 'hdr', texture: 'h', rotation: 0.7, intensity: 1.5 },
      },
    });
    const { scene, settle, unmount } = await mountScene(<HdrEnvironment background />);
    await settle();
    expect(scene.environment).toBe(hdr);
    expect(scene.background).toBe(hdr);
    expect(scene.environmentIntensity).toBe(1.5);
    expect(scene.environmentRotation.z).toBeCloseTo(0.7);
    await unmount();
    expect(scene.environment).toBeNull();
    expect(scene.background).toBeNull();
  });

  it('keeps the default environment and background when the HDR cannot be loaded', async () => {
    const original = console.warn;
    console.warn = noop;
    try {
      documentOf([box()], {
        appearance: {
          textures: { h: texture('h', 'd'.repeat(64), 'hdr') },
          textureOrder: ['h'],
          environment: { source: 'hdr', texture: 'h', rotation: 0, intensity: 1 },
        },
      });
      const { scene, settle } = await mountScene(<HdrEnvironment background />);
      await settle();
      expect(scene.environment).toBeNull();
      expect(scene.background).toBeNull();
    } finally {
      console.warn = original;
    }
  });
});

describe('inspector readouts', () => {
  const select = (entity: Entity): void => {
    documentOf([entity], { selection: [entity.id] });
  };
  it('shows the light fields read-only', () => {
    select(light('l-1', { lightType: 'spot', coneAngle: Math.PI / 4, blend: 0.5, castShadows: true }));
    render(<PropertiesPanel />);
    expect(screen.getByText('Light type')).toBeTruthy();
    expect(screen.getByText('spot')).toBeTruthy();
    expect(screen.getByText('Cone')).toBeTruthy();
    expect(screen.getByText('cast')).toBeTruthy();
  });
  it('shows the camera fields and the appearance channels', () => {
    select(camera({ fStop: 2.8, appearance: { baseColor: { value: '#112233' } } }));
    render(<PropertiesPanel />);
    expect(screen.getByText('Focal length')).toBeTruthy();
    expect(screen.getByText('f/2.8')).toBeTruthy();
    expect(screen.getByText('Base colour')).toBeTruthy();
    expect(screen.getByText('#112233')).toBeTruthy();
    expect(useStore.getState().document.selection).toEqual(['cam-1']);
  });
});
