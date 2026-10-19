/**
 * VC-VIS-60 (plant 09 VIS-M9, RS1 RS-5): the native raster behind `ctx.raster`. The CPU twin of `llull-compute raster` returns exactly
 * the reference RGBA; the GPU (a build with `--features gpu` and an adapter, else the CPU twin answers with the reason) draws render_view,
 * render_walkthrough and BCF snapshots within the stated tolerance (coverage IoU >= 0.97, mean |dRGB| <= 8 levels) and never yields a
 * digest. Native runs need llull-compute (cargo build in solver/) and are skipped with a logged reason otherwise.
 */

import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { getRasterPort, setRasterPort } from '@core/commands/rasterPort';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RasterPort, RasterScene } from '@core/model/raster';
import { rasterScenePixels } from '@core/commands/render/raster';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeRasterPort, installRasterPort } from '../src/native/rasterPort';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('visNativeParity: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

type Json = Record<string, unknown>;

function plant(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Json): void => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
  };
  run('add_box', { size: [40, 20, 12], color: '#c05030' });
  run('add_cylinder', { radius: 5, height: 30, position: [30, 0, 5], color: '#3070c0' });
  run('draw_polyline', {
    points: [
      [-40, -30],
      [40, 25],
    ],
  });
  run('save_viewpoint', { name: 'a', camera: { projection: 'perspective', eye: [0, -90, 30], direction: [0, 1, -0.3], fovDeg: 45 } });
  run('save_viewpoint', { name: 'b', camera: { projection: 'perspective', eye: [90, 0, 30], direction: [-1, 0, -0.3], fovDeg: 45 } });
  run('create_walkthrough', {
    name: 'w',
    keys: [
      { viewpointId: 'vp-1', seconds: 1 },
      { viewpointId: 'vp-2', seconds: 1 },
    ],
  });
  run('create_review_issue', { title: 'gap', viewpointIds: ['vp-1'] });
  return doc;
}

/** RGBA of a PNG written by encodePng (filters None / Up). */
function rgbaOfPng(png: Buffer): Uint8Array {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      out[y * stride + x] = filter === 2 && y > 0 ? (value + (out[(y - 1) * stride + x] ?? 0)) & 0xff : value;
    }
  }
  return out;
}

const pngOfSvg = (svg: string): Buffer => Buffer.from(/href="data:image\/png;base64,([^"]+)"/.exec(svg)?.[1] ?? '', 'base64');

/** Coverage IoU and mean |dRGB| over the pixels both images cover. */
function agreement(a: Uint8Array, b: Uint8Array): { iou: number; mean: number } {
  let [both, either, sum] = [0, 0, 0];
  for (let i = 0; i < a.length; i += 4) {
    const [ca, cb] = [(a[i + 3] ?? 0) > 0, (b[i + 3] ?? 0) > 0];
    if (ca || cb) either++;
    if (!(ca && cb)) continue;
    both++;
    for (let k = 0; k < 3; k++) sum += Math.abs((a[i + k] ?? 0) - (b[i + k] ?? 0));
  }
  return { iou: both / Math.max(either, 1), mean: sum / Math.max(both * 3, 1) };
}

/** The scenes render_view hands to its pixel stage (captured through a recording port). */
function scenesOf(doc: CadDocument, params: Json): RasterScene[] {
  const scenes: RasterScene[] = [];
  const recorder: RasterPort = {
    render: (scene) => {
      scenes.push(scene);
      return {
        ok: true,
        image: { rgba: rasterScenePixels(scene), device: 'record', deterministic: true, engine: 'native-cpu', version: '' },
      };
    },
  };
  execute(doc, 'render_view', { ...params, renderer: 'native' }, { ...defaultContext(), raster: recorder });
  return scenes;
}

describe('native raster port (llull-compute raster, scene job)', () => {
  native('the CPU twin returns the reference RGBA exactly (orthographic, cutaway, perspective)', () => {
    const port = createNativeRasterPort(BINARY ?? '');
    const doc = plant();
    const scenes = [
      ...scenesOf(doc, { width: 200, height: 150 }),
      ...scenesOf(doc, { width: 160, height: 120, cut: { planes: [{ normal: [1, 0, 0], offset: 0 }] } }),
      ...scenesOf(doc, { viewpointId: 'vp-1', width: 180, height: 120 }),
    ];
    expect(scenes).toHaveLength(3);
    for (const scene of scenes) {
      const outcome = port.render(scene, 'cpu');
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.image).toMatchObject({ engine: 'native-cpu', device: 'cpu', version: expect.stringMatching(/^llull-compute \d/) });
      expect(Buffer.from(outcome.image.rgba).equals(Buffer.from(rasterScenePixels(scene)))).toBe(true);
    }
  });

  native('render_view renderer native draws a picture within tolerance of the reference, without a digest', () => {
    const doc = plant();
    const ctx = { ...defaultContext(), raster: createNativeRasterPort(BINARY ?? '') };
    for (const params of [
      { width: 320, height: 240 },
      { viewpointId: 'vp-2', width: 320, height: 200 },
    ]) {
      const result = execute(doc, 'render_view', { ...params, renderer: 'native' }, ctx);
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Json;
      expect(data).toMatchObject({ renderer: 'native', deterministic: false });
      expect(data['svgSha256']).toBeUndefined();
      if (data['engine'] === 'native-cpu') console.warn(`visNativeParity: GPU not used (${String(data['reason'])}); compared the CPU twin`);
      const reference = execute(doc, 'render_view', params).data as Json;
      const { iou, mean } = agreement(rgbaOfPng(pngOfSvg(String(data['svg']))), rgbaOfPng(pngOfSvg(String(reference['svg']))));
      console.warn(
        `visNativeParity render_view ${JSON.stringify(params)} on ${String(data['device'])}: IoU ${iou.toFixed(4)}, mean ${mean.toFixed(2)}`,
      );
      expect(iou).toBeGreaterThanOrEqual(0.97);
      expect(mean).toBeLessThanOrEqual(8);
    }
  });

  native('walkthrough frames and BCF snapshots draw natively through the installed port', () => {
    const previous = getRasterPort();
    expect(installRasterPort()).toBe(true);
    try {
      const doc = plant();
      const frames = execute(doc, 'render_walkthrough', { id: 'wt-3', fps: 2, width: 160, height: 90, renderer: 'native' });
      expect(frames.error, frames.summary).toBeUndefined();
      const reference = execute(doc, 'render_walkthrough', { id: 'wt-3', fps: 2, width: 160, height: 90 });
      const nativeFiles = (frames.data as { files: { base64: string }[] }).files;
      const referenceFiles = (reference.data as { files: { base64: string }[] }).files;
      expect(nativeFiles).toHaveLength(3);
      nativeFiles.forEach((file, i) => {
        const { iou, mean } = agreement(
          rgbaOfPng(Buffer.from(file.base64, 'base64')),
          rgbaOfPng(Buffer.from(referenceFiles[i]?.base64 ?? '', 'base64')),
        );
        expect(iou).toBeGreaterThanOrEqual(0.97);
        expect(mean).toBeLessThanOrEqual(8);
      });
      const bcf = execute(doc, 'export_bcf', { snapshotRenderer: 'native', snapshotWidth: 160, snapshotHeight: 120 });
      expect(bcf.error, bcf.summary).toBeUndefined();
      expect(bcf.data).toMatchObject({ snapshotRenderer: 'native', deterministic: false, snapshots: 1 });
    } finally {
      setRasterPort(previous);
    }
  });

  it('refuses with a code (no silent fallback) when the binary cannot run, and installs nothing without a binary', () => {
    const broken = createNativeRasterPort(process.execPath, { ...process.env, NODE_OPTIONS: '' });
    const [scene] = scenesOf(plant(), { width: 80, height: 60 });
    if (scene === undefined) throw new Error('no scene');
    const outcome = broken.render(scene, 'gpu');
    expect(outcome).toMatchObject({ ok: false, code: 'NATIVE_PROTOCOL' });
    const missing = createNativeRasterPort('Z:/no/such/llull-compute.exe').render(scene, 'cpu');
    expect(missing).toMatchObject({ ok: false, code: 'NATIVE_TOOL_MISSING' });
    const previous = getRasterPort();
    try {
      expect(installRasterPort({ LLULL_COMPUTE: 'Z:/no/such/llull-compute.exe' })).toBe(false);
      expect(getRasterPort()).toBeNull();
      expect(execute(plant(), 'render_view', { renderer: 'native' }).error?.code).toBe('NATIVE_TOOL_MISSING');
    } finally {
      setRasterPort(previous);
    }
  });
});
