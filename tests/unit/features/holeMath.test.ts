import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countersinkApexDepth,
  countersinkDepth,
  countersinkDiameter,
  countersinkLand,
  countersinkRemovedVolume,
  countersinkRemovedVolumeInSheet,
  drillTipHeight,
  frustumVolume,
  pocketRemovedVolume,
} from '@lib/holeMath';

const DATA = path.resolve(__dirname, '../../../docs/aerospace/07-sheet-metal-machined-features/validation/data');
const load = <T>(file: string): T => JSON.parse(readFileSync(path.join(DATA, file), 'utf8')) as T;

interface Countersink {
  id: string;
  d: number;
  D: number;
  alpha_deg: number;
  T: number;
  csk_depth_c: number;
  apex_depth_c0: number;
  removed_volume_beyond_hole: number;
  removed_volume_in_sheet: number;
  cylindrical_land: number;
  knife_edge: boolean;
}
interface DrillPoint {
  id: string;
  d: number;
  point_angle_deg: number;
  tip_height: number;
}
interface PocketCase {
  id: string;
  W: number;
  L: number;
  D: number;
  rc: number;
  rf: number;
  removed_volume?: number;
  valid?: boolean;
}

const countersinks = load<{ countersinks: Countersink[]; drill_points: DrillPoint[] }>('expected_countersink.json');
const pockets = load<{ cases: PocketCase[] }>('expected_pocket.json');

describe('holeMath: countersinks (VC-FTR-22/23, CS-01..07)', () => {
  it.each(countersinks.countersinks)('$id', (row) => {
    expect(countersinkDepth(row.d, row.D, row.alpha_deg).value).toBeCloseTo(row.csk_depth_c, 6);
    expect(countersinkApexDepth(row.D, row.alpha_deg).value).toBeCloseTo(row.apex_depth_c0, 6);
    expect(countersinkDiameter(row.d, row.csk_depth_c, row.alpha_deg).value).toBeCloseTo(row.D, 6);
    const full = countersinkRemovedVolume(row.d, row.D, row.alpha_deg).value;
    expect(Math.abs(full - row.removed_volume_beyond_hole) / row.removed_volume_beyond_hole).toBeLessThan(1e-6);
    const inSheet = countersinkRemovedVolumeInSheet(row.d, row.D, row.alpha_deg, row.T).value;
    expect(Math.abs(inSheet - row.removed_volume_in_sheet) / row.removed_volume_in_sheet).toBeLessThan(1e-6);
    const land = countersinkLand(row.T, row.csk_depth_c);
    expect(land.value).toBeCloseTo(row.cylindrical_land, 6);
    expect(land.value <= 0).toBe(row.knife_edge);
  });

  it('every value carries its formula id (TR-FTR-09)', () => {
    for (const derived of [
      countersinkDepth(4.8, 9, 100),
      countersinkApexDepth(9, 100),
      countersinkDiameter(4.8, 1.76, 100),
      countersinkRemovedVolume(4.8, 9, 100),
      countersinkRemovedVolumeInSheet(4.8, 9, 100, 1.6),
      countersinkLand(1.6, 1.7),
      drillTipHeight(6, 118),
      frustumVolume(1, 1, 2),
      pocketRemovedVolume(40, 20, 5, 4, 0),
      pocketRemovedVolume(40, 20, 5, 4, 1.5),
    ])
      expect(derived.formula.length).toBeGreaterThan(3);
  });
});

describe('holeMath: drill points (VC-FTR-24, DP-01..03)', () => {
  it.each(countersinks.drill_points)('$id', (row) => {
    expect(drillTipHeight(row.d, row.point_angle_deg).value).toBeCloseTo(row.tip_height, 6);
  });
});

describe('holeMath: pockets (VC-FTR-27)', () => {
  it.each(pockets.cases.filter((c) => c.valid !== false))('$id', (row) => {
    const value = pocketRemovedVolume(row.W, row.L, row.D, row.rc, row.rf).value;
    expect(Math.abs(value - (row.removed_volume as number)) / (row.removed_volume as number)).toBeLessThan(1e-6);
  });
});
