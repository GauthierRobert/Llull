/**
 * Physics packs 07 (fatigue) and 08 (fracture / damage tolerance) replayed through the real `llull` CLI entry (`runCli`, `--json`): the
 * validation plans run on a fresh --doc and their numbers are checked against `validation/expected_results.json` (AF-23).
 * Command-level versions live in tests/unit/cae/{fatigue,fracture}. Not replayed: the FE-driven steps (VC-FAT-42, VC-FAT-63, VC-FRC-03, 17),
 * the human-gate cases (VC-FAT-60 ii, VC-FRC-20 ii) and the stale-results cases: those commands are not built. fat_plate_hole_spectrum stops at
 * set_part_idealization (plane_stress idealization of the 05 FEA set-up is not built).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { REPO_ROOT, cliCall, newSession, runPlan, type CliCall } from './packCli';

afterAll(() => setGeometryKernel(null));

const FAT = 'docs/physics/07-fatigue/validation';
const FRC = 'docs/physics/08-fracture-damage-tolerance/validation';
const COVERS = [
  'VC-FAT-01',
  'VC-FAT-03',
  'VC-FAT-22',
  'VC-FAT-40',
  'VC-FAT-41',
  'VC-FAT-50',
  'VC-FRC-05',
  'VC-FRC-10',
  'VC-FRC-13',
  'VC-FRC-14',
];

type Json = Record<string, unknown>;
interface PackFile {
  readonly cases: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
}
const expected = (pack: string, id: string): unknown => {
  const file = JSON.parse(readFileSync(path.join(REPO_ROOT, pack, 'expected_results.json'), 'utf8')) as PackFile;
  return file.cases.find((entry) => entry.id === id)?.value;
};
const steps = (call: CliCall | null): Array<{ command: string; ok: boolean; data?: Json }> =>
  (call?.json as { data: { steps: Array<{ command: string; ok: boolean; data?: Json }> } }).data.steps;
const dataOf = (call: CliCall | null, command: string, index = 0): Json =>
  steps(call).filter((s) => s.command === command)[index]?.data ?? {};
const relative = (actual: unknown, wanted: unknown): number => Math.abs((actual as number) / (wanted as number) - 1);
const run = async (pack: string, name: string): Promise<{ plan: CliCall | null; session: ReturnType<typeof newSession> }> => {
  const session = newSession();
  const plan = await runPlan(session, { plan_file: path.join(pack, 'plans', name) });
  expect(plan?.code, plan?.stdout.slice(0, 600)).toBe(0);
  return { plan, session };
};

describe('pack 07 fatigue plans through llull run', () => {
  it('names only VCs that exist in the pack READMEs', () => {
    for (const id of COVERS) {
      const readme = readFileSync(path.join(REPO_ROOT, id.startsWith('VC-FAT') ? FAT : FRC, 'README.md'), 'utf8');
      expect(readme, id).toContain(`| ${id} |`);
    }
  });

  it('fat_e1049_rainflow: VC-FAT-01 (3-point and 4-point) and VC-FAT-03 (repeating)', async () => {
    const { plan } = await run(FAT, 'fat_e1049_rainflow.plan.json');
    expect(dataOf(plan, 'count_cycles', 0)['totals']).toEqual(expected(FAT, 'VC-FAT-01'));
    expect(dataOf(plan, 'count_cycles', 1)['totals']).toEqual(expected(FAT, 'VC-FAT-01'));
    expect(dataOf(plan, 'count_cycles', 2)['totals']).toEqual(expected(FAT, 'VC-FAT-03'));
  });

  it('fat_history_only_miner: VC-FAT-40 / 41 / 50, then compute_fatigue by CLI on the saved document', async () => {
    const { plan, session } = await run(FAT, 'fat_history_only_miner.plan.json');
    const row = (dataOf(plan, 'compute_fatigue')['rows'] as Json[])[0] ?? {};
    expect(relative(row['damagePerBlock'], expected(FAT, 'VC-FAT-40'))).toBeLessThan(1e-9);
    expect(relative(row['lifeBlocks'], expected(FAT, 'VC-FAT-41'))).toBeLessThan(1e-9);
    expect(Math.abs((dataOf(plan, 'compute_fatigue')['minMargin'] as number) - (expected(FAT, 'VC-FAT-50') as number))).toBeLessThan(1e-9);
    const caseId = (plan?.json as { data: { aliases?: Record<string, string[]> } }).data.aliases?.['fc']?.[0] ?? '';
    expect(caseId).toMatch(/^fc-/);
    const again = await cliCall(session, ['compute_fatigue', `caseId=${caseId}`]);
    expect(again.code, again.stdout.slice(0, 500) + again.stderr).toBe(0);
    expect((again.json as { data: { rows: Json[] } }).data.rows[0]?.['damagePerBlock']).toBe(row['damagePerBlock']);
    const unset = await cliCall(session, ['compute_fatigue', 'caseId=fc-none']);
    expect(unset.code).toBe(1);
  });

  it('fat_notch_swt_s5: VC-FAT-22 SWT life 2919.91 cycles', async () => {
    const { plan } = await run(FAT, 'fat_notch_swt_s5.plan.json');
    expect(relative(dataOf(plan, 'fatigue_life', 0)['cyclesToFailure'], expected(FAT, 'VC-FAT-22'))).toBeLessThan(1e-6);
  });
});

describe('pack 08 fracture plans through llull run', () => {
  it('frc_paris_center_life: VC-FRC-05 (closed form 776634.44, W = 1e5 mm secant correction < 3e-8)', async () => {
    const { plan } = await run(FRC, 'frc_paris_center_life.plan.json');
    expect(relative(dataOf(plan, 'compute_crack_growth')['lifeCycles'], expected(FRC, 'VC-FRC-05'))).toBeLessThan(1e-6);
    expect(relative(dataOf(plan, 'stress_intensity')['KMPaSqrtM'], expected(FRC, 'VC-FRC-01'))).toBeLessThan(1e-9);
  });

  it('frc_residual_interval: VC-FRC-10 / 13 / 14', async () => {
    const { plan } = await run(FRC, 'frc_residual_interval.plan.json');
    const growth = dataOf(plan, 'compute_crack_growth');
    expect(relative(growth['aCriticalM'], expected(FRC, 'VC-FRC-10'))).toBeLessThan(1e-9);
    expect(relative(growth['lifeCycles'], expected(FRC, 'VC-FRC-13'))).toBeLessThan(1e-6);
    const interval = dataOf(plan, 'compute_inspection_interval');
    expect(relative(interval['intervalCycles'], expected(FRC, 'VC-FRC-14'))).toBeLessThan(1e-6);
    expect(interval).toMatchObject({ factors: { scatterInterval: { defaulted: false } }, reviewRequired: true });
    expect(dataOf(plan, 'compute_residual_strength')['governing']).toBe('fracture');
  });
});
