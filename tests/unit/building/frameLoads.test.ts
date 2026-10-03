import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CheckRow } from '@aec/industrial/frameCheckSolve';
import {
  bucklingReduction,
  criticalMoment,
  lateralTorsionalReduction,
  memberBuckling,
  sectionResistance,
} from '@aec/industrial/steelDesign';
import { framesOf } from '@aec/industrial/frameModelFrames';
import {
  craneActions,
  valleyLines,
  craneCapacityOf,
  DOWNWIND_ROOF_FACTOR,
} from '@aec/industrial/frameModelTypes';
import { baseReactions } from '@aec/industrial/frameModelSolve';
import { frameRoofAverage } from '@aec/industrial/windCoefficients';
import { findProfile, sectionProperties } from '@aec/steel/profiles';
import type { SteelMemberElement } from '@core/model/building';

const HALL = { span: 24000, length: 30000 };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params })
    .document;
}

interface CheckData {
  rows: CheckRow[];
  combinations: string[];
  alphaCritical: number | null;
  maxUtilisation: number;
}

function check(doc: CadDocument, params: Record<string, unknown> = {}): CheckData {
  return execute(doc, 'check_portal_frames', params).data as CheckData;
}

const row = (data: CheckData, mark: string, kind: CheckRow['kind']): CheckRow =>
  data.rows.find((candidate) => candidate.mark === mark && candidate.kind === kind)!;

describe('member buckling (EN 1993-1-1 §6.3)', () => {
  it('matches the buckling curves', () => {
    expect(bucklingReduction(0.1, 0.34)).toBe(1);
    expect(bucklingReduction(1, 0.21)).toBeCloseTo(0.666, 3);
    expect(bucklingReduction(1, 0.34)).toBeCloseTo(0.597, 3);
    expect(bucklingReduction(1, 0.49)).toBeCloseTo(0.54, 3);
    expect(bucklingReduction(2, 0.49)).toBeCloseTo(0.196, 3);
  });

  it('reduces the axial resistance of slender columns and interacts with bending', () => {
    const profile = findProfile('HEA240')!;
    const npl = sectionResistance(profile, 355).axial;
    const stocky = memberBuckling(profile, 355, 0.5 * npl, 0, { major: 1000, minor: 1000 });
    const slender = memberBuckling(profile, 355, 0.5 * npl, 0, { major: 8000, minor: 8000 });
    expect(stocky.utilisation).toBeCloseTo(0.5 / stocky.chiMinor, 6);
    expect(slender.chiMinor).toBeLessThan(slender.chiMajor);
    expect(slender.utilisation).toBeGreaterThan(1);
    // Restrained flange (short LTB length): kzy = 1 governs pure bending.
    const bending = memberBuckling(profile, 355, 0, 1e8, {
      major: 8000,
      minor: 8000,
      lateralTorsional: 100,
    });
    expect(bending.chiLateralTorsional).toBe(1);
    expect(bending.utilisation).toBeCloseTo(1e8 / sectionResistance(profile, 355).moment);
    // Hollow and other shapes use their own curves.
    expect(
      memberBuckling(findProfile('SHS100x5')!, 355, 1e5, 0, { major: 3000, minor: 3000 }).chiMajor,
    ).toBeLessThan(1);
    expect(
      memberBuckling(findProfile('L100x10')!, 355, 1e5, 0, { major: 3000, minor: 3000 }).chiMinor,
    ).toBeLessThan(1);
    expect(
      memberBuckling(findProfile('IPE300')!, 355, 1e5, 0, { major: 3000, minor: 3000 }).chiMajor,
    ).toBeGreaterThan(0.9);
  });

  it('uses the class 3 interaction factor for class 3 sections', () => {
    const profile = findProfile('HEA300')!;
    const resistance = sectionResistance(profile, 355);
    expect(resistance.sectionClass).toBe(3);
    const lengths = { major: 6000, minor: 100 };
    const result = memberBuckling(
      profile,
      355,
      0.3 * resistance.axial,
      0.3 * resistance.moment,
      lengths,
    );
    const n = 0.3 / result.chiMajor;
    const lambda = Math.sqrt(
      resistance.axial / ((Math.PI ** 2 * 210000 * sectionProperties(profile).inertia) / 6000 ** 2),
    );
    expect(result.utilisation).toBeCloseTo(n + 0.9 * (1 + 0.6 * Math.min(lambda, 1) * n) * 0.3, 6);
  });
});

describe('lateral-torsional buckling (EN 1993-1-1 §6.3.2)', () => {
  it('matches the hand Mcr of an IPE300 over 6 m and reduces the bending resistance', () => {
    const profile = findProfile('IPE300')!;
    // Catalogue It = 20.1 cm⁴ gives 90.5 kNm; the outline It (no root radii) is ≈ 15.6 cm⁴.
    const mcr = criticalMoment(profile, 6000) / 1e6;
    expect(mcr).toBeGreaterThan(0.88 * 90.5);
    expect(mcr).toBeLessThan(90.5);
    expect(criticalMoment(profile, 6000, 1.13)).toBeCloseTo(1.13 * criticalMoment(profile, 6000));
    expect(criticalMoment(findProfile('SHS100x5')!, 6000)).toBe(Infinity);
    const long = lateralTorsionalReduction(profile, 355, 6000);
    expect(long).toBeLessThan(0.5);
    expect(lateralTorsionalReduction(profile, 355, 500)).toBe(1);
    expect(lateralTorsionalReduction(findProfile('CHS76.1x3.6')!, 355, 6000)).toBe(1);
    const free = memberBuckling(profile, 355, 0, 5e7, {
      major: 6000,
      minor: 6000,
      lateralTorsional: 6000,
    });
    expect(free.utilisation).toBeCloseTo(5e7 / (long * sectionResistance(profile, 355).moment), 6);
  });

  it('restrains columns at the side rails and rafters at the purlins', () => {
    const rows = check(hall()).rows;
    const column = row({ rows } as CheckData, 'SC5', 'column');
    expect(column.utilisation).toBeLessThan(1);
    const sparse = check(hall({ railSpacing: 7000 }));
    expect(row(sparse, 'SC5', 'column').utilisation).toBeGreaterThanOrEqual(column.utilisation);
  });
});

describe('load combinations', () => {
  it('checks snow-only halls with gravity combinations, stability and SLS deflection', () => {
    const data = check(hall());
    expect(data.combinations).toEqual(['1.35G+1.5S (→)', '1.35G+1.5S (←)']);
    expect(data.alphaCritical).toBeGreaterThan(10);
    const deflection = row(data, 'RF5', 'deflection');
    expect(deflection.combination).toBe('SLS S');
    expect(deflection.check).toMatch(/vertical \d+ mm ≤ span\/200 = 120 mm/);
    expect(deflection.utilisation).toBeGreaterThan(0.3);
    expect(deflection.utilisation).toBeLessThan(1);
    expect(data.rows.some((candidate) => candidate.kind === 'stability')).toBe(true);
  });

  it('adds wind (both directions, uplift) with eaves sway checks', () => {
    const doc = hall();
    const calm = check(doc, { snowLoad: 0 });
    const windy = check(doc, { snowLoad: 0, windPressure: 1.0 });
    expect(windy.combinations).toHaveLength(10);
    expect(windy.combinations).toContain('1.0G+1.5W←(cpi−0.3)');
    expect(windy.combinations).toContain('1.0G+1.5W→');
    expect(row(windy, 'SC5', 'column').utilisation).toBeGreaterThan(
      row(calm, 'SC5', 'column').utilisation,
    );
    const sway = windy.rows.find((candidate) => candidate.check.startsWith('eaves sway'))!;
    expect(sway.combination).toMatch(/^SLS W/);
    expect(sway.utilisation).toBeGreaterThan(0);
    // Uplift reverses the apex moment: the bolt group sees both signs.
    const apex = windy.rows.find(
      (candidate) => candidate.kind === 'connection' && candidate.check.startsWith('apex'),
    )!;
    const moments = apex.forces!.map((force) => force.moment);
    expect(Math.max(...moments)).toBeGreaterThan(0);
    expect(Math.min(...moments)).toBeLessThan(0);
    expect(execute(doc, 'check_portal_frames', { windPressure: 1 }).summary).toMatch(
      /qp = 1 kN\/m²/,
    );
  });

  it('applies crane actions from the runway at the brackets', () => {
    const doc = hall({ crane: { capacity: 16, railHeight: 6000 } });
    const withCrane = check(doc);
    const without = check(doc, { craneCapacity: 0 });
    expect(withCrane.combinations).toHaveLength(10);
    expect(withCrane.combinations).toContain('1.35G+1.35C(right)');
    expect(withCrane.combinations).toContain('1.35G+1.35C5(left)');
    expect(withCrane.combinations).toContain('1.35G+1.35C5(right)+0.75S');
    expect(withCrane.combinations[2]).toBe('1.35G+1.35C(left)+0.75S');
    expect(without.combinations).toHaveLength(2);
    const rail = withCrane.rows.find((candidate) => candidate.check.startsWith('rail-level'))!;
    expect(rail.check).toMatch(/h\/400/);
    // A heavy crane governs the columns.
    const heavier = check(doc, { craneCapacity: 50 });
    expect(row(heavier, 'SC5', 'column').utilisation).toBeGreaterThan(
      row(without, 'SC5', 'column').utilisation,
    );
    expect(row(heavier, 'SC5', 'column').combination).toMatch(/^1\.35G\+1\.35C/);
    expect(rail.utilisation).toBeLessThan(
      heavier.rows.find((candidate) => candidate.check.startsWith('rail-level'))!.utilisation,
    );
    const both = check(doc, { windPressure: 0.8 });
    expect(both.combinations).toHaveLength(66);
    expect(both.combinations).toContain('1.35G+1.35C(right)+0.75S+0.9W→');
    expect(both.combinations).toContain('1.35G+1.5W←+0.75S+1.35C(left)');
    expect(both.combinations).toContain('1.35G+1.35C5(left)+0.9W→');
    expect(both.combinations).toContain('1.35G+1.5W←+0.75S+1.35C5(right)');
    // Crane reactions enter below the column tops: they lower αcr (storey-wise Horne).
    expect(heavier.alphaCritical!).toBeLessThan(without.alphaCritical!);
  });

  it('reads crane capacities from the runway note', () => {
    const member = { note: 'Crane 12.5 t, rail top 6000' } as SteelMemberElement;
    expect(craneCapacityOf(member)).toBe(12.5);
    expect(craneCapacityOf({ note: 'crane bracket' } as SteelMemberElement)).toBeNull();
    expect(craneCapacityOf({} as SteelMemberElement)).toBeNull();
  });

  it('derives the EN 1991-3 crane actions by statics (hand check)', () => {
    const [hoist, span] = [98100, 24000];
    const actions = craneActions(10, span);
    const self = 0.5 * hoist + 20000;
    const [near, far] = [23 / 24, 1 / 24];
    // φ2 = φ2,min + β2 vh, HC2 at vh = 0.1 m/s.
    expect(actions.phi2).toBeCloseTo(1.1 + 0.34 * 0.1, 9);
    expect(actions.selfWeight).toBeCloseTo(self, 6);
    expect(actions.staticMax).toBeCloseTo(0.4 * self + (0.2 * self + hoist) * near, 3);
    expect(actions.staticMax + actions.staticMin).toBeCloseTo(self + hoist, 3);
    expect(actions.group1.max).toBeCloseTo(
      1.1 * (0.4 * self + 0.2 * self * near) + 1.134 * hoist * near,
      3,
    );
    expect(actions.group1.min).toBeCloseTo(
      1.1 * (0.4 * self + 0.2 * self * far) + 1.134 * hoist * far,
      3,
    );
    expect(actions.group1.max).toBeGreaterThan(actions.group1.min);
    // Drive: K = μ Σ driven = 0.2 Rmin, HL = φ5 K / 2, HT = φ5 ξ M / a with M = K (ξ1 − 0.5) l.
    const drive = 0.2 * actions.staticMin;
    const xi1 = actions.staticMax / (actions.staticMax + actions.staticMin);
    const moment = drive * (xi1 - 0.5) * span;
    expect(actions.group1.longitudinal).toBeCloseTo((1.5 * drive) / 2, 6);
    expect(actions.group1.transverseMax).toBeCloseTo((1.5 * (1 - xi1) * moment) / 3000, 6);
    expect(actions.group1.transverseMin).toBeCloseTo((1.5 * xi1 * moment) / 3000, 6);
    // Group 5: φ4 = 1, f = 0.3 (1 − exp(−250 · 0.015)) = 0.2929, HS = f λS ΣQr.
    const f = 0.3 * (1 - Math.exp(-3.75));
    expect(f).toBeCloseTo(0.2929, 4);
    expect(actions.group5.max).toBeCloseTo(actions.staticMax, 6);
    expect(actions.group5.skewMax).toBeCloseTo((f * (1 - xi1) * (self + hoist)) / 2, 6);
    expect(actions.group5.skewMin).toBeCloseTo((f * xi1 * (self + hoist)) / 2, 6);
  });

  it('honours the hoisting class, self-weight, hook approach and wheel base overrides', () => {
    const heavy = craneActions(10, 24000, {
      hoistingClass: 'HC4',
      hoistingSpeed: 0.5,
      craneSelfWeight: 100,
      minHookApproach: 2,
      wheelBase: 4000,
    });
    expect(heavy.phi2).toBeCloseTo(1.2 + 0.68 * 0.5, 9);
    expect(heavy.selfWeight).toBe(100000);
    expect(heavy.staticMax + heavy.staticMin).toBeCloseTo(100000 + 98100, 3);
    expect(heavy.staticMin).toBeCloseTo(0.4 * 100000 + (20000 + 98100) * (2 / 24), 3);
    expect(heavy.group1.transverseMax).toBeLessThan(
      craneActions(10, 24000).group1.transverseMax * 2,
    );
    // Hook approach beyond the span is clamped: all load on one rail side, no negative reaction.
    expect(craneActions(10, 24000, { minHookApproach: 99 }).staticMin).toBeGreaterThan(0);
  });

  it('carries both crane load groups into the frame model and the base reactions', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 6000 } });
    const building = doc.building!;
    const loads = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 0 };
    const reactions = baseReactions(doc, building, building.levelOrder[0]!, loads).filter(
      (reaction) => reaction.frame === 'frame 3',
    );
    const vertical = (key: 'CL' | 'CR' | 'CL5' | 'CR5'): number =>
      reactions.reduce((sum, reaction) => sum + (reaction.cases[key]?.vertical ?? 0), 0);
    const horizontal = (key: 'CL' | 'CL5' | 'CR'): number =>
      reactions.reduce((sum, reaction) => sum + (reaction.cases[key]?.horizontal ?? 0), 0);
    // Gc = 69.05 kN, Q = 98.1 kN: group 1 φ1 Gc + φ2 Q, group 5 φ4 (Gc + Q).
    expect(vertical('CL')).toBeCloseTo(1.1 * 69050 + 1.134 * 98100, -1);
    expect(vertical('CL5')).toBeCloseTo(69050 + 98100, -1);
    expect(vertical('CR')).toBeCloseTo(vertical('CL'), -1);
    expect(vertical('CR5')).toBeCloseTo(vertical('CL5'), -1);
    // Group 1 transverse HT = both rails in +x (CL) / −x (CR); skewing HS (group 5) is a couple.
    const actions = craneActions(10, 22610);
    expect(horizontal('CL')).toBeCloseTo(
      -(actions.group1.transverseMax + actions.group1.transverseMin),
      -1,
    );
    expect(horizontal('CR')).toBeCloseTo(-horizontal('CL'), -1);
    expect(Math.abs(horizontal('CL5'))).toBeLessThan(Math.abs(horizontal('CL')));
  });

  it('flags sway-sensitive frames (αcr < 3) and amplifies their moments', () => {
    const data = check(hall({ rafterProfile: 'IPE300', columnProfile: 'HEA240' }));
    expect(data.alphaCritical).toBeLessThan(3);
    const stability = data.rows.filter((candidate) => candidate.kind === 'stability');
    expect(Math.max(...stability.map((candidate) => candidate.utilisation))).toBeGreaterThan(1);
    expect(row(data, 'RF5', 'rafter').check).toMatch(/sway ×\d\.\d\d/);
  });

  it('caps αcr by rafter buckling where Horne does not apply (steep roofs)', () => {
    const steep = check(hall({ roofPitch: 30 }));
    const stability = steep.rows.find((candidate) => candidate.kind === 'stability')!;
    expect(stability.check).toMatch(/modified Horne 0\.8 αH \(1 − N\/Ncr\), roof slope > 26°/);
    expect(check(hall()).rows.find((candidate) => candidate.kind === 'stability')!.check).toMatch(
      /\(Horne;/,
    );
  });

  it('reports frames that are mechanisms as unstable', () => {
    let doc = createEmptyDocument();
    for (const y of [0, 6000]) {
      for (const [start, end] of [
        [
          [0, y, 6000],
          [6000, y, 6500],
        ],
        [
          [6000, y, 6500],
          [12000, y, 6000],
        ],
      ]) {
        doc = execute(doc, 'add_steel_member', {
          profile: 'IPE300',
          role: 'rafter',
          start,
          end,
        }).document;
      }
    }
    const result = execute(doc, 'check_portal_frames', {});
    expect(result.summary).toMatch(/no analysable portal frame.*\(unstable\)/);
  });

  it('passes the crane model parameters and rejects invalid ones', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 6000 } });
    const base = check(doc, { windPressure: 0.8 });
    const tuned = execute(doc, 'check_portal_frames', {
      windPressure: 0.8,
      hoistingClass: 'HC4',
      hoistingSpeed: 0.5,
      craneSelfWeight: 120,
      minHookApproach: 0.5,
      wheelBase: 5000,
    });
    expect(tuned.summary).toMatch(/^Checked 6 frame/);
    const tunedData = tuned.data as CheckData;
    expect(tunedData.combinations).toEqual(base.combinations);
    expect(row(tunedData, 'SC5', 'column').axial).not.toBe(row(base, 'SC5', 'column').axial);
    for (const bad of [
      { hoistingClass: 'HC9' },
      { hoistingSpeed: -1 },
      { minHookApproach: -1 },
      { craneSelfWeight: 0 },
      { wheelBase: 0 },
    ]) {
      const result = execute(doc, 'check_portal_frames', bad);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toMatch(/^check_portal_frames (failed|rejected): /);
    }
  });

  it('rejects negative wind or crane input', () => {
    const doc = hall();
    expect(execute(doc, 'check_portal_frames', { windPressure: -1 }).summary).toMatch(
      /must be >= 0/,
    );
    expect(execute(doc, 'design_portal_frames', { craneCapacity: -2 }).summary).toMatch(
      /must be >= 0/,
    );
  });
});

describe('design_portal_frames with wind and crane', () => {
  it('designs a crane hall under wind so every check passes', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 6000 } });
    const result = execute(doc, 'design_portal_frames', { windPressure: 0.7 });
    expect(result.summary).toMatch(/Designed 6 frame\(s\) for 66 ULS combination\(s\)/);
    const after = check(result.document, { windPressure: 0.7 });
    expect(after.maxUtilisation).toBeLessThanOrEqual(1);
  });
});

const windward = frameRoofAverage('duopitch', 6, 0, 'suction', 'windward');
const leeward = frameRoofAverage('duopitch', 6, 0, 'suction', 'leeward');

describe('internal pressure (EN 1991-1-4 §7.2.9)', () => {
  it('loads the windward column harder with internal suction and lifts the roof more with pressure', () => {
    const doc = hall();
    const building = doc.building!;
    const reactions = baseReactions(doc, building, building.levelOrder[0]!, {
      deadLoad: 0.5,
      snowLoad: 0.8,
      windPressure: 1,
    }).filter((reaction) => reaction.frame === 'frame 3');
    // Same net sway (cpi acts on both walls): equal total horizontal reaction.
    const total = (key: 'WL' | 'WLs'): number =>
      reactions.reduce((sum, reaction) => sum + reaction.cases[key]!.horizontal, 0);
    expect(total('WLs')).toBeCloseTo(total('WL'), 0);
    // Roof uplift (cpi − cpe over both slopes, 6°): windward H, leeward I/J average.
    const uplift = (key: 'WL' | 'WLs'): number =>
      reactions.reduce((sum, reaction) => sum + reaction.cases[key]!.vertical, 0);
    const roof = windward + leeward;
    expect(uplift('WL') / uplift('WLs')).toBeCloseTo((0.4 - roof) / (-0.6 - roof), 3);
  });
});

describe('baseReactions', () => {
  it('balances the applied loads per case', () => {
    const doc = hall();
    const building = doc.building!;
    const reactions = baseReactions(
      doc,
      building,
      building.activeLevelId ?? building.levelOrder[0]!,
      {
        deadLoad: 0.5,
        snowLoad: 0.8,
        windPressure: 1,
      },
    );
    const frame = reactions.filter((reaction) => reaction.frame === 'frame 3');
    expect(frame).toHaveLength(2);
    // Snow 0.8 kN/m² × 6 m × 24 m on plan.
    const snow = frame.reduce((sum, reaction) => sum + reaction.cases.S!.vertical, 0);
    expect(snow / 1000).toBeCloseTo(0.8 * 6 * 24, 0);
    // Wind on both walls (0.8 + 0.5) × 1 kN/m² × 6 m × eaves height, resisted horizontally.
    const horizontal = frame.reduce((sum, reaction) => sum + reaction.cases.WL!.horizontal, 0);
    expect(horizontal / 1000).toBeCloseTo(-(0.8 + 0.5) * 6 * 7, 0);
    expect(
      frame.every((reaction) => reaction.cases.WL!.vertical < reaction.cases.G!.vertical),
    ).toBe(true);
  });
});

describe('multi-span roof wind (EN 1991-1-4 §7.2.7, Fig. 7.10 simplified)', () => {
  const loads = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 1 };
  const frameOf = (doc: CadDocument): ReturnType<typeof framesOf>['frames'][number] => {
    const building = doc.building!;
    return framesOf(doc, building, building.levelOrder[0]!, loads).frames[0]!;
  };
  /** Wind uplift per unit length (N/mm) of each rafter, left to right. */
  const uplifts = (doc: CadDocument, windCase: 'WL' | 'WR' | 'WLs'): number[] => {
    const frame = frameOf(doc);
    return frame.members
      .filter((member) => member.role === 'rafter')
      .sort((a, b) => (frame.nodes[a.geometry.a]?.x ?? 0) - (frame.nodes[b.geometry.a]?.x ?? 0))
      .map((member) => member.loads[windCase]!.qy);
  };

  it('finds the valleys between roofs from the rafter low ends', () => {
    expect(
      valleyLines([
        { start: [0, 0, 7000], end: [10000, 0, 8000] },
        { start: [10000, 0, 8000], end: [20000, 0, 7000] },
        { start: [20000, 0, 7000], end: [30000, 0, 8000] },
        { start: [30000, 0, 8000], end: [40000, 0, 7000] },
        { start: [20000, 6000, 7000], end: [30000, 6000, 8000] },
      ]),
    ).toEqual([20000]);
  });

  it('loads the downwind spans with 0.6x the suction of the windward span', () => {
    const doc = hall({ spans: [20000, 20000, 20000], span: undefined });
    const frame = frameOf(doc);
    expect(frame.spans).toHaveLength(3);
    const wind = uplifts(doc, 'WL');
    expect(wind).toHaveLength(6);
    // Windward span: slopes (cpi − H) and (cpi − I/J); downwind spans (spans 2, 3): the same × 0.6 on the suction.
    const [windwardSlope, leewardSlope, downwindWindward, downwindLeeward] = wind as [
      number,
      number,
      number,
      number,
    ];
    expect(downwindWindward / windwardSlope).toBeCloseTo(
      (0.2 - DOWNWIND_ROOF_FACTOR * windward) / (0.2 - windward),
      6,
    );
    expect(downwindLeeward / leewardSlope).toBeCloseTo(
      (0.2 - DOWNWIND_ROOF_FACTOR * leeward) / (0.2 - leeward),
      6,
    );
    expect(wind[4]).toBeCloseTo(downwindWindward, 9);
    expect(wind[5]).toBeCloseTo(downwindLeeward, 9);
    // Wind from the right mirrors it: the last span is windward.
    const mirrored = uplifts(doc, 'WR');
    expect(mirrored[5]).toBeCloseTo(windwardSlope, 9);
    expect(mirrored[4]).toBeCloseTo(leewardSlope, 9);
    expect(mirrored[1]).toBeCloseTo(downwindWindward, 9);
    expect(mirrored[0]).toBeCloseTo(downwindLeeward, 9);
    // Internal suction cpi = −0.3.
    const suction = uplifts(doc, 'WLs');
    expect(suction[2]! / suction[0]!).toBeCloseTo(
      (-0.3 - DOWNWIND_ROOF_FACTOR * windward) / (-0.3 - windward),
      6,
    );
  });

  it('puts wall pressure on the outer columns only', () => {
    const frame = frameOf(hall({ spans: [20000, 20000, 20000], span: undefined }));
    const columns = frame.members.filter((member) => member.role === 'column');
    const xs = [...new Set(columns.map((member) => frame.nodes[member.geometry.a]?.x))].sort(
      (a, b) => (a ?? 0) - (b ?? 0),
    );
    expect(xs).toHaveLength(4);
    for (const column of columns) {
      const x = frame.nodes[column.geometry.a]?.x;
      const outer = x === xs[0] || x === xs[3];
      expect(column.loads.WL !== undefined).toBe(outer);
    }
  });

  it('leaves a single span unreduced: windward slope H, leeward slope I/J, mirrored by the wind side', () => {
    const doc = hall();
    const wind = uplifts(doc, 'WL');
    expect(wind).toHaveLength(2);
    expect(wind[1]! / wind[0]!).toBeCloseTo((0.2 - leeward) / (0.2 - windward), 6);
    const mirrored = uplifts(doc, 'WR');
    expect(mirrored[1]).toBeCloseTo(wind[0]!, 9);
    expect(mirrored[0]).toBeCloseTo(wind[1]!, 9);
    expect(uplifts(doc, 'WLs')[0]! / wind[0]!).toBeCloseTo((-0.3 - windward) / (0.2 - windward), 6);
  });
});
