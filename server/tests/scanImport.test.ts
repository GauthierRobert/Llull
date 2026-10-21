/**
 * Plant 10 host side: the `scan_import` transport (VC-SCN-02, 03, 11, idempotent key, atomic store), the `llull scan` CLI verb, and the Node
 * `PointCloudPort` over a real asset (VC-SCN-09, 10, 12 through the TypeScript reader and the registry commands). Native cases need
 * `llull-compute` (cargo build --profile compute -p llull-compute in solver/) and are skipped with a logged reason without it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument } from '@core/model/types';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runScanImport, type ScanDeps } from '../src/scan/scanImport';
import { runScanTool } from '../src/scan/scanTools';
import { buildNativeToolDefinitions } from '@protocol/nativeTools';
import { assetKey, DEFAULT_IMPORT_OPTIONS, hasAsset, importerVersion, listAssets } from '../src/scan/scanStore';
import { createPointCloudPort } from '../src/scan/pointCloudPort';
import { AssetReader, crc32 } from '../src/scan/assetReader';
import { EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';

const DATA = path.resolve(__dirname, '../../docs/plant/10-pointcloud-brownfield/validation/data');
const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('scanImport: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): native cases skipped');
const native = BINARY === null ? it.skip : it;

let store = '';
let work = '';
const deps = (): ScanDeps => ({ runner: createComputeRunner(process.env, BINARY), store, env: process.env });
const options = DEFAULT_IMPORT_OPTIONS;

beforeAll(() => {
  store = mkdtempSync(path.join(tmpdir(), 'llull-scan-store-'));
  work = mkdtempSync(path.join(tmpdir(), 'llull-scan-work-'));
});
afterAll(() => {
  rmSync(store, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const noTempLeft = (): void => expect(readdirSync(store).filter((name) => name.startsWith('.tmp-'))).toEqual([]);

describe('scan_import transport', () => {
  it('refuses proprietary formats before any native work (VC-SCN-11) and a missing file or binary', async () => {
    const rcp = path.join(work, 'plant.rcp');
    writeFileSync(rcp, 'not public');
    const refused = await runScanImport({ path: rcp, options }, { runner: createComputeRunner({}, null), store, env: {} });
    expect(refused).toMatchObject({ ok: false, code: 'SCN_FORMAT_PROPRIETARY' });
    expect(refused.ok ? '' : refused.message).toContain('E57');
    expect(await runScanImport({ path: path.join(work, 'nope.e57'), options }, deps())).toMatchObject({
      ok: false,
      code: 'SCN_FILE_NOT_FOUND',
    });
    const noBinary = await runScanImport(
      { path: path.join(DATA, 'e57/bunnyInt32.e57'), options },
      { runner: createComputeRunner({}, null), store, env: {} },
    );
    expect(noBinary).toMatchObject({ ok: false, code: 'NATIVE_TOOL_MISSING' });
    const tool = await runScanTool('scan_import', { path: rcp }, { runner: createComputeRunner({}, null), store, env: {} });
    expect(tool).toMatchObject({ isError: true, changed: false, data: { code: 'SCN_FORMAT_PROPRIETARY' } });
    expect((await runScanTool('scan_import', { path: rcp, sourceUnit: 'yd' }, deps()))?.data).toEqual({ code: 'SCN_PARAM_INVALID' });
    expect(await runScanTool('add_box', {}, deps())).toBeNull();
    expect(
      buildNativeToolDefinitions()
        .filter((tool) => tool.name.startsWith('scan_'))
        .map((tool) => tool.name),
    ).toEqual(['scan_import', 'scan_list']);
  });

  native('imports into a content-addressed asset, atomically and idempotently', async () => {
    const source = path.join(DATA, 'e57/ColouredCubeFloat.e57');
    const first = await runScanImport({ path: source, options }, deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const sha = createHash('sha256').update(readFileSync(source)).digest('hex');
    const version = await createComputeRunner(process.env, BINARY).version();
    expect(first.sourceSha256).toBe(sha);
    expect(first.assetKey).toBe(assetKey(sha, importerVersion(version), options));
    expect(first.manifest).toMatchObject({
      assetKey: first.assetKey,
      pointCount: 7680,
      format: 'e57',
      importerVersion: importerVersion(version),
      unit: 'm',
    });
    expect(hasAsset(store, first.assetKey)).toBe(true);
    noTempLeft();
    const again = await runScanImport({ path: source, options }, deps());
    expect(again).toMatchObject({ ok: true, cached: true, assetKey: first.assetKey });
    const other = await runScanImport({ path: source, options: { ...options, maxPointsPerNode: 1000 } }, deps());
    expect(other.ok && other.assetKey).not.toBe(first.assetKey);
  });

  native('refuses a corrupt page (VC-SCN-02) and empty clouds (VC-SCN-03) without leaving an asset', async () => {
    const before = listAssets(store);
    const corrupt = await runScanImport({ path: path.join(DATA, 'e57/bad-crc.e57'), options }, deps());
    expect(corrupt).toMatchObject({ ok: false, code: 'SCN_E57_CHECKSUM' });
    for (const name of ['empty.e57', 'ZeroPoints.e57'])
      expect(await runScanImport({ path: path.join(DATA, `e57/${name}`), options }, deps())).toMatchObject({
        ok: false,
        code: 'SCN_CLOUD_EMPTY',
      });
    expect(listAssets(store)).toEqual(before);
    noTempLeft();
  });
});

describe('PointCloudPort over a real asset', () => {
  native('answers nearest_cloud_point on the coloured cube through the registry (VC-SCN-12)', async () => {
    const imported = await runScanImport({ path: path.join(DATA, 'e57/ColouredCubeFloat.e57'), options }, deps());
    if (!imported.ok) throw new Error(imported.message);
    const ctx = { ...defaultContext(), pointClouds: createPointCloudPort({ store, env: process.env, binary: BINARY }) };
    const m = { ...createEmptyDocument(), units: 'm' as const };
    const attached = execute(m, 'attach_point_cloud', { assetKey: imported.assetKey }, ctx);
    const cloudId = attached.affected[0];
    const near = execute(attached.document, 'nearest_cloud_point', { cloudId, point: [0.6, 0.6, 0.6], maxDistance: 1 }, ctx).data as Record<
      string,
      number
    >;
    expect(near['recordIndex']).toBe(6606);
    expect(near['distance']).toBeCloseTo(0.1773272, 6);
    expect((near['secondNearestDistance'] ?? 0) - (near['distance'] ?? 0)).toBeGreaterThan(0.01);
    const all = execute(attached.document, 'query_cloud_points', { cloudId, maxPoints: 200_000 }, ctx).data as Record<string, unknown>;
    expect(all['count']).toBe(7680);
  });

  native('keeps LAS coordinates exact (VC-SCN-09) and honours the LOD budget (VC-SCN-10)', async () => {
    const big = await runScanImport({ path: path.join(DATA, 'las/test1_4.las'), options }, deps());
    if (!big.ok) throw new Error(big.message);
    const port = createPointCloudPort({ store, env: process.env, binary: BINARY });
    const read = port.query(big.assetKey, { lod: 'full', maxPoints: 10_000 });
    const reference = (
      JSON.parse(readFileSync(path.join(DATA, 'las_reference.json'), 'utf8')) as {
        files: { file: string; dataMin: number[]; dataMax: number[] }[];
      }
    ).files.find((f) => f.file === 'las/test1_4.las');
    const xs = Array.from({ length: read?.indices.length ?? 0 }, (_, i) => read?.positions[3 * i] ?? 0);
    expect(xs).toHaveLength(1000);
    expect(Math.min(...xs)).toBe(reference?.dataMin[0]);
    expect(Math.max(...xs)).toBe(reference?.dataMax[0]);
    const autzen = await runScanImport({ path: path.join(DATA, 'las/autzen_trim.laz'), options }, deps());
    if (!autzen.ok) throw new Error(autzen.message);
    expect(autzen.manifest.warnings.map((w) => w.code)).toContain('SCN_LAS_UNIT_FEET');
    const reader = AssetReader.open(path.join(store, autzen.assetKey), autzen.assetKey);
    expect(reader?.nodes.reduce((sum, n) => sum + n.pointCount, 0)).toBe(110_000);
    for (const budget of [5_000, 20_000, 60_000]) {
      const lod = port.query(autzen.assetKey, { lod: { budget }, maxPoints: 1_000_000 });
      expect(lod?.indices.length ?? Infinity).toBeLessThanOrEqual(budget);
    }
    // A corrupt block reads as missing (CRC per node block).
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(port.manifest('0'.repeat(64))).toBeNull();
    expect(port.compute({ kind: 'fit', clouds: [{ assetKey: '0'.repeat(64), toDocument: [] }], params: {} })).toBeNull();
  });
});

describe('llull scan (CLI verb)', () => {
  function io(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        readStdin: () => Promise.resolve(''),
        env: {},
        prepareKernel: () => Promise.resolve(),
      },
      out,
      err,
    };
  }

  it('needs a verb', async () => {
    const c = io();
    expect(await runCli(['scan'], c.io)).toBe(EXIT_USAGE);
    expect(c.err.join()).toContain('llull scan import <file>');
  });

  native('imports and lists through the CLI', async () => {
    vi.stubEnv('LLULL_SCAN_CACHE', store);
    try {
      const doc = path.join(work, 'cli.llull.json');
      const imported = io();
      expect(await runCli(['scan', 'import', path.join(DATA, 'e57/bunnyInt32.e57'), '--doc', doc, '--json'], imported.io)).toBe(EXIT_OK);
      expect(imported.out.join()).toContain('"pointCount":30571');
      const listed = io();
      expect(await runCli(['scan', 'list', '--doc', doc], listed.io)).toBe(EXIT_OK);
      expect(listed.out.join()).toContain('bunnyInt32.e57');
      expect(existsSync(doc)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
