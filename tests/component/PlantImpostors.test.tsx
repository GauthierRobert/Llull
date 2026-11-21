import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot, extend } from '@react-three/fiber';
import { framedPlanCamera, type PlanCamera } from '@core/geometry/renderPlanCamera';
import { planRender, planScene } from '@core/geometry/renderPlan';
import type { Entity } from '@core/model/types';
import { useRealismStore } from '@ui/store/realismStore';
import { ImpostorAtlasCache, type AtlasCapture } from '@ui/viewport/3d/plant/ImpostorAtlasCache';
import { ImpostorMaterials } from '@ui/viewport/3d/plant/plantImpostorMaterial';
import { LodGeometryCache } from '@ui/viewport/3d/plant/LodGeometryCache';
import { PlantBatchRenderer } from '@ui/viewport/3d/plant/PlantBatchRenderer';
import { drawBuckets, plantCoveredIds } from '@ui/viewport/3d/plant/plantBatchPlan';
import { bucketMatrices } from '@ui/viewport/3d/plant/plantMatrices';
import { bucketRaycast } from '@ui/viewport/3d/plant/plantPick';
import { rayCandidates } from '@ui/viewport/3d/plant/plantRayIndex';
import type { PlantPlan } from '@ui/viewport/3d/plant/usePlantPlan';
import { synRackDocument } from '../helpers/synRack';

extend(THREE as unknown as Parameters<typeof extend>[0]);

const doc = synRackDocument(8);
const scene = planScene(doc);
const covered = plantCoveredIds(scene, doc.entities, () => false);

function cameraAt(radius: number): PlanCamera {
  const camera = framedPlanCamera({ view: 'iso', projection: 'perspective', center: [0, 0, 0], radius, widthPx: 1920, heightPx: 1080 });
  if (typeof camera === 'string') throw new Error(camera);
  return camera;
}

/** Far enough that part of every repeated LOD1 bucket falls under the impostor size. */
const FAR = cameraAt(12000);
const NEAR = cameraAt(6000);

function plantPlan(camera: PlanCamera): PlantPlan {
  return { scene, plan: planRender(scene, camera, { multiDraw: true, quality: 'medium' }), moving: false, camera };
}

/** A capture that returns a bare texture and counts live atlases (no GPU). */
function fakeCapture(): { capture: AtlasCapture; live: () => number; made: () => number } {
  let live = 0;
  let made = 0;
  return {
    capture: () => {
      live++;
      made++;
      return { texture: new THREE.Texture(), dispose: () => void live-- };
    },
    live: () => live,
    made: () => made,
  };
}

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

const noop = (): void => undefined;

async function mount(
  plan: PlantPlan,
  capture: AtlasCapture,
): Promise<{ meshes: () => THREE.InstancedMesh[]; root: ReturnType<typeof createRoot> }> {
  const group = new THREE.Group();
  const root = createRoot(document.createElement('canvas'));
  await act(async () => {
    await root.configure({ gl: headlessRenderer(), frameloop: 'never' });
    root.render(
      <group ref={(g) => void (g && g !== group && group.add(g))}>
        <PlantBatchRenderer
          plan={plan}
          covered={covered}
          entities={doc.entities}
          materials={doc.materials}
          display={undefined}
          selectionSet={new Set()}
          onSelect={noop}
          atlasCapture={capture}
        />
      </group>,
    );
  });
  const meshes = (): THREE.InstancedMesh[] => {
    const found: THREE.InstancedMesh[] = [];
    group.traverse((o) => o instanceof THREE.InstancedMesh && found.push(o));
    return found;
  };
  return { meshes, root };
}

const withAtlas = (camera: PlanCamera): { camera: PlanCamera; available: () => boolean } => ({ camera, available: () => true });

describe('impostor swap by distance', () => {
  beforeEach(() => useRealismStore.setState({ realism: 'standard', edges: 'auto' }));

  it('far instances of a repeated prototype become impostor buckets; fewer when the camera is near', () => {
    const buckets = drawBuckets(scene, plantPlan(FAR).plan, covered, false, withAtlas(FAR));
    const impostors = buckets.filter((bucket) => bucket.impostor === true);
    expect(impostors.length).toBeGreaterThan(0);
    for (const bucket of impostors) {
      expect(bucket.lod).toBe(1);
      expect(bucket.key.endsWith('|imp')).toBe(true);
    }
    const close = drawBuckets(scene, plantPlan(NEAR).plan, covered, false, withAtlas(NEAR));
    expect(close.filter((bucket) => bucket.impostor === true).length).toBeLessThan(impostors.length);
  });

  it('without the option (or without an atlas) no bucket is an impostor, and the entities are the same', () => {
    const { plan } = plantPlan(FAR);
    const plain = drawBuckets(scene, plan, covered);
    const refused = drawBuckets(scene, plan, covered, false, { camera: FAR, available: () => false });
    const swapped = drawBuckets(scene, plan, covered, false, withAtlas(FAR));
    expect(plain.some((bucket) => bucket.impostor === true)).toBe(false);
    expect(refused.map((bucket) => bucket.key)).toEqual(plain.map((bucket) => bucket.key));
    const ids = (list: typeof plain): string[] => list.flatMap((bucket) => bucket.ids).sort();
    expect(ids(swapped)).toEqual(ids(plain));
  });

  it('picking an impostor tests the real LOD1 mesh and returns the entity id', () => {
    const bucket = drawBuckets(scene, plantPlan(FAR).plan, covered, false, withAtlas(FAR)).find((b) => b.impostor === true);
    if (bucket === undefined) throw new Error('no impostor bucket');
    const cache = new LodGeometryCache();
    const placements = bucket.ids.map((id) => doc.entities[id] as Entity);
    const real = cache.geometry(bucket.prototypeKey, 1, placements[0] as Entity);
    const mesh = new THREE.InstancedMesh(cache.impostorQuad(), new THREE.MeshBasicMaterial(), bucket.ids.length);
    mesh.instanceMatrix.array.set(bucketMatrices(placements));
    mesh.raycast = bucketRaycast(bucket, (origin, direction) => rayCandidates(scene, origin, direction), real);
    mesh.updateMatrixWorld(true);
    const instance = scene.instances[bucket.members[0] as number];
    if (instance === undefined) throw new Error('no instance');
    const centre = new THREE.Vector3(
      (instance.aabb.min[0] + instance.aabb.max[0]) / 2,
      (instance.aabb.min[1] + instance.aabb.max[1]) / 2,
      (instance.aabb.min[2] + instance.aabb.max[2]) / 2,
    );
    const eye = new THREE.Vector3(...FAR.eye);
    const raycaster = new THREE.Raycaster(eye, centre.clone().sub(eye).normalize());
    raycaster.far = Infinity;
    const hits = raycaster.intersectObject(mesh);
    expect(hits.map((hit) => bucket.ids[hit.instanceId as number])).toContain(bucket.ids[0]);
    // On the real surface, in front of the centre where a billboard would sit.
    expect(hits.find((hit) => hit.instanceId === 0)?.distance).toBeLessThan(eye.distanceTo(centre));
    cache.dispose();
  });

  it('PlantBatchRenderer draws impostors from a captured atlas in the shaded Standard tier', async () => {
    const fake = fakeCapture();
    const { meshes, root } = await mount(plantPlan(FAR), fake.capture);
    const shader = meshes().filter((mesh) => mesh.material instanceof THREE.ShaderMaterial);
    expect(shader.length).toBeGreaterThan(0);
    for (const mesh of shader) expect(mesh.castShadow).toBe(false);
    expect(fake.made()).toBeGreaterThan(0);
    await act(async () => root.unmount());
  });

  it('Draft draws no impostor and captures nothing', async () => {
    useRealismStore.setState({ realism: 'draft' });
    const fake = fakeCapture();
    const { meshes, root } = await mount(plantPlan(FAR), fake.capture);
    expect(meshes().some((mesh) => mesh.material instanceof THREE.ShaderMaterial)).toBe(false);
    expect(fake.made()).toBe(0);
    await act(async () => root.unmount());
  });

  it('a failed capture keeps the real mesh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
    const { meshes, root } = await mount(plantPlan(FAR), () => {
      throw new Error('no GL');
    });
    expect(meshes().length).toBeGreaterThan(0);
    expect(meshes().some((mesh) => mesh.material instanceof THREE.ShaderMaterial)).toBe(false);
    warn.mockRestore();
    await act(async () => root.unmount());
  });
});

describe('impostor disposal', () => {
  it('the atlas cache disposes every capture on retain and dispose, and failures are remembered', () => {
    const fake = fakeCapture();
    const cache = new ImpostorAtlasCache(fake.capture);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const box = { min: [-1, -1, -1], max: [1, 1, 1] } as const;
    const a = cache.atlas('a', geometry, box);
    expect(cache.atlas('a', geometry, box)).toBe(a);
    cache.atlas('b', geometry, box);
    expect(fake.live()).toBe(2);
    cache.retain(new Set(['b']));
    expect(fake.live()).toBe(1);
    cache.dispose();
    expect(fake.live()).toBe(0);
    expect(cache.size).toBe(0);
    const failing = new ImpostorAtlasCache(() => null);
    expect(failing.atlas('x', geometry, box)).toBeNull();
    expect(failing.size).toBe(1);
  });

  it('materials and the shared quad are disposed', () => {
    const materials = new ImpostorMaterials();
    const atlas = new ImpostorAtlasCache(fakeCapture().capture).atlas('a', new THREE.BoxGeometry(), { min: [0, 0, 0], max: [1, 1, 1] });
    if (atlas === null) throw new Error('no atlas');
    const material = materials.get('a', atlas);
    expect(materials.get('a', atlas)).toBe(material);
    const spy = vi.spyOn(material, 'dispose');
    materials.dispose();
    expect(spy).toHaveBeenCalledOnce();
    expect(materials.size).toBe(0);
    const cache = new LodGeometryCache();
    const quadSpy = vi.spyOn(cache.impostorQuad(), 'dispose');
    cache.dispose();
    expect(quadSpy).toHaveBeenCalledOnce();
  });

  it('unmounting the renderer disposes every atlas', async () => {
    const fake = fakeCapture();
    const { root } = await mount(plantPlan(FAR), fake.capture);
    expect(fake.live()).toBeGreaterThan(0);
    await act(async () => root.unmount());
    expect(fake.live()).toBe(0);
  });
});
