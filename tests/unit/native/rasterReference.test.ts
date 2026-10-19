/**
 * TypeScript raster reference for the `llull-raster` CPU twin (05 TR-FEA-92, VC-FEA-29 at crate level): the per-face stage output and the
 * sha256 of the RGBA / depth the per-pixel stage writes. Regenerate with LLULL_WRITE_NATIVE_FIXTURES=1 (see nativeReference.test.ts).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finishRaster, prepareRaster, rasterField, rasterPixels } from '@cae/results/fieldRaster';
import { rasterCases } from './rasterCases';

const FILE = path.resolve(__dirname, '../../../solver/crates/llull-raster/tests/fixtures/raster.json');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('raster reference fixtures', () => {
  it('per-face buffers and pixel hashes of the TypeScript raster', () => {
    const cases = rasterCases().map(({ name, raster }) => {
      const prepared = prepareRaster(raster);
      const pixels = rasterPixels(prepared);
      expect(finishRaster(raster, prepared, pixels).image).toBe(rasterField(raster).image);
      const { ghostTriangles, triangles, light, normals, owners, caps, ...job } = prepared;
      return {
        name,
        job,
        ghost: Array.from(ghostTriangles),
        triangles: Array.from(triangles),
        light: Array.from(light),
        normals: Array.from(normals),
        owners: Array.from(owners),
        caps: Array.from(caps),
        rgbaSha256: sha(pixels.rgba),
        depthSha256: sha(new Uint8Array(pixels.depth.buffer)),
        covered: pixels.rgba.filter((_, i) => i % 4 === 3 && pixels.rgba[i] !== 0).length,
      };
    });
    expect(cases.every((entry) => entry.covered > 1000)).toBe(true);
    const text = `${JSON.stringify(cases)}\n`;
    if (process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1') writeFileSync(FILE, text);
    expect(readFileSync(FILE, 'utf8') === text, 'raster.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
