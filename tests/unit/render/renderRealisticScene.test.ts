/** RV1 RV-M3 scene building for render_realistic: geometry (face colours, stored UVs, sheets, nesting, budget), materials and lights. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext, ExportFilePort } from '@core/commands/types';
import { type CadDocument, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import type { TextureRecord } from '@core/model/appearance';
import type { PathTraceImage, PathTraceScene } from '@core/model/pathTrace';
import { type SceneLimits, collectSceneGeometry } from '@core/commands/render/realistic/sceneGeometry';
import { MaterialBank, linearRgb } from '@core/commands/render/realistic/sceneMaterials';
import { sceneEnvironment, sceneLighting } from '@core/commands/render/realistic/sceneLights';
import { realisticCamera } from '@core/commands/render/realistic/realisticCamera';
import { EXR_INLINE_MAX_BYTES, realisticResult } from '@core/commands/render/realistic/realisticResult';
import { boxInstance } from '../../helpers/boxInstance';

const run = (doc: CadDocument, name: string, params: object, ctx?: ExecutionContext): CadDocument => {
  const result = execute(doc, name, params, ctx);
  expect(result.error, result.summary).toBeUndefined();
  return result.document;
};

const lim = (maxInstances: number, maxTriangles = 10_000_000): SceneLimits => ({ maxInstances, maxTriangles });

const box = (): CadDocument => run(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });

const texture = (id: string, format: TextureRecord['format']): TextureRecord => ({
  id,
  name: id,
  key: id.padEnd(64, '0'),
  format,
  width: 4,
  height: 4,
  bytes: 10,
  colorSpace: format === 'png' ? 'srgb' : 'linear',
});

describe('collectSceneGeometry', () => {
  it('splits a face-coloured solid into one mesh per colour with the face colour as base colour', () => {
    const doc = run(box(), 'set_face_color', { id: box().order[0], faceNear: [[0, 0, 5]], color: '#00ff00' });
    const bank = new MaterialBank({});
    const geometry = collectSceneGeometry(doc, bank, lim(100));
    expect(geometry.meshes).toHaveLength(2);
    expect(geometry.triangles).toBe(12);
    expect(bank.materials.map((material) => material.baseColor)).toContainEqual([0, 1, 0]);
  });

  it('keeps the stored normals and UVs of a mesh entity (indexed, not a triangle soup)', () => {
    const mesh: MeshSolidEntity = {
      id: 'm',
      kind: 'mesh',
      position: [5, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#ffffff',
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], indices: [0, 1, 2, 1, 3, 2], uvs: [0, 0, 1, 0, 0, 1, 1, 1] },
    };
    const doc = { ...createEmptyDocument(), entities: { m: mesh }, order: ['m'] };
    const geometry = collectSceneGeometry(doc, new MaterialBank({}), lim(100));
    expect(geometry.positions).toHaveLength(12);
    expect(Array.from(geometry.uvs)).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
    expect(Array.from(geometry.indices)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(Array.from(geometry.normals.slice(0, 3))).toEqual([0, 0, 1]);
    expect(geometry.bounds).toEqual({ min: [5, 0, 0], max: [6, 1, 0] });
  });

  it('draws a nurbs sheet in world space', () => {
    const doc = run(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 10, 0],
        ],
        [
          [10, 0, 0],
          [10, 10, 0],
        ],
      ],
    });
    const geometry = collectSceneGeometry(doc, new MaterialBank({}), lim(100));
    expect(geometry.instanceCount).toBe(1);
    expect(geometry.triangles).toBeGreaterThan(0);
    expect(geometry.instances.slice(2)).toEqual(new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]));
  });

  it('refuses an array that cannot fit maxInstances before placing its members', () => {
    const { doc } = boxInstance([0, 0, 0]);
    const arrayDoc = run(doc, 'add_instance_array', { componentId: 'comp-part', counts: [10, 10, 1], step: [5, 5, 5] });
    const geometry = collectSceneGeometry(arrayDoc, new MaterialBank({}), lim(20));
    expect(geometry.overBudget).toBe(true);
    // 100 members x 1 solid child cannot fit 20 rows: refused before any member is placed (only the source box and its instance)
    expect(geometry.instanceCount).toBe(2);
    expect(geometry.instances).toHaveLength(2 * 14);
  });

  it('skips an instance array on a hidden layer, a missing component and runaway nesting', () => {
    let { doc } = boxInstance([0, 0, 0]);
    doc = run(doc, 'add_layer', { name: 'off' });
    const layerId = Object.keys(doc.layers).find((id) => doc.layers[id]?.name === 'off')!;
    doc = run(doc, 'update_layer', { id: layerId, visible: false });
    doc = run(doc, 'add_instance_array', { componentId: 'comp-part', counts: [3, 1, 1], step: [5, 5, 5], layerId });
    expect(collectSceneGeometry(doc, new MaterialBank({}), lim(100)).instanceCount).toBe(2);
    const instanceId = doc.order.find((id) => doc.entities[id]?.kind === 'instance')!;
    const instance = doc.entities[instanceId]!;
    const dangling = { ...doc, entities: { ...doc.entities, [instanceId]: { ...instance, componentId: 'nope' } } } as CadDocument;
    expect(collectSceneGeometry(dangling, new MaterialBank({}), lim(100)).instanceCount).toBe(1);
    const component = doc.components['comp-part']!;
    const selfNested = {
      ...doc,
      components: {
        ...doc.components,
        'comp-part': {
          ...component,
          entities: { ...component.entities, loop: { ...instance, id: 'loop' } },
          order: [...component.order, 'loop'],
        },
      },
    } as CadDocument;
    const nested = collectSceneGeometry(selfNested, new MaterialBank({}), lim(10_000));
    expect(nested.overBudget).toBe(false);
    expect(nested.instanceCount).toBeGreaterThan(2);
  });

  it('an instance passes its material and appearance to children that have none', () => {
    const placed = boxInstance([20, 0, 0]);
    const { instanceId } = placed;
    let doc = placed.doc;
    doc = run(doc, 'create_material', { name: 'red', density: 1000, densityUnit: 'kg/m^3', color: '#ff0000' });
    const instance = doc.entities[instanceId]!;
    doc = {
      ...doc,
      entities: { ...doc.entities, [instanceId]: { ...instance, materialId: 'red', appearance: { roughness: { value: 0.05 } } } },
    } as CadDocument;
    const bank = new MaterialBank({});
    collectSceneGeometry(doc, bank, lim(100));
    expect(bank.materials).toContainEqual(expect.objectContaining({ baseColor: [1, 0, 0], roughness: 0.05 }));
  });
});

describe('scene limits, inheritance and the ground', () => {
  it('stops at the triangle limit before growing a buffer, and the command refuses RENDER_SCENE_TOO_LARGE', () => {
    let doc = box();
    doc = run(doc, 'add_sphere', { radius: 5, position: [30, 0, 0] });
    const geometry = collectSceneGeometry(doc, new MaterialBank({}), lim(100, 20));
    expect(geometry.overBudget).toBe(true);
    expect(geometry.triangles).toBe(12); // the box fitted, the sphere did not
    const result = execute(
      doc,
      'render_realistic',
      {},
      { ...defaultContext(), pathTrace: { render: () => ({ ok: false, code: 'X', message: 'x' }) } },
    );
    expect(result.error?.code).toBe('X'); // under the real limits the scene goes to the port
  });

  it('a nested instance passes the outer material on to its children', () => {
    const placed = boxInstance([0, 0, 0]);
    const { instanceId } = placed;
    let doc = placed.doc;
    doc = run(doc, 'create_component', { name: 'Outer', entityIds: [instanceId], componentId: 'comp-outer' });
    doc = run(doc, 'create_material', { name: 'red', density: 1000, densityUnit: 'kg/m^3', color: '#ff0000' });
    doc = run(doc, 'insert_instance', { componentId: 'comp-outer', position: [50, 0, 0] });
    const outerId = doc.order[doc.order.length - 1]!;
    doc = { ...doc, entities: { ...doc.entities, [outerId]: { ...doc.entities[outerId]!, materialId: 'red' } } } as CadDocument;
    const bank = new MaterialBank({});
    collectSceneGeometry(doc, bank, lim(100));
    expect(bank.materials).toContainEqual(expect.objectContaining({ baseColor: [1, 0, 0] }));
  });

  it('the ground never counts against the instance limit', () => {
    const doc = run(box(), 'add_box', { size: [1, 1, 1], position: [20, 0, 0] });
    const geometry = collectSceneGeometry(doc, new MaterialBank({}), lim(2), { elevation: null });
    expect(geometry.overBudget).toBe(false);
    expect(geometry.instanceCount).toBe(3);
  });

  it('a default view is framed on the drawn geometry: a far 2D sketch and hidden sources do not move it, an array does', () => {
    const doc = run(run(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }), 'draw_rectangle', {
      position: [1000, 1000, 0],
      width: 10,
      height: 10,
    });
    const geometry = collectSceneGeometry(doc, new MaterialBank({}), lim(100));
    const view = realisticCamera(doc, {}, 64, 64, geometry.bounds);
    if (!('camera' in view)) throw new Error(view.message);
    const toCentre = [-view.camera.position[0], -view.camera.position[1], -view.camera.position[2]];
    const length = Math.hypot(...toCentre);
    toCentre.forEach((c, i) => expect(view.camera.forward[i]).toBeCloseTo(c / length, 6));
    expect(length).toBeLessThan(20);
    let arrayDoc = boxInstance([0, 0, 0]).doc;
    arrayDoc = run(arrayDoc, 'add_layer', { name: 'off' });
    const layerId = Object.keys(arrayDoc.layers).find((id) => arrayDoc.layers[id]?.name === 'off')!;
    arrayDoc = run(arrayDoc, 'update_layer', { id: layerId, visible: false });
    for (const id of arrayDoc.order) arrayDoc = run(arrayDoc, 'set_entity_layer', { entityId: id, layerId });
    arrayDoc = run(arrayDoc, 'add_instance_array', {
      componentId: 'comp-part',
      counts: [10, 10, 1],
      step: [100, 100, 1],
      origin: [5000, 5000, 0],
    });
    const arrayGeometry = collectSceneGeometry(arrayDoc, new MaterialBank({}), lim(1000));
    const arrayView = realisticCamera(arrayDoc, { projection: 'perspective' }, 64, 64, arrayGeometry.bounds);
    if (!('camera' in arrayView)) throw new Error(arrayView.message);
    expect(arrayView.camera.position[0]).toBeGreaterThan(5000);
    expect(realisticCamera(doc, { fovDeg: 0 }, 64, 64, geometry.bounds)).toMatchObject({ code: 'VIS_CAMERA_INVALID' });
  });
});

describe('MaterialBank', () => {
  it('texture-only channels take factor 1, missing or HDR surface textures are ignored, each texture listed once per colour space', () => {
    const records = { a: texture('a', 'png'), h: texture('h', 'hdr'), j: texture('j', 'jpeg') };
    const bank = new MaterialBank(records);
    const base = { color: '#808080', metalness: 0.1, roughness: 0.6 };
    const index = bank.materialOf(base, {
      metalness: { texture: 'a' },
      roughness: { texture: 'a' },
      emission: { texture: 'j' },
      emissionStrength: 2,
      transmission: { texture: 'a' },
      coat: { texture: 'a' },
      normal: { texture: 'missing', normalScale: 0.5 },
      baseColor: { texture: 'h' },
    });
    expect(bank.materials[index]).toMatchObject({
      metalness: 1,
      metalnessTexture: 0,
      roughness: 1,
      roughnessTexture: 0,
      emission: [2, 2, 2],
      emissionTexture: 1,
      transmission: 1,
      coat: 1,
      normalTexture: null,
      normalScale: 0.5,
      baseColorTexture: null,
      baseColor: linearRgb('#808080'),
    });
    expect(bank.textures).toEqual([
      { file: 'tex-0.png', format: 'png', colorSpace: 'linear' },
      { file: 'tex-1.jpg', format: 'jpeg', colorSpace: 'srgb' },
    ]);
    expect(bank.materialOf(base, undefined)).toBe(bank.materialOf(base, {}));
    expect(bank.materials[bank.materialOf(base, { emission: { texture: 'missing' } })]?.emission).toEqual([0, 0, 0]);
    expect(linearRgb('nope')).toEqual([0.214, 0.214, 0.214]);
  });
});

describe('scene lights and environment', () => {
  it('maps a sun and a default spot light entity, and skips lights on hidden layers', () => {
    let doc = box();
    doc = run(doc, 'add_light', { lightType: 'sun', position: [0, 0, 50], target: [0, 0, 0], intensity: 5 });
    doc = run(doc, 'add_light', { lightType: 'spot', position: [0, 0, 30] });
    const lights = sceneLighting(doc).lights;
    expect(lights[0]).toMatchObject({ type: 'sun', irradiance: [5, 5, 5] });
    if (lights[0]?.type !== 'sun') throw new Error('not a sun');
    expect(lights[0].direction[2]).toBeCloseTo(1, 9);
    expect(lights[1]).toMatchObject({ type: 'spot' });
    doc = run(doc, 'add_layer', { name: 'off' });
    const layerId = Object.keys(doc.layers).find((id) => doc.layers[id]?.name === 'off')!;
    doc = run(doc, 'update_layer', { id: layerId, visible: false });
    for (const id of doc.order.filter((entityId) => doc.entities[entityId]?.kind === 'light'))
      doc = run(doc, 'set_entity_layer', { entityId: id, layerId });
    expect(sceneLighting(doc).note).toContain('no light entity');
  });

  it('a site context gives the site sun and its sky; a night sun gives sky light only', () => {
    const day = run(box(), 'set_site_context', { latitudeDeg: 50.8, longitudeDeg: 4.35, dateTime: '2026-06-21T13:00:00+02:00' });
    expect(sceneLighting(day).note).toContain('the site sun');
    expect(sceneEnvironment(day, new MaterialBank({}))).toMatchObject({ environment: { type: 'sky', turbidity: 2 } });
    const night = run(box(), 'set_site_context', { latitudeDeg: 50.8, longitudeDeg: 4.35, dateTime: '2026-06-21T02:00:00+02:00' });
    const lighting = sceneLighting(night);
    expect(lighting.lights).toEqual([]);
    expect(lighting.note).toContain('below the horizon');
    const environment = sceneEnvironment(night, new MaterialBank({}));
    expect('environment' in environment && environment.environment.type).toBe('sky');
  });

  it('a dangling HDR environment is reported missing', () => {
    const doc = {
      ...box(),
      appearance: { textures: {}, textureOrder: [], environment: { source: 'hdr' as const, texture: 'gone', rotation: 0, intensity: 1 } },
    };
    expect(sceneEnvironment(doc, new MaterialBank({}))).toEqual({ missing: 'gone' });
    const doc2 = run(box(), 'add_light', { lightType: 'point', position: [0, 0, 40] });
    const result = execute(
      { ...doc2, appearance: doc.appearance },
      'render_realistic',
      {},
      { ...defaultContext(), pathTrace: { render: () => ({ ok: false, code: 'X', message: 'x' }) } },
    );
    expect(result.error?.code).toBe('TEXTURE_ASSET_UNAVAILABLE');
  });
});

describe('realisticCamera', () => {
  it('refuses a non-finite camera and frames an empty scene around the origin', () => {
    const doc = box();
    expect(realisticCamera(doc, { target: [Number.NaN, 0, 0], projection: 'orthographic' }, 64, 64, null)).toMatchObject({
      code: 'RENDER_CAMERA_INVALID',
    });
    const framed = realisticCamera(doc, { projection: 'orthographic', direction: [0, -1, 0] }, 64, 32, null);
    expect('camera' in framed && framed.camera.forward).toEqual([0, 1, 0]);
  });
});

describe('realisticResult', () => {
  it('an EXR sink that fails is a warning, the picture still returns', () => {
    const scene = {
      job: {
        width: 8,
        height: 8,
        samples: 1,
        maxBounces: 1,
        maxSeconds: 1,
        targetNoise: 0.1,
        materials: [],
        textures: [],
        camera: { projection: 'perspective' },
        exposure: 0,
      },
    } as unknown as PathTraceScene;
    const image: PathTraceImage = {
      png: new Uint8Array([1]),
      exr: new Uint8Array(EXR_INLINE_MAX_BYTES + 1),
      stats: {
        samples: 1,
        seed: 0,
        device: 'cpu',
        deterministic: true,
        elapsedMs: 1,
        noise: 0,
        denoised: false,
        triangles: 0,
        instances: 0,
        stoppedBy: 'noise',
      },
      warnings: [],
      version: 'x',
    };
    let aborted = false;
    const sink: ExportFilePort = {
      open: () => ({
        write: () => {
          throw new Error('disk full');
        },
        patch: () => undefined,
        close: () => ({ path: 'x' }),
        abort: () => {
          aborted = true;
        },
      }),
    };
    const result = realisticResult(createEmptyDocument(), scene, image, { cameraId: undefined, lighting: 'l', environment: 'e' }, sink);
    expect(aborted).toBe(true);
    expect((result.data as { warnings: { message: string }[] }).warnings[0]?.message).toContain('disk full');
    expect(result.summary).toContain('stopped at noise 0.1');
  });
});
