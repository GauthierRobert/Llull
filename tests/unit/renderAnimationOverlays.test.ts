/**
 * Overlay primitives and text of render_animation (TR-MOV-07): the raster-scene append, the fonts a host may inject (an outline font, a single-line stroke
 * font, none, an unreadable one), the contact sheet without labels, and the image reduction.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { rasterScenePixels } from '@core/commands/render/raster';
import { appendOverlay, emptyScene } from '@core/commands/render/animation/rasterOverlay';
import { downscale, cellSize } from '@core/commands/render/animation/sheet';
import type { FontProvider } from '@core/geometry/fontPort';
import type { CadDocument } from '@core/model/types';
import { decodePng, fileBytes, pixelAt, planDocument, type AnimationData } from './renderAnimationFixtures';

afterEach(() => setFontProvider(null));

const strokeFont = (): FontProvider => {
  const bytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'server/fonts/LlullSingleLine.json')));
  return {
    list: () => [
      { id: 'llull-single-line', family: 'LLULL Single Line', style: 'Regular', licence: 'CC0-1.0', sha256: 'stroke-test', source: 'test' },
    ],
    bytes: (id) => (id === 'llull-single-line' ? bytes : null),
  };
};

const brokenFont = (): FontProvider => ({
  list: () => [
    { id: 'broken', family: 'Broken', style: 'Regular', licence: 'none', sha256: 'broken-test', source: 'test' },
    { id: 'missing', family: 'Missing', style: 'Regular', licence: 'none', sha256: 'missing-test', source: 'test' },
  ],
  bytes: (id) => (id === 'broken' ? new Uint8Array([1, 2, 3, 4]) : null),
});

const timeLabel = (): { document: CadDocument; params: Record<string, unknown> } => {
  const { document, render } = planDocument('mov_clip_spin.plan.json');
  return { document, params: { ...render.params, format: 'frames', width: 320, height: 240, overlays: { time: true } } };
};

const inkAt = (data: AnimationData): number => {
  const image = decodePng(fileBytes(data, 'frame-0006.png'));
  let ink = 0;
  for (let y = 0; y < 30; y += 1)
    for (let x = 0; x < 100; x += 1) if ((pixelAt(image, x, y)[0] ?? 0) > 200 && (pixelAt(image, x, y)[2] ?? 0) > 200) ink += 1;
  return ink;
};

describe('fonts of the overlays', () => {
  it('draws the labels with a single-line stroke font (strokes instead of outline fills)', () => {
    setFontProvider(strokeFont());
    const { document, params } = timeLabel();
    const data = execute(document, 'render_animation', params).data as AnimationData;
    expect(data.warnings.map((w) => w.code)).not.toContain('MOV_OVERLAY_TEXT_SKIPPED');
    expect(inkAt(data)).toBeGreaterThan(10);
  });

  it('skips the text with a warning when the host has no font, an empty list, or fonts that do not parse', () => {
    const { document, params } = timeLabel();
    for (const provider of [null, { list: () => [], bytes: () => null } as FontProvider, brokenFont()]) {
      setFontProvider(provider);
      const data = execute(document, 'render_animation', params).data as AnimationData;
      expect(data.warnings.map((w) => w.code)).toContain('MOV_OVERLAY_TEXT_SKIPPED');
      expect(inkAt(data)).toBe(0);
    }
  });

  it('builds the contact sheet without labels when there is no font; one frame cannot show motion', () => {
    const { document, params } = timeLabel();
    const data = execute(document, 'render_animation', { ...params, overlays: undefined, sheet: { every: 100 } }).data as AnimationData;
    expect(data.sheet).toMatchObject({ frames: [0, 20], columns: 2 });
    expect(data.warnings.map((w) => w.code)).toContain('MOV_OVERLAY_TEXT_SKIPPED');
    const short = { ...params, overlays: undefined, source: { kind: 'clips', duration: 0.05 } };
    const one = execute(document, 'render_animation', short);
    expect(one.error?.code).toBe('MOV_NO_MOTION');
    expect(one.summary).toContain('all 1 frames');
  });
});

describe('appendOverlay', () => {
  it('appends faces, fills, loops, points and strokes after the scene content without changing the input scene', () => {
    const scene = emptyScene(20, 10);
    const out = appendOverlay(scene, {
      fills: [
        {
          color: [1, 2, 3],
          z: -5,
          loops: [
            [
              [0, 0],
              [10, 0],
              [10, 5],
              [0, 5],
            ],
          ],
        },
        {
          color: [4, 5, 6],
          z: -5,
          loops: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
      ],
      strokes: [
        { color: [7, 8, 9], z: -6, halfWidth: 1, points: [[2, 2]] },
        { color: [7, 8, 9], z: -6, halfWidth: 1, points: [] },
        {
          color: [7, 8, 9],
          z: -6,
          halfWidth: 1,
          points: [
            [1, 1],
            [5, 5],
            [9, 1],
          ],
        },
      ],
    });
    expect(scene.faces).toHaveLength(0);
    expect(out.faces).toHaveLength(8 * 3);
    expect(out.fills).toEqual(Float64Array.from([0, 0, 1]));
    expect(out.loops).toEqual(Float64Array.from([0, 4]));
    expect(out.points).toHaveLength(12);
    expect(out.strokes).toHaveLength(9 * 3);
    expect(out.points[0]).toBe(0);
    expect(out.points[3]).toBe(20);
    expect(out.strokes[7]).toBe(2);
  });

  it('draws a one-point stroke as a disc and a square fill as a square, in front of nothing', () => {
    const out = appendOverlay(emptyScene(20, 20), {
      fills: [
        {
          color: [200, 0, 0],
          z: -1e7,
          loops: [
            [
              [2, 2],
              [8, 2],
              [8, 8],
              [2, 8],
            ],
          ],
        },
      ],
      strokes: [{ color: [0, 200, 0], z: -1e7, halfWidth: 3, points: [[15, 15]] }],
    });
    const image = { width: 20, rgba: rasterScenePixels(out) };
    expect(pixelAt(image, 5, 5).slice(0, 3)).toEqual([200, 0, 0]);
    expect(pixelAt(image, 15, 15).slice(0, 3)).toEqual([0, 200, 0]);
    expect(pixelAt(image, 12, 5)[3]).toBe(0);
  });
});

describe('contact sheet helpers', () => {
  it('reduces an image by area averaging (a 2 × 2 block of 0 / 100 / 200 / 100 averages to 100)', () => {
    const source = new Uint8Array(16);
    [0, 100, 200, 100].forEach((value, i) => source.set([value, value, value, 255], i * 4));
    const reduced = downscale(source, 2, 2, 1, 1);
    expect(Array.from(reduced)).toEqual([100, 100, 100, 255]);
    expect(Array.from(downscale(source, 2, 2, 2, 2))).toEqual(Array.from(source));
  });

  it('caps the cell at 320 px wide keeping the aspect ratio, and never enlarges', () => {
    expect(cellSize(1280, 720)).toEqual({ width: 320, height: 180 });
    expect(cellSize(200, 100)).toEqual({ width: 200, height: 100 });
  });
});
