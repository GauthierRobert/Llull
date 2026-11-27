import { describe, expect, it } from 'vitest';
import { DEFAULT_UV_SCALE, meshNormals, meshUvs } from '@core/geometry/meshUvs';
import { readImageHeader } from '@lib/imageHeader';
import { hdrBytes, jpegBytes, pngBytes } from '../helpers/imageHeaderFixtures';

/** Unit cube corner at the origin: three triangles, one per axis-aligned face. */
const faceX = { positions: [0, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 2, 1] };
const floor = { positions: [0, 0, 0, 10, 0, 0, 0, 20, 0], indices: [0, 1, 2] };

describe('meshNormals', () => {
  it('returns stored normals of the right length untouched, ignores a wrong length', () => {
    const stored = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    expect(meshNormals({ ...floor, normals: stored })).toBe(stored);
    expect(meshNormals({ ...floor, normals: [0, 0, 1] })).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('derives area-weighted unit normals: a +Z triangle, a -X triangle, and +Z for an unused vertex', () => {
    expect(meshNormals(floor)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(meshNormals(faceX)).toEqual([-1, 0, 0, -1, 0, 0, -1, 0, 0]);
    expect(meshNormals({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5], indices: [0, 1, 2] }).slice(9)).toEqual([0, 0, 1]);
  });

  it('weights a shared vertex by triangle area and skips degenerate and out-of-range triangles', () => {
    const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], indices: [0, 1, 2, 0, 3, 3, 0, 1, 99] };
    const normals = meshNormals(mesh);
    expect(normals.slice(0, 3)).toEqual([0, 0, 1]);
    expect(Number.isFinite(normals[10])).toBe(true);
  });
});

describe('meshUvs', () => {
  it('returns stored uvs of length 2 x vertices, and projects when the length is wrong', () => {
    const stored = [0, 0, 1, 0, 0, 1];
    expect(meshUvs({ ...floor, uvs: stored }, 5)).toBe(stored);
    expect(meshUvs({ ...floor, uvs: [0, 0] }, 10)).toHaveLength(6);
  });

  it('box-projects on the dominant axis of the vertex normal, divided by uvScale', () => {
    expect(meshUvs(floor, 10)).toEqual([0, 0, 1, 0, 0, 2]);
    expect(meshUvs(faceX, 2)).toEqual([0, 0, 0.5, 0, 0, 0.5]);
    const side = { positions: [0, 0, 0, 4, 0, 0, 0, 0, 8], indices: [0, 1, 2] }; // normal -Y: projects x, z
    expect(meshUvs(side, 4)).toEqual([0, 0, 1, 0, 0, 2]);
  });

  it('falls back to the default scale for a non-positive or non-finite uvScale', () => {
    expect(meshUvs(floor, 0)).toEqual(meshUvs(floor, DEFAULT_UV_SCALE));
    expect(meshUvs(floor, Number.NaN)).toEqual(meshUvs(floor));
    expect(meshUvs(floor)[2]).toBeCloseTo(10 / DEFAULT_UV_SCALE);
  });
});

describe('readImageHeader', () => {
  it('reads PNG, JPEG (SOF0 / SOF2, behind other segments) and Radiance HDR sizes', () => {
    expect(readImageHeader(pngBytes(640, 480))).toEqual({ format: 'png', width: 640, height: 480 });
    expect(readImageHeader(jpegBytes(33, 17))).toEqual({ format: 'jpeg', width: 33, height: 17 });
    expect(readImageHeader(jpegBytes(33, 17, 0xc2))).toEqual({ format: 'jpeg', width: 33, height: 17 });
    expect(readImageHeader(hdrBytes(4096, 2048))).toEqual({ format: 'hdr', width: 4096, height: 2048 });
    expect(readImageHeader(new TextEncoder().encode('#?RGBE\n\n-Y 2 +X 3\n'))).toEqual({ format: 'hdr', width: 3, height: 2 });
  });

  it('returns null for anything else and for truncated or table-only JPEGs', () => {
    expect(readImageHeader(new Uint8Array())).toBeNull();
    expect(readImageHeader(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(readImageHeader(pngBytes(4, 4).subarray(0, 23))).toBeNull();
    const badChunk = pngBytes(4, 4).slice();
    badChunk[12] = 0x58;
    expect(readImageHeader(badChunk)).toBeNull();
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xc4, 0, 4, 0, 0]))).toBeNull();
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]))).toBeNull();
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0]))).toBeNull();
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0]))).toBeNull();
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xd0, 0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 5, 0, 6, 3]))).toEqual(
      { format: 'jpeg', width: 6, height: 5 },
    );
  });
});
