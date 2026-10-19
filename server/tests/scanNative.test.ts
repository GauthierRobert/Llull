/**
 * Plant 10 scan commands end to end on the real `llull-compute` through the Node PointCloudPort (the CLI / desktop path): the pack's synthetic
 * CSVs are imported with scan_import, attached, and the registry commands are judged against `synthetic_truth.json` (VC-SCN-31 targets).
 * Skipped with a logged reason without the binary (cargo build --profile compute -p llull-compute in solver/).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runScanImport } from '../src/scan/scanImport';
import { DEFAULT_IMPORT_OPTIONS } from '../src/scan/scanStore';
import { createPointCloudPort } from '../src/scan/pointCloudPort';

const DATA = path.resolve(__dirname, '../../docs/plant/10-pointcloud-brownfield/validation/data');
const TRUTH = (
  JSON.parse(readFileSync(path.join(DATA, 'synthetic_truth.json'), 'utf8')) as { cases: Record<string, Record<string, unknown>> }
).cases;
const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('scanNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = BINARY === null ? it.skip : it;

let store = '';
let ctx: ExecutionContext;
beforeAll(() => {
  store = mkdtempSync(path.join(tmpdir(), 'llull-scan-native-'));
  ctx = { ...defaultContext(), pointClouds: createPointCloudPort({ store, env: process.env, binary: BINARY }) };
});
afterAll(() => rmSync(store, { recursive: true, force: true }));

/** Imports a pack file and attaches it to `doc` (metres). */
async function attach(doc: CadDocument, file: string): Promise<{ doc: CadDocument; cloudId: string }> {
  const imported = await runScanImport(
    { path: path.join(DATA, file), options: DEFAULT_IMPORT_OPTIONS },
    { runner: createComputeRunner(process.env, BINARY), store, env: process.env },
  );
  if (!imported.ok) throw new Error(`${imported.code}: ${imported.message}`);
  const result = execute(doc, 'attach_point_cloud', { assetKey: imported.assetKey }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

const metres = (): CadDocument => ({ ...createEmptyDocument(), units: 'm' });

describe('scan extraction on llull-compute', () => {
  native('extracts CYL-A / B / C within tolerance, snaps DN 100 / 200 / 50 and commits as-built runs (VC-SCN-20, 21)', async () => {
    let doc = metres();
    for (const id of ['CYL-A', 'CYL-B', 'CYL-C']) {
      const truth = TRUTH[id] as { file: string; radius_m: number; noiseSigma_m: number; dn: number; tolerance: { radius_m: number } };
      const attached = await attach(doc, truth.file);
      doc = attached.doc;
      const result = execute(
        doc,
        'extract_pipes',
        { cloudId: attached.cloudId, region: { kind: 'all' }, noiseSigma: truth.noiseSigma_m },
        ctx,
      );
      expect(result.rejected, result.summary).toBeUndefined();
      const first = (result.data as { extractions: { radius: number; snapped: { dn: number }; extraction: unknown }[] }).extractions[0];
      expect(Math.abs((first?.radius ?? 0) - truth.radius_m)).toBeLessThanOrEqual(truth.tolerance.radius_m);
      expect(first?.snapped.dn).toBe(truth.dn);
      const committed = execute(doc, 'commit_asbuilt_extraction', { extraction: first?.extraction, line: id }, ctx);
      expect(committed.rejected, committed.summary).toBeUndefined();
      doc = committed.document;
    }
    const pipes = Object.values(doc.building?.elements ?? {}).filter((e) => e.category === 'pipe');
    expect(pipes.map((p) => (p as { dn?: number }).dn)).toEqual([100, 200, 50]);
    // The whole document replays without any point-cloud port (TR-SCN-04).
    const replayed = execute(doc, 'replay_history', {});
    expect(JSON.stringify(replayed.document.building)).toBe(JSON.stringify(doc.building));
  });

  native('slices CYL-B normal to its axis and fits r = 109.55 ± 1.6 mm (VC-SCN-24)', async () => {
    const truth = TRUTH['CYL-B'] as { axisDirection: number[] };
    const { doc, cloudId } = await attach(metres(), 'synthetic/cyl-b.csv');
    const a = truth.axisDirection;
    const result = execute(
      doc,
      'slice_cloud',
      { cloudId, origin: a.map((v) => v * 1.5), normal: a, thickness: 0.02, fit: 'circle', noiseSigma: 0.002 },
      ctx,
    );
    const circle = (result.data as { circles: { radius: number }[] }).circles[0];
    expect(Math.abs((circle?.radius ?? 0) - 0.10955)).toBeLessThanOrEqual(0.0016);
  });
});

describe('scan registration on llull-compute', () => {
  native('registers TGT-A by sphere targets and places the moving station (VC-SCN-31)', async () => {
    const truth = TRUTH['TGT-A'] as {
      centresStation1_m: number[][];
      centresStation2_m: number[][];
      rotationMatrix_station2_to_station1: number[][];
      translation_m: number[];
    };
    const a = await attach(metres(), 'synthetic/tgt-a-station1.csv');
    const b = await attach(a.doc, 'synthetic/tgt-a-station2.csv');
    const targets = truth.centresStation1_m.map((fixed, i) => ({
      name: `T${i + 1}`,
      kind: 'sphere',
      fixedPoint: fixed,
      movingPoint: truth.centresStation2_m[i],
      radius: 0.0725,
    }));
    const computed = execute(b.doc, 'compute_registration', { fixed: a.cloudId, moving: b.cloudId, method: 'targets', targets }, ctx);
    expect(computed.rejected, computed.summary).toBeUndefined();
    const record = (computed.data as { record: { transform: number[] } }).record;
    const r = truth.rotationMatrix_station2_to_station1;
    const t = truth.translation_m;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++)
        expect(Math.abs((record.transform[row * 4 + col] ?? 0) - (r[row]?.[col] ?? 0))).toBeLessThan(0.05 * (Math.PI / 180) * 2);
      expect(Math.abs((record.transform[row * 4 + 3] ?? 0) - (t[row] ?? 0))).toBeLessThan(0.003);
    }
    const applied = execute(b.doc, 'apply_registration', { record }, ctx);
    expect(applied.rejected, applied.summary).toBeUndefined();
    // The moving station's first target now lies on the fixed one.
    const near = execute(
      applied.document,
      'nearest_cloud_point',
      { cloudId: b.cloudId, point: truth.centresStation1_m[0], maxDistance: 0.2 },
      ctx,
    ).data as { distance: number };
    expect(near.distance).toBeGreaterThan(0.06);
    expect(near.distance).toBeLessThan(0.085);
    const two = execute(
      b.doc,
      'compute_registration',
      { fixed: a.cloudId, moving: b.cloudId, method: 'targets', targets: targets.slice(0, 2) },
      ctx,
    );
    expect(two.error?.code).toBe('SCN_REG_TARGETS_INSUFFICIENT');
  });
});
