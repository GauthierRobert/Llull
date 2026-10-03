import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { windCasesOf, WIND_CASES, type FrameModel } from '@aec/industrial/frameModelTypes';
import { framesOf } from '@aec/industrial/frameModelFrames';
import {
  FLAT_ROOF_LIMIT,
  frameRoofAverage,
  roofCoefficients,
  type RoofType,
  type RoofZone,
  type WindDirection,
} from '@aec/industrial/windCoefficients';
import type { PurlinRow, ZoneSummary } from '@aec/industrial/purlinModel';

const cpe = (
  roofType: RoofType,
  pitch: number,
  direction: WindDirection,
  zone: RoofZone,
  set: 'suction' | 'pressure' = 'suction',
): number => roofCoefficients(roofType, pitch, direction)[zone]![set];

describe('duopitch Tab. 7.4a (θ = 0°) interpolated on the pitch', () => {
  it('returns the table rows at 5, 15, 30 and 45°', () => {
    expect(roofCoefficients('duopitch', 5, 0)).toEqual({
      F: { suction: -1.7, pressure: 0 },
      G: { suction: -1.2, pressure: 0 },
      H: { suction: -0.6, pressure: 0 },
      I: { suction: -0.6, pressure: -0.6 },
      J: { suction: 0.2, pressure: -0.6 },
    });
    expect(cpe('duopitch', 15, 0, 'F', 'pressure')).toBe(0.2);
    expect(cpe('duopitch', 30, 0, 'H', 'pressure')).toBe(0.4);
    expect(cpe('duopitch', 45, 0, 'J')).toBe(-0.3);
  });

  it('interpolates linearly at 6, 10, 22.5 and 40°', () => {
    expect(cpe('duopitch', 6, 0, 'F')).toBeCloseTo(-1.62, 9);
    expect(cpe('duopitch', 6, 0, 'F', 'pressure')).toBeCloseTo(0.02, 9);
    expect(cpe('duopitch', 6, 0, 'J')).toBeCloseTo(0.08, 9);
    expect(cpe('duopitch', 10, 0, 'F')).toBeCloseTo(-1.3, 9);
    expect(cpe('duopitch', 10, 0, 'H')).toBeCloseTo(-0.45, 9);
    expect(cpe('duopitch', 10, 0, 'H', 'pressure')).toBeCloseTo(0.1, 9);
    expect(cpe('duopitch', 22.5, 0, 'F')).toBeCloseTo(-0.7, 9);
    expect(cpe('duopitch', 22.5, 0, 'F', 'pressure')).toBeCloseTo(0.45, 9);
    expect(cpe('duopitch', 22.5, 0, 'G')).toBeCloseTo(-0.65, 9);
    expect(cpe('duopitch', 22.5, 0, 'J')).toBeCloseTo(-0.75, 9);
    expect(cpe('duopitch', 40, 0, 'F')).toBeCloseTo(-0.5 + (2 / 3) * 0.5, 9);
    expect(cpe('duopitch', 40, 0, 'H', 'pressure')).toBeCloseTo(0.4 + (2 / 3) * 0.2, 9);
    expect(cpe('duopitch', 40, 0, 'J')).toBeCloseTo(-0.5 + (2 / 3) * 0.2, 9);
  });

  it('uses the -5° row for negative pitches and clamps outside the table', () => {
    expect(cpe('duopitch', -5, 0, 'F')).toBe(-2.3);
    expect(cpe('duopitch', -20, 0, 'F')).toBe(-2.3);
    expect(cpe('duopitch', -2.5, 0, 'F')).toBeCloseTo(-2.15, 9);
    expect(cpe('duopitch', 60, 0, 'F', 'pressure')).toBe(0.7);
  });

  it('uses Tab. 7.4b for wind along the ridge, held at the 5° values below 5°', () => {
    expect(cpe('duopitch', 10, 90, 'F')).toBeCloseTo(-1.45, 9);
    expect(cpe('duopitch', 10, 90, 'G')).toBeCloseTo(-1.3, 9);
    expect(cpe('duopitch', 10, 90, 'H')).toBeCloseTo(-0.65, 9);
    expect(cpe('duopitch', 10, 90, 'I')).toBeCloseTo(-0.55, 9);
    expect(cpe('duopitch', -3, 90, 'F')).toBe(-1.6);
    expect(roofCoefficients('duopitch', 10, 90).J).toBeUndefined();
    expect(cpe('duopitch', 45, 90, 'H')).toBe(-0.9);
    expect(cpe('duopitch', 30, 90, 'G')).toBe(-1.4);
  });
});

describe('flat roofs (§7.2.3 Tab. 7.2, sharp eaves)', () => {
  it('gives F -1.8 / G -1.2 / H -0.7 and I ±0.2 below 5°', () => {
    for (const pitch of [0, 2.5, FLAT_ROOF_LIMIT - 0.01]) {
      expect(roofCoefficients('duopitch', pitch, 0)).toEqual({
        F: { suction: -1.8, pressure: -1.8 },
        G: { suction: -1.2, pressure: -1.2 },
        H: { suction: -0.7, pressure: -0.7 },
        I: { suction: -0.2, pressure: 0.2 },
      });
    }
    expect(roofCoefficients('flat', 30, 90)).toEqual(roofCoefficients('flat', 0, 0));
    expect(roofCoefficients('monopitch', 0, 180)).toEqual(roofCoefficients('flat', 0, 0));
  });

  it('averages the flat roof as H windward and I leeward', () => {
    expect(frameRoofAverage('flat', 0, 0, 'suction', 'windward')).toBe(-0.7);
    expect(frameRoofAverage('flat', 0, 0, 'suction', 'leeward')).toBe(-0.2);
    expect(frameRoofAverage('flat', 0, 0, 'pressure', 'leeward')).toBe(0.2);
  });
});

describe('monopitch Tab. 7.3a', () => {
  it('reproduces the former hard-coded 5° values', () => {
    expect(['F', 'G', 'H'].map((zone) => cpe('monopitch', 5, 0, zone as RoofZone))).toEqual([
      -1.7, -1.2, -0.6,
    ]);
    expect(['F', 'G', 'H'].map((zone) => cpe('monopitch', 5, 180, zone as RoofZone))).toEqual([
      -2.3, -1.3, -0.8,
    ]);
    expect(
      ['Fup', 'Flow', 'G', 'H', 'I'].map((zone) => cpe('monopitch', 5, 90, zone as RoofZone)),
    ).toEqual([-1.6, -1.6, -1.8, -0.6, -0.5]);
  });

  it('stays within 0.05 of the former values at 10° where the standard keeps them, and follows the table elsewhere', () => {
    // θ = 90° (approximate rows) and θ = 180° zone G are constant over 5-15°.
    for (const [zone, former] of [
      ['Fup', -1.6],
      ['G', -1.8],
      ['H', -0.6],
      ['I', -0.5],
    ] as const) {
      expect(Math.abs(cpe('monopitch', 10, 90, zone) - former)).toBeLessThanOrEqual(0.05);
    }
    expect(cpe('monopitch', 10, 180, 'G')).toBeCloseTo(-1.3, 9);
    expect(Math.abs(cpe('monopitch', 10, 180, 'H') + 0.8)).toBeLessThanOrEqual(0.05 + 1e-9);
    // Tab. 7.3a θ = 0° and 180° (F) fall with the pitch: 15° is -0.3 / -2.5, so 10° is the midpoint.
    expect(cpe('monopitch', 10, 0, 'H')).toBeCloseTo(-0.45, 9);
    expect(cpe('monopitch', 10, 180, 'F')).toBeCloseTo(-2.4, 9);
  });

  it('has a pressure set on the low eaves only', () => {
    expect(cpe('monopitch', 30, 0, 'F', 'pressure')).toBe(0.7);
    expect(cpe('monopitch', 30, 180, 'F', 'pressure')).toBe(cpe('monopitch', 30, 180, 'F'));
    expect(cpe('monopitch', 45, 0, 'H', 'pressure')).toBe(0.6);
  });

  it('takes zone H as the monopitch frame average, whatever the slope', () => {
    expect(frameRoofAverage('monopitch', 10, 0, 'suction', 'leeward')).toBeCloseTo(-0.45, 9);
    expect(frameRoofAverage('monopitch', 10, 180, 'suction')).toBeCloseTo(-0.85, 9);
    expect(frameRoofAverage('monopitch', 30, 0, 'pressure')).toBe(0.4);
  });
});

describe('duopitch frame average', () => {
  it('uses H windward and the area-weighted I / J leeward', () => {
    expect(frameRoofAverage('duopitch', 15, 0, 'suction', 'windward')).toBeCloseTo(-0.3, 9);
    expect(frameRoofAverage('duopitch', 15, 0, 'suction', 'leeward')).toBeCloseTo(
      0.9 * -0.4 + 0.1 * -1.0,
      9,
    );
    expect(frameRoofAverage('duopitch', 30, 0, 'pressure')).toBeCloseTo(0.4, 9);
  });
});

const HALL = { span: 24000, length: 30000 };
const LOADS = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 1 };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params })
    .document;
}

function framesOfHall(doc: CadDocument): FrameModel[] {
  const building = doc.building!;
  return framesOf(doc, building, building.levelOrder[0]!, LOADS).frames;
}

/** Roof rafter loads of the first frame, left to right. */
const rafterLoads = (frame: FrameModel, loadCase: 'WL' | 'WLp' | 'WR' | 'WRp'): number[] =>
  frame.members
    .filter((member) => member.role === 'rafter')
    .sort((a, b) => (frame.nodes[a.geometry.a]?.x ?? 0) - (frame.nodes[b.geometry.a]?.x ?? 0))
    .map((member) => member.loads[loadCase]!.qy);

describe('frame roof wind loads', () => {
  it('keeps the four base wind cases on the default 6° hall', () => {
    const frame = framesOfHall(hall())[0]!;
    expect(frame.windCases.map((windCase) => windCase.loadCase)).toEqual([
      'WL',
      'WR',
      'WLs',
      'WRs',
    ]);
    expect(windCasesOf(framesOfHall(hall()))).toEqual([...WIND_CASES]);
    const check = execute(hall(), 'check_portal_frames', { windPressure: 0.9 }).data as {
      combinations: string[];
    };
    expect(check.combinations).toHaveLength(10);
  });

  it('loads the windward slope with H and the leeward slope with I / J at 6°', () => {
    const frame = framesOfHall(hall())[0]!;
    const [windward, leeward] = rafterLoads(frame, 'WL') as [number, number];
    const [h, leewardAverage] = [
      frameRoofAverage('duopitch', 6, 0, 'suction', 'windward'),
      frameRoofAverage('duopitch', 6, 0, 'suction', 'leeward'),
    ];
    expect(windward).toBeGreaterThan(0);
    expect(leeward / windward).toBeCloseTo((0.2 - leewardAverage) / (0.2 - h), 6);
  });

  it('adds a downward windward-rafter pressure case on a 30° duopitch hall', () => {
    const doc = hall({ roofPitch: 30 });
    const frames = framesOfHall(doc);
    const frame = frames[0]!;
    expect(frame.windCases.map((windCase) => windCase.loadCase)).toEqual([
      'WL',
      'WR',
      'WLs',
      'WRs',
      'WLp',
      'WRp',
    ]);
    const [windwardSuction] = rafterLoads(frame, 'WL') as [number, number];
    const [windwardPressure, leewardPressure] = rafterLoads(frame, 'WLp') as [number, number];
    expect(windwardSuction).toBeGreaterThan(0);
    // H pressure +0.4 with cpi -0.3: net 0.7 qp downward; leeward cpe 0 with cpi -0.3: 0.3 qp downward.
    expect(windwardPressure).toBeLessThan(0);
    expect(leewardPressure / windwardPressure).toBeCloseTo(0.3 / 0.7, 6);
    // Mirrored for wind from the right: the right slope is windward.
    expect(rafterLoads(frame, 'WRp')[1]).toBeCloseTo(windwardPressure, 9);
    expect(windCasesOf(frames).map((windCase) => windCase.loadCase)).toContain('WLp');
    const check = execute(doc, 'check_portal_frames', { windPressure: 0.9 }).data as {
      combinations: string[];
    };
    expect(check.combinations).toHaveLength(14);
    expect(check.combinations).toContain('1.35G+1.5W→(roof pressure)+0.75S');
    expect(check.combinations).toContain('1.0G+1.5W←(roof pressure)');
  });

  it('adds the pressure case on a flat roof (leeward I +0.2)', () => {
    const frame = framesOfHall(hall({ roofPitch: 0 }))[0]!;
    expect(frame.windCases.map((windCase) => windCase.loadCase)).toContain('WLp');
    // Windward half H -0.7 uplift, leeward half I -0.2 uplift (suction set).
    const [windward, leeward] = rafterLoads(frame, 'WL') as [number, number];
    expect(leeward / windward).toBeCloseTo((0.2 + 0.2) / (0.2 + 0.7), 6);
    // Pressure set: windward H stays suction, leeward I +0.2 pushes down with cpi -0.3.
    const [pressureWindward, pressureLeeward] = rafterLoads(frame, 'WLp') as [number, number];
    expect(pressureWindward).toBeGreaterThan(0);
    expect(pressureLeeward).toBeLessThan(0);
  });

  it('gives a monopitch roof the pressure case for wind on the low eaves only', () => {
    const frames = framesOfHall(hall({ roofType: 'monopitch', roofPitch: 30 }));
    expect(windCasesOf(frames).map((windCase) => windCase.loadCase)).toEqual([
      'WL',
      'WR',
      'WLs',
      'WRs',
      'WLp',
    ]);
    const [rafter] = rafterLoads(frames[0]!, 'WLp');
    expect(rafter).toBeLessThan(0);
  });

  it('keeps monopitch loads from the table at 6°', () => {
    const frame = framesOfHall(hall({ roofType: 'monopitch' }))[0]!;
    const [low] = rafterLoads(frame, 'WL') as [number];
    const [high] = rafterLoads(frame, 'WR') as [number];
    expect(high / low).toBeCloseTo((0.2 + 0.81) / (0.2 + 0.57), 6);
  });
});

interface PurlinData {
  rows: PurlinRow[];
  zones: ZoneSummary[];
}

const purlinData = (doc: CadDocument, params: Record<string, unknown> = {}): PurlinData =>
  execute(doc, 'check_purlins', params).data as PurlinData;

describe('purlin wind zones per pitch', () => {
  const roofCpes = (data: PurlinData, zone: string): number[] =>
    data.zones
      .filter((entry) => entry.surface === 'roof' && entry.zone === zone)
      .map((entry) => entry.cpe);

  it('reads the zone values from the tables at the roof pitch', () => {
    const shallow = purlinData(hall());
    const steep = purlinData(hall({ roofPitch: 30 }));
    expect(roofCpes(shallow, 'F')).toContain(-1.62);
    expect(Math.min(...roofCpes(steep, 'F'))).toBeCloseTo(-1.1, 9);
    expect(Math.min(...roofCpes(shallow, 'F'))).not.toBeCloseTo(Math.min(...roofCpes(steep, 'F')));
    expect(roofCpes(steep, 'H')).toContain(-0.8);
  });

  it('uses the flat-roof table below 5° (perimeter F / G / H, I inside)', () => {
    const flat = purlinData(hall({ roofPitch: 0 }));
    const zones = new Set(
      flat.zones.filter((entry) => entry.surface === 'roof').map((e) => e.zone),
    );
    expect(zones).toEqual(new Set(['F', 'G', 'H/I']));
    expect(roofCpes(flat, 'F')).toEqual([-1.8]);
    expect(roofCpes(flat, 'G')).toEqual([-1.2]);
    expect(roofCpes(flat, 'H/I').sort()).toEqual([-0.7, -0.2].sort());
  });

  it('puts the ridge strip J on the leeward purlins next to the ridge', () => {
    const data = purlinData(hall({ roofPitch: 20 }));
    const ridgeRows = data.rows.filter((row) => row.zone === 'J');
    expect(ridgeRows.length).toBeGreaterThan(0);
  });

  it('checks downward wind pressure with snow on a steep roof, not on a shallow one', () => {
    const params = { windPressure: 1.5, snowLoad: 0, roofDeadLoad: 1.5 };
    const steep = purlinData(hall({ roofPitch: 30 }), params);
    const downward = steep.rows.filter((row) => row.check.includes('downward wind'));
    expect(downward.length).toBeGreaterThan(0);
    expect(downward[0]!.combination).toMatch(/^1\.35G\+1\.5(W\+0\.75S|S\+0\.9W)$/);
    const shallow = purlinData(hall(), params);
    expect(shallow.rows.some((row) => row.check.includes('downward wind'))).toBe(false);
    const maxPurlin = (data: PurlinData): number =>
      Math.max(...data.rows.filter((row) => row.kind === 'purlin').map((row) => row.utilisation));
    const calm = purlinData(hall({ roofPitch: 30 }), { ...params, windPressure: 0 });
    expect(maxPurlin(steep)).toBeGreaterThan(maxPurlin(calm));
  });

  it('keeps the default hall within 5% of the former purlin utilisation (1.100)', () => {
    const data = purlinData(hall(), { windPressure: 0.9 });
    const worst = Math.max(
      ...data.rows.filter((row) => row.kind === 'purlin').map((r) => r.utilisation),
    );
    expect(Math.abs(worst / 1.0996518767307895 - 1)).toBeLessThan(0.05);
  });
});
