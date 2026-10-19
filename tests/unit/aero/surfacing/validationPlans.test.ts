import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { runPlan } from '../../../golden/runPlan';
import type { GoldenAction } from '../../../golden/plans';

const packDir = join(process.cwd(), 'docs/aerospace/02-advanced-surfacing/validation');
const loadPlan = (name: string): GoldenAction[] => JSON.parse(readFileSync(join(packDir, 'plans', name), 'utf8')) as GoldenAction[];
const expected = JSON.parse(readFileSync(join(packDir, 'data/wing_planforms.json'), 'utf8')) as Array<Record<string, number | string>>;
type Data = Record<string, number>;

describe('SRF validation pack plans run on the built commands', () => {
  it('VC-SRF-11: target_naca0012_trap_wing.json gives the half-wing volume 0.959117 m3 (open TE)', () => {
    const outcome = runPlan(loadPlan('target_naca0012_trap_wing.json'));
    expect(outcome.failedSteps).toEqual([]);
    const wing = Object.keys(outcome.document.aero!.wings)[0]!;
    const data = execute(outcome.document, 'wing_properties', { id: wing }).data as Data;
    const row = expected.find((entry) => entry['id'] === 'trap_naca0012')!;
    expect(Math.abs(data['volumePerSide']! / (row['volume_half_open_te'] as number) - 1)).toBeLessThan(
      row['tolerance_rel_volume'] as number,
    );
    expect(data['areaPerSide']).toBeCloseTo(row['area_planform_half'] as number, 9);
    expect(data['mac']).toBeCloseTo(row['mac'] as number, 9);
    expect(data['unit']).toBe('m');
    // the plan's own mass_properties step reads the same solid (mesh fallback of the exact loft): within 0.5 % of the exact volume
    const mass = execute(outcome.document, 'mass_properties', { entityId: wing }).data as { volume: number };
    expect(Math.abs(mass.volume / (row['volume_half_open_te'] as number) - 1)).toBeLessThan(5e-3);
  });

  it('VC-SRF-10: target_tr1208_wing.json gives the published TR-1208 planform', () => {
    const outcome = runPlan(loadPlan('target_tr1208_wing.json'));
    expect(outcome.failedSteps).toEqual([]);
    const wing = Object.keys(outcome.document.aero!.wings)[0]!;
    const data = execute(outcome.document, 'wing_properties', { id: wing }).data as Data;
    const row = expected.find((entry) => entry['id'] === 'tr1208')!;
    expect(Math.abs(data['areaRef']! - (row['area_full'] as number))).toBeLessThan(0.01);
    expect(Math.abs(data['mac']! - (row['mac'] as number))).toBeLessThan(0.005);
    expect(Math.abs(data['aspectRatio']! - (row['aspect_ratio'] as number))).toBeLessThan(0.03);
    expect(Math.abs(data['yMac']! - (row['y_mac'] as number))).toBeLessThan(0.005);
    expect(Math.abs(data['areaRef']! - 2024.35)).toBeLessThan(0.01);
    expect(Math.abs(data['mac']! - 16.672)).toBeLessThan(0.005);
  });
});
