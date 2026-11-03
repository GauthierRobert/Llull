/**
 * query_cloud_points attributes (rgb / intensity / classification) through the real asset: a hand-built LAS 1.2 (point format 2) with known
 * values, a CSV without attributes (missingAttributes) and the coloured E57 cube, via the Node PointCloudPort and the registry command.
 * Native cases need `llull-compute` (cargo build --profile compute -p llull-compute in solver/) and skip with a logged reason without it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument } from '@core/model/types';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runScanImport } from '../src/scan/scanImport';
import { DEFAULT_IMPORT_OPTIONS } from '../src/scan/scanStore';
import { createPointCloudPort } from '../src/scan/pointCloudPort';
import { AssetReader, crc32 } from '../src/scan/assetReader';

const DATA = path.resolve(__dirname, '../../docs/plant/10-pointcloud-brownfield/validation/data');
const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('scanAttributes: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = BINARY === null ? it.skip : it;

interface LasPoint {
  readonly xyz: readonly [number, number, number];
  readonly intensity: number;
  readonly classification: number;
  readonly rgb16: readonly [number, number, number];
}
const POINTS: LasPoint[] = [
  { xyz: [1, 2, 3], intensity: 10, classification: 2, rgb16: [65535, 0, 256] },
  { xyz: [4, 5, 6], intensity: 20000, classification: 6, rgb16: [0, 65535, 512] },
  { xyz: [7, 8, 9], intensity: 65535, classification: 9, rgb16: [4096, 8192, 65535] },
];

/** LAS 1.2, point format 2 (xyz i32, intensity u16, flags, class, angle, user, source u16, rgb 3 × u16 = 26 bytes), scale 0.001. */
function buildLas(): Buffer {
  const header = 227;
  const buffer = Buffer.alloc(header + 26 * POINTS.length);
  buffer.write('LASF', 0, 'latin1');
  buffer[24] = 1;
  buffer[25] = 2;
  buffer.writeUInt16LE(header, 94);
  buffer.writeUInt32LE(header, 96);
  buffer[104] = 2;
  buffer.writeUInt16LE(26, 105);
  buffer.writeUInt32LE(POINTS.length, 107);
  buffer.writeUInt32LE(POINTS.length, 111);
  for (let a = 0; a < 3; a++) buffer.writeDoubleLE(0.001, 131 + 8 * a);
  const xyz = (a: number): number[] => POINTS.map((p) => p.xyz[a] ?? 0);
  for (let a = 0; a < 3; a++) {
    buffer.writeDoubleLE(Math.max(...xyz(a)), 179 + 16 * a);
    buffer.writeDoubleLE(Math.min(...xyz(a)), 187 + 16 * a);
  }
  POINTS.forEach((p, i) => {
    const at = header + 26 * i;
    p.xyz.forEach((v, a) => buffer.writeInt32LE(Math.round(v / 0.001), at + 4 * a));
    buffer.writeUInt16LE(p.intensity, at + 12);
    buffer[at + 15] = p.classification;
    p.rgb16.forEach((v, a) => buffer.writeUInt16LE(v, at + 20 + 2 * a));
  });
  return buffer;
}

let store = '';
let work = '';
beforeAll(() => {
  store = mkdtempSync(path.join(tmpdir(), 'llull-scan-attr-store-'));
  work = mkdtempSync(path.join(tmpdir(), 'llull-scan-attr-work-'));
});
afterAll(() => {
  rmSync(store, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function attach(
  file: string,
): Promise<{ doc: ReturnType<typeof createEmptyDocument>; cloudId: string; key: string; ctx: ReturnType<typeof defaultContext> }> {
  const imported = await runScanImport(
    { path: file, options: DEFAULT_IMPORT_OPTIONS },
    { runner: createComputeRunner(process.env, BINARY), store, env: process.env },
  );
  if (!imported.ok) throw new Error(`${imported.code}: ${imported.message}`);
  const ctx = { ...defaultContext(), pointClouds: createPointCloudPort({ store, env: process.env, binary: BINARY }) };
  const attached = execute({ ...createEmptyDocument(), units: 'm' as const }, 'attach_point_cloud', { assetKey: imported.assetKey }, ctx);
  return { doc: attached.document, cloudId: attached.affected[0] ?? '', key: imported.assetKey, ctx };
}

describe('query_cloud_points attributes on a real asset', () => {
  native('returns rgb, intensity and classification of a LAS aligned with the points', async () => {
    const file = path.join(work, 'attrs.las');
    writeFileSync(file, buildLas());
    const { doc, cloudId, ctx } = await attach(file);
    const result = execute(doc, 'query_cloud_points', { cloudId, attributes: ['rgb', 'intensity', 'classification'] }, ctx);
    const data = result.data as Record<string, number[]>;
    expect(data['count']).toBe(3);
    const order = (data['indices'] ?? []).map((record) => POINTS[record]);
    expect(data['intensity']).toEqual(order.map((p) => p?.intensity));
    expect(data['classification']).toEqual(order.map((p) => p?.classification));
    expect(data['rgb']).toEqual(order.flatMap((p) => p?.rgb16.map((v) => v >> 8)));
    expect(data['missingAttributes']).toEqual([]);
    const near = execute(
      doc,
      'query_cloud_points',
      { cloudId, region: { kind: 'box', min: [3, 4, 5], max: [5, 6, 7] }, attributes: ['classification'] },
      ctx,
    );
    expect(near.data).toMatchObject({ count: 1, indices: [1], classification: [6] });
  });

  native('reports the attributes a CSV cloud lacks', async () => {
    const file = path.join(work, 'plain.csv');
    writeFileSync(file, 'x,y,z\n0,0,0\n1,0,0\n0,1,0\n');
    const { doc, cloudId, ctx } = await attach(file);
    const data = execute(doc, 'query_cloud_points', { cloudId, attributes: ['rgb', 'classification'] }, ctx).data as Record<
      string,
      unknown
    >;
    expect(data).toMatchObject({ count: 3, missingAttributes: ['rgb', 'classification'] });
    expect(data).not.toHaveProperty('rgb');
  });

  native('returns the colour of the coloured E57 cube, one 0-255 triple per point', async () => {
    const { doc, cloudId, ctx } = await attach(path.join(DATA, 'e57/ColouredCubeFloat.e57'));
    const data = execute(doc, 'query_cloud_points', { cloudId, maxPoints: 200_000, attributes: ['rgb'] }, ctx).data as Record<
      string,
      number[]
    >;
    expect(data['count']).toBe(7680);
    expect(data['rgb']).toHaveLength(3 * 7680);
    expect(Math.max(...(data['rgb'] ?? []))).toBeLessThanOrEqual(255);
    expect(new Set(data['rgb']).size).toBeGreaterThanOrEqual(2);
  });
});

describe('hostile attribute assets (manifest or block lies, CRC valid)', () => {
  /** Imports the attribute LAS, copies the asset into a fresh store and lets `mutate` rewrite its files. */
  async function hostile(
    mutate: (dir: string, hierarchy: Buffer) => void,
  ): Promise<{
    doc: ReturnType<typeof createEmptyDocument>;
    cloudId: string;
    ctx: ReturnType<typeof defaultContext>;
    key: string;
    reader: AssetReader | null;
  }> {
    const file = path.join(work, 'hostile.las');
    writeFileSync(file, buildLas());
    const good = await attach(file);
    const { key } = good;
    const copy = mkdtempSync(path.join(tmpdir(), 'llull-scan-attr-bad-'));
    cpSync(path.join(store, key), path.join(copy, key), { recursive: true });
    const dir = path.join(copy, key);
    mutate(dir, readFileSync(path.join(dir, 'hierarchy.bin')));
    const ctx = { ...defaultContext(), pointClouds: createPointCloudPort({ store: copy, env: process.env, binary: BINARY }) };
    return { doc: good.doc, cloudId: good.cloudId, ctx, key, reader: AssetReader.open(dir, key) };
  }
  const setManifest = (dir: string, change: Record<string, unknown>): void => {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...change }));
  };
  const refusal = (h: Awaited<ReturnType<typeof hostile>>): string | undefined =>
    execute(h.doc, 'query_cloud_points', { cloudId: h.cloudId, attributes: ['rgb', 'intensity', 'classification'] }, h.ctx).error?.code;

  native('refuses a manifest listing columns the blocks do not have', async () => {
    const h = await hostile((dir) => setManifest(dir, { attributes: ['intensity', 'rgb', 'classification', 'gpsTime', 'normal'] }));
    expect(h.reader?.readNode(0)).toBeNull();
    expect(refusal(h)).toBe('SCN_ASSET_MISSING');
  });

  native('refuses a truncated block whose CRC was recomputed', async () => {
    const h = await hostile((dir, hierarchy) => {
      const nodes = readFileSync(path.join(dir, 'nodes.bin'));
      const size = hierarchy.readUInt32LE(32) - 5;
      hierarchy.writeUInt32LE(size, 32);
      hierarchy.writeUInt32LE(crc32(nodes.subarray(hierarchy.readUInt32LE(24), hierarchy.readUInt32LE(24) + size)), 40);
      writeFileSync(path.join(dir, 'hierarchy.bin'), hierarchy);
    });
    expect(h.reader?.readNode(0)).toBeNull();
    expect(refusal(h)).toBe('SCN_ASSET_MISSING');
  });

  native('refuses non-array and unknown attribute names in the manifest', async () => {
    for (const attributes of ['x', ['rgb', 'sparkle'], ['rgb', 'intensity'], ['rgb', 'rgb']]) {
      const h = await hostile((dir) => setManifest(dir, { attributes }));
      expect(h.reader, JSON.stringify(attributes)).toBeNull();
      expect(refusal(h), JSON.stringify(attributes)).toBe('SCN_ASSET_MISSING');
    }
  });
});
