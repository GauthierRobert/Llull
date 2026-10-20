/**
 * TypeScript reference for the `llull-raster` scene twin (plant 09 VC-VIS-60 at crate level): the RasterScene buffers render_view prepares
 * for a few documents (orthographic, cutaway caps, 2D strokes, perspective with near-plane clipping, unsupersampled) and the sha256 of the
 * RGBA `rasterScenePixels` writes. `solver/crates/llull-raster/tests/scene_reference.rs` requires the CPU twin to hash identically.
 * Regenerate with LLULL_WRITE_NATIVE_FIXTURES=1.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RasterScene } from '@core/model/raster';
import { rasterScenePixels } from '@core/commands/render/raster';

const FILE = path.resolve(__dirname, '../../../solver/crates/llull-raster/tests/fixtures/scene.json');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function plant(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): void => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
  };
  run('add_box', { size: [40, 20, 12], color: '#c05030' });
  run('add_cylinder', { radius: 5, height: 30, position: [30, 0, 5], color: '#3070c0' });
  run('add_box', { size: [10, 10, 10], position: [-25, 15, 0], color: '#40a060' });
  run('draw_polyline', {
    points: [
      [-40, -30],
      [40, 25],
      [10, 30],
    ],
  });
  run('draw_polyline', {
    points: [
      [-5, -5],
      [5, 5],
    ],
  });
  return doc;
}

/** The scenes render_view hands to its pixel stage for `params` (captured through a raster port). */
function scenesOf(doc: CadDocument, params: Record<string, unknown>): RasterScene[] {
  const scenes: RasterScene[] = [];
  const port = {
    render: (scene: RasterScene) => {
      scenes.push(scene);
      const image = {
        rgba: rasterScenePixels(scene),
        device: 'capture',
        deterministic: false,
        engine: 'native-cpu',
        version: 'test',
      } as const;
      return { ok: true, image } as const;
    },
  };
  const native = execute(doc, 'render_view', { ...params, renderer: 'native' }, { ...defaultContext(), raster: port });
  const reference = execute(doc, 'render_view', params);
  expect((native.data as { svg: string }).svg).toBe((reference.data as { svg: string }).svg);
  return scenes;
}

function cases(): { name: string; scene: RasterScene }[] {
  const doc = plant();
  const inside = execute(execute(doc, 'add_box', { size: [300, 300, 120], color: '#909090' }).document, 'save_viewpoint', {
    name: 'inside',
    camera: { projection: 'perspective', eye: [0, -60, 15], direction: [0.2, 1, -0.15], fovDeg: 70 },
  }).document;
  const one = (name: string, d: CadDocument, params: Record<string, unknown>): { name: string; scene: RasterScene } => {
    const [scene] = scenesOf(d, params);
    if (scene === undefined) throw new Error(`no scene for ${name}`);
    return { name, scene };
  };
  return [
    one('iso', doc, { width: 160, height: 120 }),
    one('cutaway', doc, {
      width: 140,
      height: 110,
      cut: {
        planes: [
          { normal: [1, 0, 0], offset: 0 },
          { normal: [0, -1, 0], offset: 0 },
        ],
      },
    }),
    one('perspective-inside', inside, { viewpointId: 'vp-1', width: 150, height: 100 }),
    one('perspective-iso', doc, { projection: 'perspective', fovDeg: 35, width: 128, height: 96 }),
    one('unsupersampled', doc, { view: 'front', width: 1100, height: 1100 }),
  ];
}

describe('scene raster reference fixtures', () => {
  it('RasterScene buffers and RGBA hashes of the TypeScript per-pixel stage', () => {
    const entries = cases().map(({ name, scene }) => {
      const rgba = rasterScenePixels(scene);
      const { faces, fills, loops, points, strokes, ...job } = scene;
      return {
        name,
        job: { kind: 'scene', ...job },
        faces: Array.from(faces),
        fills: Array.from(fills),
        loops: Array.from(loops),
        points: Array.from(points),
        strokes: Array.from(strokes),
        rgbaSha256: sha(rgba),
        covered: rgba.filter((_, i) => i % 4 === 3 && rgba[i] !== 0).length,
      };
    });
    expect(entries.every((entry) => entry.covered > 1000)).toBe(true);
    expect(entries.find((entry) => entry.name === 'cutaway')?.faces.some((v, i) => i % 8 === 7 && v === 1)).toBe(true);
    expect(entries.some((entry) => entry.strokes.length > 0 && entry.job.projection === 'perspective')).toBe(true);
    expect(entries.find((entry) => entry.name === 'unsupersampled')?.job.samples).toBe(1);
    const text = `${JSON.stringify(entries)}\n`;
    if (process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1') writeFileSync(FILE, text);
    const stored = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(stored === text, 'scene.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
