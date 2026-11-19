/**
 * PERF1 §5 row 10: a raster port that returns the PNG of its pixels (`RasterImage.png`) has it embedded in the render as is; a port without
 * one gets the TypeScript encoder, so both pictures carry the same image bytes when the port's PNG is `encodePng(…, true)`.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument } from '@core/model/types';
import type { RasterPort } from '@core/model/raster';
import { rasterScenePixels } from '@core/commands/render/raster';
import { encodePng } from '@lib/png';

const doc = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 6] }).document;
const pngOf = (svg: unknown): string => /href="data:image\/png;base64,([^"]+)"/.exec(String(svg))?.[1] ?? '';

function port(png: (width: number, height: number, rgba: Uint8Array) => Uint8Array | undefined): RasterPort {
  return {
    render: (scene) => {
      const rgba = rasterScenePixels(scene);
      const encoded = png(scene.width, scene.height, rgba);
      return {
        ok: true,
        image: {
          rgba,
          device: 'cpu',
          deterministic: true,
          engine: 'native-cpu',
          version: 'test',
          ...(encoded === undefined ? {} : { png: encoded }),
        },
      };
    },
  };
}

const render = (raster: RasterPort): unknown =>
  (execute(doc, 'render_view', { width: 96, height: 64, renderer: 'native' }, { ...defaultContext(), raster }).data as { svg: unknown })
    .svg;

describe('native PNG of a raster port', () => {
  it('is embedded as is', () => {
    const marker = new Uint8Array([1, 2, 3, 4, 5]);
    expect(pngOf(render(port(() => marker)))).toBe(Buffer.from(marker).toString('base64'));
  });

  it('without one the TypeScript encoder writes the same bytes the port would', () => {
    const encoded = render(port((width, height, rgba) => encodePng(width, height, rgba, true)));
    const plain = render(port(() => undefined));
    expect(pngOf(plain).length).toBeGreaterThan(100);
    expect(encoded).toBe(plain);
  });
});
