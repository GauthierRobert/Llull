import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYER_ID, createEmptyDocument, is3D, type CadDocument, type CameraEntity, type LightEntity } from '@core/model/types';
import { cameraVerticalFov } from '@core/model/sceneKinds';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { aimDirection, lookAtEuler, upDirection } from '@lib/lookAt';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

const run = (doc: CadDocument, name: string, params: object): CadDocument => execute(doc, name, params).document;

const light = (doc: CadDocument, id: string): LightEntity => {
  const entity = doc.entities[id];
  if (entity?.kind !== 'light') throw new Error(`${id} is not a light`);
  return entity;
};
const camera = (doc: CadDocument, id: string): CameraEntity => {
  const entity = doc.entities[id];
  if (entity?.kind !== 'camera') throw new Error(`${id} is not a camera`);
  return entity;
};

const close = (a: readonly number[], b: readonly number[]): void => a.forEach((value, i) => expect(value).toBeCloseTo(b[i] as number, 9));

describe('lookAt', () => {
  it('local -Z points at the aim and the horizon stays level', () => {
    for (const aim of [
      [0, 1, 0],
      [1, 0, 0],
      [-3, 2, -1],
      [0, 0, -1],
      [0, 0, 1],
    ] as const) {
      const euler = lookAtEuler(aim);
      const length = Math.hypot(...aim);
      close(aimDirection(euler!), [aim[0] / length, aim[1] / length, aim[2] / length]);
    }
    expect(upDirection(lookAtEuler([0, 1, 0])!)[2]).toBeCloseTo(1, 9);
    expect(lookAtEuler([0, 0, 0])).toBeNull();
    expect(lookAtEuler([1, Number.NaN, 0])).toBeNull();
  });
});

describe('add_light', () => {
  it('creates a sun with defaults aimed by target', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_light', { lightType: 'sun', position: [0, 0, 20], target: [0, 0, 0], name: 'Sun' });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    const sun = light(result.document, id);
    expect(sun).toMatchObject({
      lightType: 'sun',
      intensity: 3,
      lightColor: '#ffffff',
      castShadows: true,
      name: 'Sun',
      position: [0, 0, 20],
    });
    close(aimDirection(sun.rotation), [0, 0, -1]);
    expect(result.document.order).toEqual([id]);
    expect(is3D(sun)).toBe(false);
    expect(result.summary).toContain(id);
    expectPure(doc, () => execute(doc, 'add_light', { lightType: 'sun' }));
  });

  it('default power gives the default sun irradiance (3 W/m2) at the target, whatever the document scale', () => {
    const doc = createEmptyDocument();
    const at = (lightType: string, position: number[], target?: number[]): number => {
      const size = lightType === 'area' ? { width: 100, height: 50 } : {};
      const result = execute(doc, 'add_light', { lightType, position, ...size, ...(target !== undefined ? { target } : {}) });
      return light(result.document, result.affected[0]!).intensity;
    };
    expect(at('point', [0, 0, 500], [0, 0, 0])).toBe(Number((3 * 4 * Math.PI * 0.25).toPrecision(3)));
    expect(at('spot', [0, 0, 2000], [0, 0, 0])).toBe(Number((3 * 4 * Math.PI * 4).toPrecision(3)));
    expect(at('area', [0, 0, 1000], [0, 0, 0])).toBe(Number((3 * Math.PI).toPrecision(3)));
    expect(at('point', [0, 0, 5])).toBe(Number((3 * 4 * Math.PI).toPrecision(3)));
    const metres = { ...doc, units: 'm' as const };
    const far = execute(metres, 'add_light', { lightType: 'point', position: [0, 0, 2], target: [0, 0, 0] });
    expect(light(far.document, far.affected[0]!).intensity).toBe(Number((3 * 4 * Math.PI * 4).toPrecision(3)));
    expect(at('sun', [0, 0, 5])).toBe(3);
  });

  it('spot, area and point carry their own fields', () => {
    let doc = createEmptyDocument();
    const spot = execute(doc, 'add_light', {
      lightType: 'spot',
      position: [0, 0, 5],
      target: [3, 0, 0],
      coneAngle: 0.5,
      intensity: 50,
      color: '#ff8800',
    });
    doc = spot.document;
    expect(light(doc, spot.affected[0]!)).toMatchObject({
      coneAngle: 0.5,
      blend: 0.15,
      intensity: 50,
      lightColor: '#ff8800',
      color: '#ff8800',
    });
    const area = execute(doc, 'add_light', { lightType: 'area', position: [0, 0, 5], width: 2, height: 1, castShadows: false });
    expect(light(area.document, area.affected[0]!)).toMatchObject({ width: 2, height: 1, castShadows: false });
    const point = execute(doc, 'add_light', { lightType: 'point', rotation: [0.1, 0.2, 0.3], layerId: 'missing-layer' });
    expect(light(point.document, point.affected[0]!)).toMatchObject({ rotation: [0.1, 0.2, 0.3], radius: 0, layerId: DEFAULT_LAYER_ID });
  });

  it.each([
    ['negative intensity', { lightType: 'point', intensity: -1 }],
    ['target equals position', { lightType: 'point', position: [1, 1, 1], target: [1, 1, 1] }],
    ['short target', { lightType: 'point', target: [1, 2] }],
    ['bad rotation', { lightType: 'point', rotation: [0, 0] }],
    ['spot cone too wide', { lightType: 'spot', coneAngle: 2 }],
    ['spot cone zero', { lightType: 'spot', coneAngle: 0 }],
    ['spot blend out of range', { lightType: 'spot', blend: 1.5 }],
    ['area without size', { lightType: 'area' }],
    ['area zero height', { lightType: 'area', width: 1, height: 0 }],
    ['cone on a point light', { lightType: 'point', coneAngle: 0.3 }],
    ['blend on a point light', { lightType: 'point', blend: 0.3 }],
    ['size on a point light', { lightType: 'point', width: 1 }],
    ['negative radius', { lightType: 'point', radius: -1 }],
  ])('refuses %s with SCENE_LIGHT_INVALID', (_label, params) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_light', params);
    expectNoOp(result, doc, 'SCENE_LIGHT_INVALID');
    expect(result.error?.code).toBe('SCENE_LIGHT_INVALID');
  });

  it('rejects a bad color, light type or non-finite number through the schema', () => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'add_light', { lightType: 'point', position: [Number.NaN, 0, 0] }), doc);
    expectNoOp(execute(doc, 'add_camera', { position: [0, Number.POSITIVE_INFINITY, 0] }), doc);
    expectNoOp(execute(doc, 'add_light', { lightType: 'point', color: 'red' }), doc);
    expectNoOp(execute(doc, 'add_light', { lightType: 'lamp' }), doc);
  });
});

describe('add_camera', () => {
  it('defaults to a 50 mm lens on a 36x24 sensor focused on the target', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_camera', { position: [0, -10, 0], target: [0, 0, 0] });
    const id = result.affected[0]!;
    const cam = camera(result.document, id);
    expect(cam).toMatchObject({ focalLength: 50, sensorWidth: 36, sensorHeight: 24, focusDistance: 10 });
    expect(cam.fStop).toBeUndefined();
    close(aimDirection(cam.rotation), [0, 1, 0]);
    expect(cameraVerticalFov(cam)).toBeCloseTo(2 * Math.atan(24 / 100), 12);
    expect(result.document.order).toEqual([id]);
    expect(result.summary).toContain('vertical fov 26.99');
    expectPure(doc, () => execute(doc, 'add_camera', { position: [1, 2, 3], target: [0, 0, 0] }));
  });

  it('takes explicit optics, aperture and rotation', () => {
    const result = execute(createEmptyDocument(), 'add_camera', {
      focalLength: 85,
      sensorWidth: 24,
      sensorHeight: 16,
      focusDistance: 3,
      fStop: 2.8,
      rotation: [1, 0, 0],
    });
    expect(camera(result.document, result.affected[0]!)).toMatchObject({
      focalLength: 85,
      fStop: 2.8,
      focusDistance: 3,
      rotation: [1, 0, 0],
    });
    expect(result.summary).toContain('f/2.8');
    const noTarget = execute(createEmptyDocument(), 'add_camera', {});
    expect(camera(noTarget.document, noTarget.affected[0]!).focusDistance).toBe(10);
  });

  it.each([
    ['zero focal length', { focalLength: 0 }],
    ['negative sensor', { sensorWidth: -1 }],
    ['zero focus', { focusDistance: 0 }],
    ['zero f-stop', { fStop: 0 }],
    ['target at the eye', { position: [1, 2, 3], target: [1, 2, 3] }],
    ['short target', { target: [0, 0] }],
  ])('refuses %s with SCENE_CAMERA_INVALID', (_label, params) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_camera', params);
    expectNoOp(result, doc);
    expect(result.error?.code ?? result.summary).toContain('SCENE_CAMERA_INVALID');
  });
});

describe('edit_light / edit_camera', () => {
  const base = (): { doc: CadDocument; lightId: string; cameraId: string; boxId: string } => {
    let doc = createEmptyDocument();
    const l = execute(doc, 'add_light', { lightType: 'spot', position: [0, 0, 5], target: [0, 0, 0] });
    doc = l.document;
    const c = execute(doc, 'add_camera', { position: [0, -10, 2], target: [0, 0, 0], fStop: 4 });
    doc = c.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    return { doc: b.document, lightId: l.affected[0]!, cameraId: c.affected[0]!, boxId: b.affected[0]! };
  };

  it('edits only the given fields and keeps the aim when only the position changes', () => {
    const { doc, lightId } = base();
    const before = light(doc, lightId);
    const moved = execute(doc, 'edit_light', { id: lightId, position: [1, 1, 9], intensity: 10, color: '#00ff00' });
    expect(moved.affected).toEqual([lightId]);
    expect(light(moved.document, lightId)).toMatchObject({
      position: [1, 1, 9],
      intensity: 10,
      lightColor: '#00ff00',
      rotation: before.rotation,
      coneAngle: before.coneAngle,
    });
    const aimed = execute(doc, 'edit_light', { id: lightId, target: [5, 0, 5] });
    close(
      aimDirection(light(aimed.document, lightId).rotation),
      [0, 0, 0].map((_, i) => [0, 0, 0][i]! + [1, 0, 0][i]!),
    );
    expectPure(doc, () => execute(doc, 'edit_light', { id: lightId, intensity: 1 }));
  });

  it('refuses unknown ids, wrong kinds, no-ops and out-of-range merges', () => {
    const { doc, lightId, cameraId, boxId } = base();
    const missing = execute(doc, 'edit_light', { id: 'nope', intensity: 1 });
    expectNoOp(missing, doc, 'SCENE_OBJECT_NOT_FOUND');
    expectNoOp(execute(doc, 'edit_light', { id: boxId, intensity: 1 }), doc, 'SCENE_LIGHT_INVALID');
    expectNoOp(execute(doc, 'edit_light', { id: cameraId, intensity: 1 }), doc, 'SCENE_LIGHT_INVALID');
    expectNoOp(execute(doc, 'edit_light', { id: lightId }), doc, 'nothing to change');
    expectNoOp(execute(doc, 'edit_light', { id: lightId, coneAngle: 3 }), doc, 'SCENE_LIGHT_INVALID');
    expectNoOp(execute(doc, 'edit_light', { id: lightId, width: 2 }), doc, 'SCENE_LIGHT_INVALID');
    expectNoOp(execute(doc, 'edit_light', { id: lightId, position: [Number.NaN, 0, 0] }), doc);
    expectNoOp(execute(doc, 'edit_light', { id: lightId, position: [1, 2, 3, 4] }), doc, 'SCENE_LIGHT_INVALID');
    expectNoOp(execute(doc, 'edit_light', { id: lightId, target: [0, 0, 5] }), doc, 'zero-length');
    expectNoOp(execute(doc, 'edit_camera', { id: 'nope', focalLength: 35 }), doc, 'SCENE_OBJECT_NOT_FOUND');
    expectNoOp(execute(doc, 'edit_camera', { id: lightId, focalLength: 35 }), doc, 'SCENE_CAMERA_INVALID');
    expectNoOp(execute(doc, 'edit_camera', { id: cameraId }), doc, 'nothing to change');
    expectNoOp(execute(doc, 'edit_camera', { id: cameraId, focalLength: -1 }), doc, 'SCENE_CAMERA_INVALID');
    expectNoOp(execute(doc, 'edit_camera', { id: cameraId, fStop: 2, pinhole: true }), doc, 'not both');
    expectNoOp(execute(doc, 'edit_camera', { id: cameraId, position: [1, 2, 3, 4] }), doc, 'SCENE_CAMERA_INVALID');
    expectNoOp(execute(doc, 'edit_camera', { id: cameraId, rotation: [1, 2, 3, 4] }), doc, 'SCENE_CAMERA_INVALID');
  });

  it('edits optics, clears the aperture and re-aims a camera', () => {
    const { doc, cameraId } = base();
    const wide = execute(doc, 'edit_camera', { id: cameraId, focalLength: 24, focusDistance: 4, name: 'Wide' });
    expect(camera(wide.document, cameraId)).toMatchObject({ focalLength: 24, focusDistance: 4, fStop: 4, name: 'Wide' });
    expect(wide.summary).toContain('vertical fov');
    const pinhole = execute(wide.document, 'edit_camera', { id: cameraId, pinhole: true });
    expect(camera(pinhole.document, cameraId).fStop).toBeUndefined();
    const aimed = execute(doc, 'edit_camera', { id: cameraId, position: [10, 0, 0], target: [0, 0, 0] });
    close(aimDirection(camera(aimed.document, cameraId).rotation), [-1, 0, 0]);
    const rotated = execute(doc, 'edit_camera', { id: cameraId, rotation: [0, 0, 1], fStop: 8 });
    expect(camera(rotated.document, cameraId)).toMatchObject({ rotation: [0, 0, 1], fStop: 8 });
    expectPure(doc, () => execute(doc, 'edit_camera', { id: cameraId, focalLength: 35 }));
  });
});

describe('scene objects in the rest of the command layer', () => {
  const scene = (): { doc: CadDocument; lightId: string; cameraId: string } => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const l = execute(doc, 'add_light', { lightType: 'sun', position: [0, 0, 5000], target: [0, 0, 0] });
    const c = execute(l.document, 'add_camera', { position: [4000, 0, 0], target: [0, 0, 0] });
    doc = c.document;
    return { doc, lightId: l.affected[0]!, cameraId: c.affected[0]! };
  };

  it('round-trips through save / load and validates stored fields', () => {
    const { doc, lightId, cameraId } = scene();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.entities[lightId]).toEqual(doc.entities[lightId]);
    expect(loaded.entities[cameraId]).toEqual(doc.entities[cameraId]);
    const sun = doc.entities[lightId]!;
    const cam = doc.entities[cameraId]!;
    expect(validateEntityValue(sun)).toBeNull();
    expect(validateEntityValue(cam)).toBeNull();
    expect(validateEntityValue({ ...sun, intensity: -1 })).toContain('intensity');
    expect(validateEntityValue({ ...sun, lightType: 'lamp' })).toContain('lightType');
    expect(validateEntityValue({ ...sun, lightColor: 'white' })).toContain('lightColor');
    expect(validateEntityValue({ ...sun, radius: Number.NaN })).toContain('radius');
    expect(validateEntityValue({ ...sun, castShadows: 1 })).toContain('castShadows');
    expect(validateEntityValue({ ...sun, coneAngle: 1 })).toContain('spot lights only');
    expect(validateEntityValue({ ...sun, width: 1 })).toContain('area lights only');
    expect(validateEntityValue({ ...sun, lightType: 'spot' })).toContain('coneAngle');
    expect(validateEntityValue({ ...sun, lightType: 'spot', coneAngle: 1, blend: 3 })).toContain('blend');
    expect(validateEntityValue({ ...sun, lightType: 'area' })).toContain('area light');
    expect(validateEntityValue({ ...cam, focalLength: 0 })).toContain('focalLength');
    expect(validateEntityValue({ ...cam, fStop: -2 })).toContain('fStop');
  });

  it('check_model flags a hand-broken scene object and does not call a far sun far from the origin', () => {
    const { doc, lightId, cameraId } = scene();
    const clean = execute(doc, 'check_model', {}).data as { issues: { code: string; entityId?: string }[] };
    expect(clean.issues.filter((issue) => issue.entityId === lightId || issue.entityId === cameraId)).toEqual([]);
    const broken = { ...doc, entities: { ...doc.entities, [lightId]: { ...light(doc, lightId), intensity: -4 } } };
    const issues = (execute(broken, 'check_model', {}).data as { issues: { code: string; entityId?: string }[] }).issues;
    expect(issues.some((issue) => issue.entityId === lightId && issue.code === 'degenerate_size')).toBe(true);
    const brokenCamera = { ...doc, entities: { ...doc.entities, [cameraId]: { ...camera(doc, cameraId), sensorWidth: 0 } } };
    const cameraIssues = (execute(brokenCamera, 'check_model', {}).data as { issues: { code: string; entityId?: string }[] }).issues;
    expect(cameraIssues.some((issue) => issue.entityId === cameraId && issue.code === 'degenerate_size')).toBe(true);
  });

  it('keeps lights and cameras out of the scene bounds, but lists them', () => {
    const { doc, lightId } = scene();
    const described = execute(doc, 'describe_scene', {}).data as {
      bounds: { min: number[]; max: number[] };
      entities: { id: string; kind: string }[];
    };
    expect(described.bounds.max[2]).toBeLessThan(10);
    expect(described.entities.map((e) => e.kind)).toEqual(['box', 'light', 'camera']);
    expect(entityBoundsInDoc(doc, doc.entities[lightId]!).min).toEqual([0, 0, 5000]);
    const onlyLight = execute(createEmptyDocument(), 'add_light', { lightType: 'point' }).document;
    expect((execute(onlyLight, 'describe_scene', {}).data as { bounds: unknown }).bounds).toBeNull();
  });

  it('move / rotate / array / mirror treat them as placed objects; scale refuses', () => {
    const { doc, lightId } = scene();
    const moved = execute(doc, 'move_entities', { ids: [lightId], delta: [1, 2, 3] });
    expect(light(moved.document, lightId).position).toEqual([1, 2, 5003]);
    const rotated = execute(doc, 'rotate_entity', { id: lightId, delta: [Math.PI, 0, 0] });
    close(aimDirection(light(rotated.document, lightId).rotation), [0, 0, 1]);
    const copies = execute(doc, 'array_linear', { id: lightId, count: 3, offset: [10, 0, 0] });
    expect(copies.affected).toHaveLength(2);
    expect(light(copies.document, copies.affected[1]!)).toMatchObject({ kind: 'light', position: [20, 0, 5000], lightType: 'sun' });
    const mirrored = execute(doc, 'mirror_entity', { id: lightId, axis: 'z' });
    expect(light(mirrored.document, lightId).position[2]).toBe(-5000);
    expectNoOp(execute(doc, 'scale_entity', { id: lightId, factor: 2 }), doc, 'no geometry');
    expectNoOp(execute(doc, 'array_linear', { id: lightId, count: 2, offset: [1, 0, 0], as: 'instances' }), doc);
  });

  it('is filterable by kind', () => {
    const { doc, lightId, cameraId } = scene();
    expect((execute(doc, 'find_entities', { kind: 'light' }).data as { matches: { id: string }[] }).matches.map((e) => e.id)).toEqual([
      lightId,
    ]);
    expect((execute(doc, 'find_entities', { kind: 'camera' }).data as { matches: { id: string }[] }).matches.map((e) => e.id)).toEqual([
      cameraId,
    ]);
  });

  it('never becomes geometry: booleans, mass, extrusion, STL and code export skip or refuse them', () => {
    const { doc, lightId, cameraId } = scene();
    const boxId = doc.order[0]!;
    expectNoOp(execute(doc, 'boolean', { op: 'union', a: boxId, b: lightId }), doc, 'scene object');
    expectNoOp(execute(doc, 'mass_properties', { id: lightId }), doc);
    expectNoOp(execute(doc, 'extrude_profile', { id: cameraId, depth: 1 }), doc);
    const stl = execute(doc, 'export_stl', {}).data as { triangleCount: number };
    expect(stl.triangleCount).toBe(12);
    const code = execute(doc, 'export_code', { language: 'cadquery' });
    const codeData = code.data as { solidCount: number; text: string };
    expect(codeData.solidCount).toBe(1);
    expect(JSON.stringify(code.data)).toContain('scene objects');
    const gltf = execute(doc, 'export_gltf', {});
    expect(gltf.affected).toHaveLength(0);
  });
});

describe('render_view camera', () => {
  const sceneWithCamera = (): { doc: CadDocument; cameraId: string } => {
    const doc = run(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [-1, -1, 0] });
    const c = execute(doc, 'add_camera', { position: [8, -8, 5], target: [0, 0, 1], focalLength: 35, name: 'Cam' });
    return { doc: c.document, cameraId: c.affected[0]! };
  };
  type View = {
    view: string;
    projection: string;
    cameraId?: string;
    camera: { position: number[]; target: number[]; up: number[] };
    svg: string;
  };

  it('renders from the camera: perspective, its position, aim and up', () => {
    const { doc, cameraId } = sceneWithCamera();
    const result = execute(doc, 'render_view', { camera: cameraId, width: 320, height: 240 });
    const data = result.data as View;
    expect(result.summary).toContain('Rendered');
    expect(data).toMatchObject({ view: 'custom', projection: 'perspective', cameraId });
    close(data.camera.position, [8, -8, 5]);
    expect(data.camera.up[2]).toBeGreaterThan(0.5);
    const direction = [0 - 8, 0 + 8, 1 - 5];
    const length = Math.hypot(...direction);
    const seen = data.camera.target.map((v, i) => v - data.camera.position[i]!);
    const seenLength = Math.hypot(...seen);
    close(
      seen.map((v) => v / seenLength),
      direction.map((v) => v / length),
    );
    expectPure(doc, () => execute(doc, 'render_view', { camera: cameraId }));
  });

  it('a wider lens shows more of the scene than a longer one', () => {
    const { doc, cameraId } = sceneWithCamera();
    const longer = run(doc, 'edit_camera', { id: cameraId, focalLength: 200 });
    const wide = execute(doc, 'render_view', { camera: cameraId, width: 200, height: 150 }).data as View;
    const tele = execute(longer, 'render_view', { camera: cameraId, width: 200, height: 150 }).data as View;
    expect(wide.svg).not.toBe(tele.svg);
  });

  it('refuses an unknown id, a non-camera, a viewpoint clash, vector mode and multi-pass views', () => {
    const { doc, cameraId } = sceneWithCamera();
    const boxId = doc.order[0]!;
    expect(execute(doc, 'render_view', { camera: 'ghost' }).error?.code).toBe('SCENE_CAMERA_NOT_FOUND');
    expect(execute(doc, 'render_view', { camera: boxId }).error?.code).toBe('SCENE_NOT_A_CAMERA');
    expect(execute(doc, 'render_view', { camera: cameraId, viewpointId: 'vp-1' }).error?.code).toBe('VIS_CAMERA_INVALID');
    expect(execute(doc, 'render_view', { camera: cameraId, mode: 'vector' }).error?.code).toBe('VIS_RENDER_INVALID');
    expect(execute(doc, 'render_view', { camera: cameraId, isolate: boxId }).error?.code).toBe('VIS_RENDER_INVALID');
    const broken = { ...doc, entities: { ...doc.entities, [cameraId]: { ...camera(doc, cameraId), focalLength: 0 } } };
    const refused = execute(broken, 'render_view', { camera: cameraId });
    expect(refused.error?.code).toBe('SCENE_CAMERA_INVALID');
    expect(refused.affected).toHaveLength(0);
  });

  it('lights and cameras do not change a render without the camera param', () => {
    const plain = run(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const withScene = run(run(plain, 'add_light', { lightType: 'sun', position: [0, 0, 5000], target: [0, 0, 0] }), 'add_camera', {
      position: [3, 3, 3],
      target: [0, 0, 0],
    });
    const a = execute(plain, 'render_view', { view: 'front' }).data as { svg: string; bounds: unknown };
    const b = execute(withScene, 'render_view', { view: 'front' }).data as { svg: string; bounds: unknown };
    expect(b.svg).toBe(a.svg);
    expect(b.bounds).toEqual(a.bounds);
  });
});
