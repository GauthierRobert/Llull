/** RV1 RV-M3 render_realistic: the scene handed to ctx.pathTrace (wire contract RV1 §5b), the result, and every named refusal. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext, ExportFilePort } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { PATH_TRACE_INSTANCE_STRIDE, type PathTraceImage, type PathTracePort, type PathTraceScene } from '@core/model/pathTrace';
import { EXR_INLINE_MAX_BYTES } from '@core/commands/render/realistic/realisticResult';
import { DEFAULT_SUN_IRRADIANCE } from '@core/commands/render/realistic/sceneLights';
import { compose, placement, transformPoint } from '@core/commands/render/realistic/affine';
import { sha256Hex } from '@lib/sha256';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { boxInstance } from '../../helpers/boxInstance';
import { hdrBytes, memoryImageAssets, pngBytes, toBase64 } from '../../helpers/imageHeaderFixtures';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const EXR = new Uint8Array([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]);

function image(scene: PathTraceScene, overrides: Partial<PathTraceImage> = {}): PathTraceImage {
  return {
    png: PNG,
    exr: scene.job.exr ? EXR : new Uint8Array(0),
    stats: {
      samples: scene.job.samples,
      seed: scene.job.seed,
      device: 'cpu',
      deterministic: true,
      elapsedMs: 12,
      noise: 0.01,
      denoised: scene.job.denoise,
      triangles: scene.indices.length / 3,
      instances: scene.job.instanceCount,
      stoppedBy: 'samples',
    },
    warnings: [],
    version: 'llull-compute 0.1.0',
    ...overrides,
  };
}

function fakePort(
  answer: (scene: PathTraceScene) => ReturnType<PathTracePort['render']> = (scene) => ({ ok: true, image: image(scene) }),
): { port: PathTracePort; scenes: PathTraceScene[] } {
  const scenes: PathTraceScene[] = [];
  return {
    scenes,
    port: {
      render: (scene) => {
        scenes.push(scene);
        return answer(scene);
      },
    },
  };
}

const ctxWith = (port: PathTracePort | null, extra: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...defaultContext(),
  pathTrace: port,
  ...extra,
});

const run = (doc: CadDocument, name: string, params: object, ctx?: ExecutionContext): CadDocument =>
  execute(doc, name, params, ctx).document;

function render(
  doc: CadDocument,
  params: object = {},
  extra: Partial<ExecutionContext> = {},
): { scene: PathTraceScene; result: ReturnType<typeof execute> } {
  const { port, scenes } = fakePort();
  const result = execute(doc, 'render_realistic', { width: 64, height: 48, samples: 4, ...params }, ctxWith(port, extra));
  const scene = scenes[0];
  if (scene === undefined) throw new Error(`no scene rendered: ${result.summary}`);
  return { scene, result };
}

const twoBoxes = (): CadDocument => {
  let doc = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  doc = run(doc, 'add_box', { size: [10, 10, 10], position: [30, 0, 0] });
  return doc;
};

const row = (scene: PathTraceScene, index: number): number[] =>
  Array.from(scene.instances.subarray(index * PATH_TRACE_INSTANCE_STRIDE, (index + 1) * PATH_TRACE_INSTANCE_STRIDE));

const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;

describe('render_realistic scene', () => {
  it('shares one mesh between identical solids, places each by its affine and adds the ground', () => {
    const doc = twoBoxes();
    const { scene, result } = render(doc);
    expect(scene.job).toMatchObject({ kind: 'pathtrace', version: 1, width: 64, height: 48, samples: 4, seed: 0, maxBounces: 8 });
    expect(scene.job.meshes).toHaveLength(2); // the box + the ground
    expect(scene.job.instanceCount).toBe(3);
    expect(row(scene, 0)[0]).toBe(row(scene, 1)[0]);
    expect(row(scene, 1).slice(2)).toEqual([1, 0, 0, 30, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(scene.positions).toHaveLength(scene.normals.length);
    expect(scene.uvs.length / 2).toBe(scene.positions.length / 3);
    const ground = scene.job.meshes[1]!;
    expect(ground.indexCount).toBe(6);
    expect(scene.positions[ground.vertexOffset * 3 + 2]).toBeCloseTo(-5, 9); // ground at the lowest point (centred box: z = -5)
    expect(result.affected).toEqual([]);
    expect(result.data).toMatchObject({
      illustration: true,
      width: 64,
      height: 48,
      deterministic: true,
      stoppedBy: 'samples',
      device: 'cpu',
    });
    expect(result.summary).toContain('Path-traced 64x48');
    expect(result.summary).toContain('An illustration, not a measurement.');
  });

  it('is pure and leaves the document unchanged', () => {
    const doc = twoBoxes();
    const { port } = fakePort();
    expectPure(doc, () => execute(doc, 'render_realistic', { width: 32, height: 32 }, ctxWith(port)));
  });

  it('ground false leaves the ground out; hidden layers are not drawn', () => {
    let doc = twoBoxes();
    expect(render(doc, { ground: false }).scene.job.instanceCount).toBe(2);
    doc = run(doc, 'add_layer', { name: 'hidden' });
    const layerId = Object.keys(doc.layers).find((id) => doc.layers[id]?.name === 'hidden')!;
    doc = run(doc, 'update_layer', { id: layerId, visible: false });
    doc = run(doc, 'set_entity_layer', { entityId: doc.order[0], layerId });
    expect(render(doc, { ground: false }).scene.job.instanceCount).toBe(1);
  });

  it('places a component instance through the mesh its source solid already has (instance position composed)', () => {
    const { doc } = boxInstance([100, 0, 0]); // the source box stays in the document beside its instance
    const { scene } = render(doc, { ground: false });
    expect(scene.job.meshes).toHaveLength(1);
    expect(scene.job.instanceCount).toBe(2);
    expect(row(scene, 1)[0]).toBe(0);
    expect(row(scene, 1)[5]).toBe(100);
    expect(scene.job.meshes[0]!.indexCount).toBe(12 * 3);
  });

  it('traces a 1000-member instance array as 1000 rows over the one mesh', () => {
    const { doc } = boxInstance([0, 0, 0]);
    const arrayDoc = run(doc, 'add_instance_array', {
      componentId: 'comp-part',
      counts: [10, 10, 10],
      step: [5, 5, 5],
      origin: [0, 0, 50],
    });
    const { scene } = render(arrayDoc, { ground: false });
    expect(scene.job.meshes).toHaveLength(1);
    expect(scene.job.instanceCount).toBe(1002); // source box + its instance + 1000 members
    const last = row(scene, 1001).slice(2);
    expect([last[3], last[7], last[11]]).toEqual([45, 45, 95]);
  });

  it('resolves appearance: material appearance, entity override, textures listed once, sRGB to linear', () => {
    const assets = memoryImageAssets({}, sha256Hex);
    const ctx = { ...defaultContext(), imageAssets: assets };
    let doc = run(createEmptyDocument(), 'import_texture', { name: 'albedo', base64: toBase64(pngBytes(16, 16)) }, ctx);
    const textureId = doc.appearance!.textureOrder[0]!;
    doc = run(doc, 'create_material', { name: 'steel', density: 7850, densityUnit: 'kg/m^3', color: '#999999' });
    doc = run(doc, 'set_material_appearance', { material: 'steel', baseColor: { texture: textureId }, metalness: 1, roughness: 0.2 });
    doc = run(doc, 'add_box', { size: [10, 10, 10] });
    const boxId = doc.order[0]!;
    doc = run(doc, 'assign_material', { entityIds: [boxId], materialName: 'steel' });
    doc = run(doc, 'add_box', { size: [10, 10, 10], position: [20, 0, 0], color: '#ff0000' });
    const { scene } = render(doc, { ground: false }, { imageAssets: assets });
    expect(scene.job.textures).toEqual([{ file: 'tex-0.png', format: 'png', colorSpace: 'srgb' }]);
    expect(scene.textureBytes[0]).toEqual(assets.readImage(doc.appearance!.textures[textureId]!.key));
    const steel = scene.job.materials[row(scene, 0)[1]!]!;
    expect(steel).toMatchObject({ baseColor: [1, 1, 1], baseColorTexture: 0, metalness: 1, roughness: 0.2 });
    const red = scene.job.materials[row(scene, 1)[1]!]!;
    expect(red.baseColor).toEqual([1, 0, 0]);
    expect(red.baseColorTexture).toBeNull();
  });

  it('uses light entities, else the default sun; maps the environment', () => {
    const doc = twoBoxes();
    const plain = render(doc).scene.job;
    expect(plain.lights).toEqual([
      expect.objectContaining({ type: 'sun', irradiance: [DEFAULT_SUN_IRRADIANCE, DEFAULT_SUN_IRRADIANCE, DEFAULT_SUN_IRRADIANCE] }),
    ]);
    expect(plain.environment).toEqual({ type: 'default' });
    let lit = run(doc, 'add_light', { lightType: 'point', position: [0, 0, 40], intensity: 100 });
    lit = run(lit, 'add_light', { lightType: 'area', position: [0, 0, 60], target: [0, 0, 0], width: 4, height: 2, intensity: 50 });
    lit = run(lit, 'add_light', { lightType: 'spot', position: [0, 40, 40], target: [0, 0, 0], intensity: 20 });
    lit = run(lit, 'set_environment', { source: 'color', color: '#ffffff', intensity: 0.5 });
    const job = render(lit).scene.job;
    expect(job.lights.map((light) => light.type)).toEqual(['point', 'area', 'spot']);
    const area = job.lights[1];
    if (area?.type !== 'area') throw new Error('not an area light');
    expect(Math.hypot(...area.uAxis)).toBeCloseTo(4, 9);
    expect(Math.hypot(...area.vAxis)).toBeCloseTo(2, 9);
    expect(area.normal[2]).toBeCloseTo(-1, 9);
    expect(job.environment).toEqual({ type: 'color', color: [1, 1, 1], intensity: 0.5 });
    const sky = render(run(doc, 'set_environment', { source: 'sky', turbidity: 4 })).scene.job.environment;
    expect(sky).toMatchObject({ type: 'sky', turbidity: 4 });
  });

  it('lists an HDR environment texture and passes its bytes', () => {
    const assets = memoryImageAssets({}, sha256Hex);
    const ctx = { ...defaultContext(), imageAssets: assets };
    let doc = run(twoBoxes(), 'import_texture', { name: 'sky', base64: toBase64(hdrBytes(32, 16)) }, ctx);
    const hdr = doc.appearance!.textureOrder[0]!;
    doc = run(doc, 'set_environment', { source: 'hdr', texture: hdr, rotation: 0.5, intensity: 2 });
    const { scene } = render(doc, {}, { imageAssets: assets });
    expect(scene.job.environment).toEqual({ type: 'hdr', texture: 0, rotation: 0.5, intensity: 2 });
    expect(scene.job.textures[0]).toEqual({ file: 'tex-0.hdr', format: 'hdr', colorSpace: 'linear' });
  });

  it('renders through a camera entity with depth of field, and through a framed orthographic view', () => {
    let doc = twoBoxes();
    doc = run(doc, 'add_camera', { position: [0, -100, 20], target: [15, 0, 5], focalLength: 50, fStop: 2, focusDistance: 100 });
    const cameraId = doc.order[doc.order.length - 1]!;
    const { scene, result } = render(doc, { camera: cameraId });
    expect(scene.job.camera.projection).toBe('perspective');
    expect(scene.job.camera.apertureRadius).toBeCloseTo(12.5, 9); // 50 mm / (2 x 2) in a mm document
    expect(scene.job.camera.focusDistance).toBe(100);
    expect(result.data).toMatchObject({ cameraId });
    const ortho = render(twoBoxes(), { view: 'top', projection: 'orthographic' }).scene.job.camera;
    expect(ortho).toMatchObject({ projection: 'orthographic', forward: [0, 0, -1] });
    expect(ortho.orthoHeight).toBeGreaterThan(0);
  });

  it('passes the job knobs through and reports the native provenance', () => {
    const { port } = fakePort((scene) => ({
      ok: true,
      image: image(scene, {
        stats: {
          ...image(scene).stats,
          device: 'cpu',
          deterministic: false,
          stoppedBy: 'time',
          fallbackReason: 'no GPU path tracer in this build',
        },
        warnings: [{ code: 'NATIVE_PATHTRACE_CPU_FALLBACK', message: 'cpu' }],
      }),
    }));
    const params = {
      width: 32,
      height: 16,
      samples: 64,
      targetNoise: 0.05,
      maxBounces: 3,
      seed: 7,
      denoise: true,
      engine: 'gpu',
      exposure: 1,
      exr: false,
      maxSeconds: 5,
    };
    const result = execute(twoBoxes(), 'render_realistic', params, ctxWith(port));
    expect(result.data).toMatchObject({
      deterministic: false,
      stoppedBy: 'time',
      fallbackReason: 'no GPU path tracer in this build',
      samplesRequested: 64,
    });
    const data = result.data as { files: { name: string }[]; warnings: { code: string }[] };
    expect(data.files.map((file) => file.name)).toEqual(['render.png']);
    expect(data.warnings.map((warning) => warning.code)).toEqual(['NATIVE_PATHTRACE_CPU_FALLBACK']);
    expect(result.summary).toContain('stopped by maxSeconds 5');
    expect(result.summary).toContain('not deterministic');
  });

  it('returns the EXR inline, or through the export file sink when it is over the inline limit', () => {
    const inline = render(twoBoxes()).result.data as { files: { name: string; base64: string }[] };
    expect(inline.files.map((file) => file.name)).toEqual(['render.png', 'render.exr']);
    const big = new Uint8Array(EXR_INLINE_MAX_BYTES + 1);
    const written: Uint8Array[] = [];
    const sink: ExportFilePort = {
      open: () => ({
        write: (chunk) => written.push(chunk),
        patch: () => undefined,
        close: () => ({ path: '/exports/render.exr' }),
        abort: () => undefined,
      }),
    };
    const { port } = fakePort((scene) => ({ ok: true, image: image(scene, { exr: big }) }));
    const hosted = execute(twoBoxes(), 'render_realistic', { width: 16, height: 16 }, ctxWith(port, { exportFiles: sink }));
    expect(hosted.data).toMatchObject({ file: { path: '/exports/render.exr', bytes: big.length } });
    expect(written[0]).toBe(big);
    const noSink = execute(twoBoxes(), 'render_realistic', { width: 16, height: 16 }, ctxWith(port, { exportFiles: null }));
    expect((noSink.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['RENDER_EXR_NOT_RETURNED']);
  });
});

describe('render_realistic refusals', () => {
  it('NATIVE_TOOL_MISSING without a port', () => {
    const doc = twoBoxes();
    const result = execute(doc, 'render_realistic', {}, ctxWith(null));
    expectNoOp(result, doc);
    expect(codeOf(result)).toBe('NATIVE_TOOL_MISSING');
  });

  it('RENDER_SCENE_EMPTY for nothing visible', () => {
    const { port, scenes } = fakePort();
    const result = execute(createEmptyDocument(), 'render_realistic', {}, ctxWith(port));
    expect(codeOf(result)).toBe('RENDER_SCENE_EMPTY');
    expect(scenes).toHaveLength(0);
  });

  it('camera refusals are named', () => {
    const doc = twoBoxes();
    const { port } = fakePort();
    expect(codeOf(execute(doc, 'render_realistic', { camera: 'nope' }, ctxWith(port)))).toBe('SCENE_CAMERA_NOT_FOUND');
    expect(codeOf(execute(doc, 'render_realistic', { camera: doc.order[0] }, ctxWith(port)))).toBe('SCENE_NOT_A_CAMERA');
    expect(codeOf(execute(doc, 'render_realistic', { viewpointId: 'nope' }, ctxWith(port)))).toBe('VIS_VIEWPOINT_NOT_FOUND');
    expect(codeOf(execute(doc, 'render_realistic', { fovDeg: 200 }, ctxWith(port)))).toBe('VIS_CAMERA_INVALID');
  });

  it('RENDER_NO_LIGHT when every light is zero and the environment is black', () => {
    let doc = run(twoBoxes(), 'add_light', { lightType: 'point', position: [0, 0, 40], intensity: 0 });
    doc = run(doc, 'set_environment', { source: 'color', color: '#000000', intensity: 1 });
    const { port } = fakePort();
    const result = execute(doc, 'render_realistic', {}, ctxWith(port));
    expectNoOp(result, doc);
    expect(codeOf(result)).toBe('RENDER_NO_LIGHT');
  });

  it('TEXTURE_ASSET_UNAVAILABLE when the host lacks a texture file', () => {
    const assets = memoryImageAssets({}, sha256Hex);
    const ctx = { ...defaultContext(), imageAssets: assets };
    let doc = run(twoBoxes(), 'import_texture', { name: 'albedo', base64: toBase64(pngBytes(8, 8)) }, ctx);
    const textureId = doc.appearance!.textureOrder[0]!;
    doc = run(doc, 'apply_appearance', { appearance: 'painted', entityIds: [doc.order[0]] });
    doc = {
      ...doc,
      entities: {
        ...doc.entities,
        [doc.order[0]!]: { ...doc.entities[doc.order[0]!]!, appearance: { baseColor: { texture: textureId } } },
      },
    };
    const { port } = fakePort();
    const result = execute(doc, 'render_realistic', {}, ctxWith(port, { imageAssets: memoryImageAssets({}, sha256Hex) }));
    expect(codeOf(result)).toBe('TEXTURE_ASSET_UNAVAILABLE');
    expect(result.error?.ids).toEqual([textureId]);
  });

  it('passes the native refusal code on', () => {
    const { port } = fakePort(() => ({ ok: false, code: 'PATHTRACE_JOB_INVALID', message: 'camera.forward is zero' }));
    const doc = twoBoxes();
    const result = execute(doc, 'render_realistic', {}, ctxWith(port));
    expectNoOp(result, doc);
    expect(codeOf(result)).toBe('PATHTRACE_JOB_INVALID');
  });

  it('rejects out-of-range params through the schema', () => {
    const { port } = fakePort();
    const result = execute(twoBoxes(), 'render_realistic', { width: 9000 }, ctxWith(port));
    expect(result.summary).toContain('invalid params');
  });
});

describe('affine', () => {
  it('composes T R S like the instance expansion', () => {
    const m = compose(placement([10, 0, 0], [0, 0, Math.PI / 2]), placement([1, 0, 0], [0, 0, 0], [2, 2, 2]));
    const p = transformPoint(m, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(10, 9);
    expect(p[1]).toBeCloseTo(3, 9);
  });
});
