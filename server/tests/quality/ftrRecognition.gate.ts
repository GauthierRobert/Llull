/**
 * Feature-recognition gate on the pinned NIST CTC-02…05 parts (07 FTR, VC-FTR-21 and the budget of VC-FTR-46): per file the distinct 59 degree
 * (semi-angle) drill-point apexes and 45 degree cone seeds after the split-face merge must be 74 / 0 / 22 / 10 and 0 / 0 / 42 / 3, and import
 * plus recognition must finish in under 5 s. Skipped per file when it was not downloaded (npm run quality:fetch).
 *
 *   npm run quality:fetch && npm --prefix server run quality:step -- tests/quality/ftrRecognition.gate.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { operandRecipe } from '@core/geometry/operandRecipe';
import { lengthToleranceOf, recognitionOf } from '@core/commands/features/recognition';
import { buildModel } from '@core/geometry/recognition/model';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createNativeTestKernel } from '../kernelTestSupport';
import { REPO_ROOT, checkAssertion, newSession, runCliLines, type PackCase } from '../packCli';

const CORPUS_DIR = path.resolve(__dirname, '../../../.cache/quality-corpus');
const BUDGET_MS = 5000;
const DEG = 180 / Math.PI;

const CASES = [
  { id: 'nist-ctc-02', drillPoints: 74, seeds45: 0 },
  { id: 'nist-ctc-03', drillPoints: 0, seeds45: 0 },
  { id: 'nist-ctc-04', drillPoints: 22, seeds45: 42 },
  { id: 'nist-ctc-05', drillPoints: 10, seeds45: 3 },
] as const;

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = createNativeTestKernel();
}, 120_000);
afterAll(() => setGeometryKernel(null));

describe('VC-FTR-21: NIST CTC-02…05 drill-point apexes and 45 degree cone seeds', () => {
  for (const { id, drillPoints, seeds45 } of CASES) {
    const file = path.join(CORPUS_DIR, `${id}.stp`);
    it.skipIf(!existsSync(file))(
      `${id}: ${drillPoints} drill-point apexes, ${seeds45} 45 degree seeds, recognition under ${BUDGET_MS} ms`,
      () => {
        const text = readFileSync(file, 'utf8');
        const ctx = { ...defaultContext(), kernel };
        const imported = execute(createEmptyDocument(), 'import_step_exact', { text, fileName: `${id}.stp` }, ctx);
        expect(imported.error).toBeUndefined();
        const entityId = imported.affected[0] as string;
        const started = performance.now();
        const recognised = execute(imported.document, 'recognize_features', { id: entityId }, ctx);
        const elapsed = performance.now() - started;
        expect(recognised.error).toBeUndefined();
        console.warn(`${id}: recognize_features ${Math.round(elapsed)} ms`);
        const entity = imported.document.entities[entityId];
        const input = recognitionOf(kernel, operandRecipe(kernel, entity!));
        expect(typeof input).not.toBe('string');
        if (typeof input === 'string') return;
        const tolerance = { length: lengthToleranceOf(input.topology), angle: 1e-6 };
        const model = buildModel(input.graph, input.topology, true, tolerance, input.orientation);
        const cones = model.groups.flatMap((group) => (group.surface.type === 'cone' ? [group.surface] : []));
        const apexesAt = (semiDegrees: number): number =>
          cones.filter((cone) => Math.abs(cone.semiAngle * DEG - semiDegrees) < 1e-3).length;
        expect(apexesAt(59)).toBe(drillPoints);
        expect(apexesAt(45)).toBe(seeds45);
        expect(elapsed).toBeLessThan(BUDGET_MS);
      },
      120_000,
    );
  }
});

/** VC-FTR-46 in its pack form (expected_results.json): the CLI imports CTC-02 and recognises it with --progress / --timeout, exit 0, under 5 s. */
describe('VC-FTR-46: llull import_step_exact + recognize_features --progress --timeout on CTC-02', () => {
  const ctc02 = path.join(CORPUS_DIR, 'nist-ctc-02.stp');
  const pack = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'docs/aerospace/07-sheet-metal-machined-features/validation/expected_results.json'), 'utf8'),
  ) as { cases: Array<PackCase & { vc: string }> };

  it.skipIf(!existsSync(ctc02))(
    'exits 0 on every call and the recognition call stays under the 5 s budget',
    async () => {
      const packCase = pack.cases.find((candidate) => candidate.vc === 'VC-FTR-46');
      expect(packCase?.cli).toHaveLength(3);
      const cli = (packCase?.cli ?? []).map((line) => line.replace('<ctc-dir>/nist_ctc_02_asme1_ap242.stp', ctc02));
      expect(cli.join('\n')).toContain('--progress --timeout');
      const session = newSession();
      await runCliLines(session, { cli });
      expect(session.calls.map((call) => call.code)).toEqual([0, 0, 0]);
      for (const assertion of packCase?.assert ?? []) checkAssertion(session, assertion, 'VC-FTR-46');
      const data = (session.calls[2]?.json as { data: { counts: { holes: number } } }).data;
      expect(data.counts.holes).toBeGreaterThan(0);
      console.warn(`VC-FTR-46: recognize_features via CLI ${Math.round(session.calls[2]?.ms ?? 0)} ms`);
    },
    300_000,
  );
});
