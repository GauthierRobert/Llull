import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { checkSteelMembers } from '@aec/industrial/steelMembersCheck';
import { pipeWeightPerMetre } from '@aec/industrial/pipeWeight';
import { findProfile, sectionProperties } from '@aec/steel/profiles';
import {
  G,
  beam,
  brace,
  check,
  column,
  rowOf,
  rowsByRole,
  squareBay,
  step,
  twoLevels,
} from './steelFixtures';

const IPE300 = (findProfile('IPE300')?.massPerMetre ?? 0) * G * 1e-3; // kN/m
const HEB200 = (findProfile('HEB200')?.massPerMetre ?? 0) * G * 1e-3; // kN/m

describe('check_steel_members registration', () => {
  it('is a read-only industrial tool', () => {
    expect(getCommand('check_steel_members')?.name).toBe(checkSteelMembers.name);
    expect(checkSteelMembers.annotations).toEqual({ readOnly: true, idempotent: true });
  });

  it('is pure: same document back, nothing affected, input untouched', () => {
    const doc = squareBay({ equipmentKg: 5000 });
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'check_steel_members', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.summary).toContain('8 member(s), 8 analysed');
  });
});

describe('beam under its self weight', () => {
  const lone = (): ReturnType<typeof twoLevels> => {
    let doc = twoLevels();
    doc = column(doc, 0, 0);
    doc = column(doc, 6000, 0);
    return beam(doc, [0, 0], [6000, 0]);
  };

  it('has M = 1.35 wL²/8 and δ = 5wL⁴/384EI', () => {
    const data = check(lone());
    const row = rowOf(data, 'SB1');
    expect(row.forces['MEd']).toBeCloseTo((1.35 * IPE300 * 36) / 8, 2);
    expect(row.forces['VEd']).toBeCloseTo((1.35 * IPE300 * 6) / 2, 2);
    const profile = findProfile('IPE300');
    if (!profile) throw new Error('IPE300');
    const expected = (5 * IPE300 * 6000 ** 4) / (384 * 210000 * sectionProperties(profile).inertia);
    expect(Math.abs((row.forces['deflection'] ?? 0) - expected) / expected).toBeLessThan(5e-3);
    expect(row.analysed).toBe(true);
    expect(row.ok).toBe(true);
  });

  it('checks lateral-torsional buckling when nothing restrains the top flange', () => {
    const row = rowOf(check(lone()), 'SB1');
    const bending = row.checks.find((entry) => entry.name.startsWith('bending'));
    expect(bending?.name).toContain('LTB checked');
    expect(row.detail).toBeTruthy();
    const restrained = rowOf(check(squareBay()), 'SB1');
    expect(restrained.checks.find((entry) => entry.name.startsWith('bending'))?.name).toContain(
      'LTB restrained',
    );
  });
});

describe('floor and equipment load path', () => {
  const FLOOR_DEAD = 0.5;
  const IMPOSED = 5;

  it('gives every beam of a square bay a quarter of the floor load', () => {
    const data = check(squareBay());
    const floor = data.loads.floors[0];
    expect(floor?.areaM2).toBeCloseTo(36, 6);
    expect(floor?.deadKn).toBeCloseTo(36 * FLOOR_DEAD, 6);
    expect(floor?.imposedKn).toBeCloseTo(36 * IMPOSED, 6);
    const reactions = ['SB1', 'SB2', 'SB3', 'SB4'].map((mark) => rowOf(data, mark).forces);
    const expected = (1.35 * (36 * FLOOR_DEAD + 4 * IPE300 * 6) + 1.5 * 36 * IMPOSED) / 4 / 2;
    for (const forces of reactions) {
      expect(forces['reactionStart']).toBeCloseTo(expected, 2);
      expect(forces['reactionEnd']).toBeCloseTo(expected, 2);
      expect(forces['MEd']).toBeCloseTo(reactions[0]?.['MEd'] ?? 0, 6);
    }
  });

  it('delivers the full equipment weight, through the beams, to the columns', () => {
    const kg = 20000;
    const data = check(squareBay({ equipmentKg: kg }));
    const weight = (kg * G) / 1000;
    expect(data.loads.equipment[0]?.carriedKn).toBeCloseTo(weight, 6);
    expect(data.loads.equipment[0]?.support).toBe('floor');
    const beams = rowsByRole(data, 'beam');
    const reactionSum = beams.reduce(
      (sum, row) => sum + (row.forces['reactionStart'] ?? 0) + (row.forces['reactionEnd'] ?? 0),
      0,
    );
    const imposed = IMPOSED * (36 - 4);
    const expectedBeams = 1.35 * (36 * FLOOR_DEAD + weight + 4 * IPE300 * 6) + 1.5 * imposed;
    expect(Math.abs(reactionSum - expectedBeams) / expectedBeams).toBeLessThan(2e-3);
    const columns = rowsByRole(data, 'column');
    const columnSum = columns.reduce((sum, row) => sum + (row.forces['NEd'] ?? 0), 0);
    const expectedColumns = expectedBeams + 1.35 * 4 * HEB200 * 3;
    expect(Math.abs(columnSum - expectedColumns) / expectedColumns).toBeLessThan(2e-3);
  });

  it('does not apply the imposed load under the equipment footprint', () => {
    const data = check(squareBay({ equipmentKg: 1000 }));
    expect(data.loads.floors[0]?.imposedKn).toBeCloseTo(IMPOSED * (36 - 4), 0);
  });

  it('sends an equipment straddling a beam line mostly to that beam', () => {
    let doc = twoLevels();
    const columns: Array<[number, number]> = [
      [0, 0],
      [6000, 0],
      [12000, 0],
      [12000, 6000],
      [6000, 6000],
      [0, 6000],
    ];
    for (const [x, y] of columns) doc = column(doc, x, y);
    doc = beam(doc, [0, 0], [6000, 0]);
    doc = beam(doc, [6000, 0], [12000, 0]);
    doc = beam(doc, [12000, 6000], [6000, 6000]);
    doc = beam(doc, [6000, 6000], [0, 6000]);
    doc = beam(doc, [0, 6000], [0, 0]);
    doc = beam(doc, [12000, 0], [12000, 6000]);
    doc = beam(doc, [6000, 0], [6000, 6000]);
    doc = step(doc, 'add_slab', {
      levelId: 'level-2',
      boundary: [
        [0, 0],
        [12000, 0],
        [12000, 6000],
        [0, 6000],
      ],
      thickness: 30,
    });
    doc = step(doc, 'add_equipment', {
      name: 'Skid',
      levelId: 'level-2',
      location: [6000, 3000],
      size: [2000, 2000, 1000],
      weight: 30000,
    });
    const data = check(doc);
    const middle = rowOf(data, 'SB7');
    const others = ['SB1', 'SB2', 'SB3', 'SB4', 'SB5', 'SB6'].map((mark) => rowOf(data, mark));
    expect(data.loads.equipment[0]?.carriedKn).toBeCloseTo((30000 * G) / 1000, 6);
    const share = (middle.forces['reactionStart'] ?? 0) * 2;
    expect(share).toBeGreaterThan(1.35 * ((30000 * G) / 1000) * 0.95);
    for (const row of others)
      expect(row.forces['MEd'] ?? 0).toBeLessThan(middle.forces['MEd'] ?? 0);
  });

  it('reports equipment on grade and carries none of it', () => {
    let doc = squareBay();
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      levelId: 'level-1',
      location: [20000, 0],
      size: [2000, 2000, 3000],
      weight: 10000,
    });
    const data = check(doc);
    const tank = data.loads.equipment.find((entry) => entry.mark !== 'E-1');
    expect(tank?.support).toBe('grade');
    expect(tank?.carriedKn).toBe(0);
    expect(data.warnings.some((text) => text.includes('stands on grade'))).toBe(true);
  });

  it('puts equipment standing on beams (no floor slab) on those beams', () => {
    let doc = squareBay({ slab: false });
    doc = step(doc, 'add_equipment', {
      name: 'Skid',
      levelId: 'level-2',
      location: [3000, 3000],
      size: [2000, 2000, 1000],
      weight: 8000,
    });
    // the equipment base is the level elevation (3000) = 30 mm above the beam tops: carried by beams
    const data = check(doc);
    expect(data.loads.equipment[0]?.support).toBe('beams');
    expect(data.loads.equipment[0]?.carriedKn).toBeCloseTo((8000 * G) / 1000, 6);
  });

  it('warns about a floor slab with no beam at its level', () => {
    let doc = twoLevels();
    doc = column(doc, 0, 0);
    doc = step(doc, 'add_slab', {
      levelId: 'level-2',
      boundary: [
        [0, 0],
        [3000, 0],
        [3000, 3000],
        [0, 3000],
      ],
      thickness: 30,
    });
    const data = check(doc);
    expect(data.warnings.some((text) => text.includes('has no steel beam at its level'))).toBe(
      true,
    );
    expect(data.loads.floors[0]?.supportingBeams).toBe(0);
  });
});

describe('column buckling', () => {
  it('matches a hand calculation of Nb,Rd (curve c about the weak axis)', () => {
    const kg = 200000;
    const data = check(squareBay({ equipmentKg: kg }));
    const weight = (kg * G) / 1000;
    const total = 1.35 * (36 * 0.5 + weight + 4 * IPE300 * 6 + 4 * HEB200 * 3) + 1.5 * 5 * 32;
    const axial = total / 4;
    // HEB200 outline: A = 2·200·15 + 170·9, Iz = 2·15·200³/12 + 170·9³/12, Lcr = 3000 − 180 = 2820
    const area = 2 * 200 * 15 + 170 * 9;
    const inertia = (2 * 15 * 200 ** 3) / 12 + (170 * 9 ** 3) / 12;
    const npl = area * 355;
    const lambda = Math.sqrt(npl / ((Math.PI ** 2 * 210000 * inertia) / 2820 ** 2));
    const phi = 0.5 * (1 + 0.49 * (lambda - 0.2) + lambda ** 2);
    const chi = 1 / (phi + Math.sqrt(phi ** 2 - lambda ** 2));
    const expected = (axial * 1000) / (chi * npl);
    const row = rowOf(data, 'SC1');
    const buckling = row.checks.find((entry) => entry.name.startsWith('flexural buckling'));
    expect(buckling?.utilisation).toBeGreaterThan(0.2);
    expect(Math.abs((buckling?.utilisation ?? 0) - expected) / expected).toBeLessThan(5e-3);
    expect(row.forces['NEd']).toBeCloseTo(axial, 0);
    expect(row.check).toContain('flexural buckling');
  });

  it('splits a continuous column at every beam level and carries the load down', () => {
    let doc = twoLevels();
    doc = step(doc, 'add_level', { name: 'Top', elevation: 6000, height: 3000, makeActive: false });
    doc = column(doc, 0, 0, 'HEB200', 6000);
    doc = column(doc, 6000, 0, 'HEB200', 6000);
    for (const level of ['level-2', 'level-3']) {
      doc = step(doc, 'add_steel_member', {
        role: 'beam',
        profile: 'IPE300',
        start: [0, 0, -180],
        end: [6000, 0, -180],
        levelId: level,
      });
    }
    const data = check(doc);
    const lower = rowOf(data, 'SC1');
    // reactions of two floors: each beam end 1.35 · wL/2; column self weight over the full 6 m
    const reaction = 1.35 * ((IPE300 * 6) / 2);
    expect(lower.forces['NEd']).toBeCloseTo(2 * reaction + 1.35 * HEB200 * 6, 2);
    expect(lower.forces['segments']).toBe(3);
  });
});

describe('pipes and trays', () => {
  const pipeBeamDoc = (underside: number): ReturnType<typeof twoLevels> => {
    let doc = twoLevels();
    doc = column(doc, 3000, 0);
    doc = column(doc, 3000, 4000);
    doc = beam(doc, [3000, 0], [3000, 4000]);
    // pipe along X crossing the beam at y = 2000; level-1 elevation is 0, beam top of steel 2970
    return step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      diameter: 114.3,
      service: 'water',
      points: [
        [0, 2000, underside + 57.15],
        [6000, 2000, underside + 57.15],
      ],
    });
  };

  it('detects the beam a pipe rests on and loads it with the pipe weight', () => {
    const data = check(pipeBeamDoc(2970));
    const line = data.loads.lines[0];
    expect(line?.supports).toBe(1);
    const weight = pipeWeightPerMetre(114.3, 1000);
    expect(line?.weightPerMetre).toBeCloseTo(weight, 9);
    expect(line?.carriedKn).toBeCloseTo(weight * 6, 6);
    const row = rowOf(data, 'SB1');
    expect(row.forces['MEd']).toBeCloseTo(1.35 * (weight * 6 * 1 + (IPE300 * 16) / 8), 2);
    expect(row.checks.some((entry) => entry.name.includes('LTB restrained'))).toBe(true);
    expect(row.detail).toBeTruthy();
  });

  it('still counts a pipe within 10 mm of the top of steel as resting', () => {
    expect(check(pipeBeamDoc(2978)).loads.lines[0]?.supports).toBe(1);
  });

  it('does not count a pipe floating above the beam', () => {
    const data = check(pipeBeamDoc(3030));
    expect(data.loads.lines[0]?.supports).toBe(0);
    expect(data.warnings.some((text) => text.includes('rests on no steel beam'))).toBe(true);
  });

  it('shares a run between supports by half the span to the neighbours', () => {
    let doc = twoLevels();
    for (const x of [1000, 3000]) {
      doc = column(doc, x, 0);
      doc = column(doc, x, 4000);
      doc = beam(doc, [x, 0], [x, 4000]);
    }
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      diameter: 114.3,
      points: [
        [0, 2000, 3027.15],
        [6000, 2000, 3027.15],
      ],
    });
    const data = check(doc);
    const weight = pipeWeightPerMetre(114.3, 1000);
    expect(data.loads.lines[0]?.supports).toBe(2);
    expect(data.loads.lines[0]?.carriedKn).toBeCloseTo(weight * 6, 6);
    // support 1: 1 m overhang + 1 m half span = 2 m; support 2: 1 m half span + 3 m overhang = 4 m
    const momentOf = (mark: string): number =>
      (rowOf(data, mark).forces['MEd'] ?? 0) / 1.35 - (IPE300 * 16) / 8;
    expect(momentOf('SB2') / momentOf('SB1')).toBeCloseTo(2, 2);
  });

  it('supports a cable tray by its underside and weighs it per metre', () => {
    let doc = twoLevels();
    doc = column(doc, 3000, 0);
    doc = column(doc, 3000, 4000);
    doc = beam(doc, [3000, 0], [3000, 4000]);
    doc = step(doc, 'add_cable_tray', {
      levelId: 'level-1',
      width: 600,
      height: 100,
      points: [
        [0, 2000, 3020],
        [6000, 2000, 3020],
      ],
    });
    const data = check(doc, { cableTrayWeight: 60 });
    expect(data.loads.lines[0]?.supports).toBe(1);
    expect(data.loads.lines[0]?.weightPerMetre).toBeCloseTo((60 * G) / 1000, 9);
    expect(data.loads.lines[0]?.carriedKn).toBeCloseTo((60 * G * 6) / 1000, 6);
  });

  it('weighs empty pipes lighter than water-filled ones', () => {
    const doc = pipeBeamDoc(2970);
    const full = check(doc).loads.lines[0]?.carriedKn ?? 0;
    const empty = check(doc, { pipeContentDensity: 0 }).loads.lines[0]?.carriedKn ?? 0;
    expect(empty).toBeLessThan(full * 0.75);
  });
});

describe('beams framing into beams', () => {
  it('transfers a secondary beam reaction as a point load on the primary', () => {
    let doc = twoLevels();
    for (const [x, y] of [
      [0, 0],
      [6000, 0],
      [3000, 4000],
    ] as const) {
      doc = column(doc, x, y);
    }
    doc = beam(doc, [0, 0], [6000, 0]);
    doc = beam(doc, [3000, 4000], [3000, 0], 'IPE200', 200);
    const data = check(doc);
    const secondary = (findProfile('IPE200')?.massPerMetre ?? 0) * G * 1e-3;
    const primary = rowOf(data, 'SB1');
    // primary: own UDL + the secondary's permanent end reaction (secondary L = 4 m) at mid-span
    const point = (secondary * 4) / 2;
    expect(primary.forces['reactionStart']).toBeCloseTo(1.35 * ((IPE300 * 6) / 2 + point / 2), 2);
    expect(data.warnings.filter((text) => text.includes('rests on no column or beam'))).toEqual([]);
  });

  it('warns about a beam end bearing on nothing', () => {
    let doc = twoLevels();
    doc = column(doc, 0, 0);
    doc = beam(doc, [0, 0], [6000, 0]);
    const data = check(doc);
    expect(data.warnings.some((text) => text.includes('SB1 end rests on no column or beam'))).toBe(
      true,
    );
  });

  it('flags circular beam framing and still analyses every beam', () => {
    // pinwheel: A ends on the interior of B, B on C, C on A
    let doc = twoLevels();
    doc = beam(doc, [0, 0], [3000, 0]);
    doc = beam(doc, [3000, 2000], [3000, -2000]);
    doc = beam(doc, [4500, -4000], [1500, 0]);
    const data = check(doc);
    expect(data.members.every((row) => row.analysed)).toBe(true);
    expect(data.warnings.some((text) => text.includes('circular beam framing'))).toBe(true);
  });
});

describe('bracing', () => {
  const braced = (): ReturnType<typeof twoLevels> => {
    let doc = squareBay();
    doc = brace(doc, [0, 0, 0], [6000, 0, 2820]);
    return brace(doc, [6000, 0, 0], [0, 0, 2820]);
  };

  it('carries φ × the factored storey load as a tension-only diagonal force', () => {
    const data = check(braced());
    const vertical = 1.35 * (4 * IPE300 * 6 + 36 * 0.5 + 4 * HEB200 * 3) + 1.5 * 36 * 5;
    const shear = 0.005 * vertical;
    expect(data.storeys[0]?.verticalLoad).toBeCloseTo(vertical, 2);
    expect(data.storeys[0]?.shear).toBeCloseTo(shear, 3);
    const length = Math.hypot(6000, 2820);
    for (const mark of ['BR1', 'BR2']) {
      const row = rowOf(data, mark);
      expect(row.forces['NEd']).toBeCloseTo((shear * length) / 6000, 2);
      expect(row.checks.map((entry) => entry.name)).not.toContain('flexural buckling (§6.3.1)');
      expect(row.check).toContain('slenderness');
    }
  });

  it('makes the chord beam of the braced bay a strut and flags the unbraced direction', () => {
    const data = check(braced());
    const chord = rowOf(data, 'SB1');
    expect(chord.checks.map((entry) => entry.name)).toContain(
      'strut compression + bending (§6.3.3)',
    );
    expect(chord.forces['NEd']).toBeGreaterThan(1);
    expect(rowOf(data, 'SB3').checks.map((entry) => entry.name)).not.toContain(
      'strut compression + bending (§6.3.3)',
    );
    expect(data.warnings.some((text) => text.includes('no bracing in direction Y'))).toBe(true);
  });

  it('shares the storey shear by the braced planes of a direction', () => {
    let doc = braced();
    doc = brace(doc, [0, 6000, 0], [6000, 6000, 2820]);
    doc = brace(doc, [6000, 6000, 0], [0, 6000, 2820]);
    const single = rowOf(check(braced()), 'BR1').forces['NEd'] ?? 0;
    const shared = rowOf(check(doc), 'BR1').forces['NEd'] ?? 0;
    expect(shared).toBeCloseTo(single / 2, 2);
  });

  it('also checks a single diagonal for buckling in compression', () => {
    let doc = squareBay();
    doc = brace(doc, [0, 0, 0], [6000, 0, 2820]);
    const row = rowOf(check(doc), 'BR1');
    expect(row.checks.map((entry) => entry.name)).toContain('flexural buckling (§6.3.1)');
  });
});

describe('selection and results', () => {
  it('lists every steel member and reports data.ok only when all pass', () => {
    const data = check(squareBay());
    expect(data.members).toHaveLength(8);
    expect(data.ok).toBe(true);
    expect(data.totals).toMatchObject({ members: 8, analysed: 8, notAnalysed: 0, failing: 0 });
    expect(data.loads).toHaveProperty('assumptions');
    const heavy = check(squareBay({ equipmentKg: 900000 }));
    expect(heavy.ok).toBe(false);
    expect(heavy.totals.failing).toBeGreaterThan(0);
    const result = checkSteelMembers.run(squareBay({ equipmentKg: 900000 }), {});
    expect(result.summary).toContain('failure(s)');
  });

  it('restricts the report to a level but analyses the whole model', () => {
    const doc = squareBay({ equipmentKg: 20000 });
    const all = check(doc);
    const onFloor = check(doc, { levelId: 'level-2' });
    expect(onFloor.members).toHaveLength(4);
    expect(onFloor.members.every((row) => row.role === 'beam')).toBe(true);
    const ground = check(doc, { levelId: 'level-1' });
    expect(ground.members).toHaveLength(4);
    expect(rowOf(ground, 'SC1').forces['NEd']).toBe(rowOf(all, 'SC1').forces['NEd']);
  });

  it('writes a CSV with one line per member', () => {
    const result = checkSteelMembers.run(squareBay(), {});
    const csv = (result.data as { csv: string }).csv;
    expect(csv.trim().split('\n')).toHaveLength(9);
    expect(csv.startsWith('Mark,Role,Profile')).toBe(true);
  });

  it('gives the same utilisation in a metre document', () => {
    let doc: CadDocument = { ...createEmptyDocument(), units: 'm' };
    doc = step(doc, 'add_level', { name: 'Floor', elevation: 3, height: 3, makeActive: false });
    for (const x of [0, 6]) {
      doc = step(doc, 'add_steel_member', {
        role: 'column',
        profile: 'HEB200',
        start: [x, 0, -3],
        end: [x, 0, 0],
        levelId: 'level-1',
      });
    }
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, -0.18],
      end: [6, 0, -0.18],
      levelId: 'level-1',
    });
    const row = rowOf(check(doc), 'SB1');
    expect(row.forces['MEd']).toBeCloseTo((1.35 * IPE300 * 36) / 8, 2);
    expect(rowOf(check(doc), 'SC1').analysed).toBe(true);
  });
});
