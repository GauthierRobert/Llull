import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { checkSteelMembers } from '@aec/industrial/steelMembersCheck';
import { checkBeam } from '@aec/industrial/steelBeamChecks';
import { createBeamLoads } from '@aec/industrial/steelBeamLoads';
import { collectSteelBars } from '@aec/industrial/steelMemberBars';
import { analyseSimpleBeam } from '@aec/industrial/steelBeamAnalysis';
import { analysedRow, skippedRow } from '@aec/industrial/steelMemberRows';
import {
  beam,
  brace,
  check,
  column,
  rowOf,
  squareBay,
  step,
  twoLevels,
  withMember,
} from './steelFixtures';

describe('check_steel_members failure paths', () => {
  const rejected = (params: Record<string, unknown>, doc = squareBay()): string => {
    const result = execute(doc, 'check_steel_members', params);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.data).toBeUndefined();
    return result.summary;
  };

  it('rejects an empty model', () => {
    expect(rejected({}, createEmptyDocument())).toContain('no steel members');
  });

  it('rejects negative loads, a bad notional factor and a bad deflection ratio', () => {
    expect(rejected({ imposedLoad: -1 })).toContain('must be numbers >= 0');
    expect(rejected({ cableTrayWeight: -5 })).toContain('must be numbers >= 0');
    expect(rejected({ notionalFactor: 0.5 })).toContain('notionalFactor');
    expect(rejected({ deflectionRatio: 0 })).toContain('deflectionRatio');
  });

  it('rejects an unknown level and a level without steel', () => {
    expect(rejected({ levelId: 'level-99' })).toContain("no level 'level-99'");
    const doc = step(squareBay(), 'add_level', {
      name: 'Roof',
      elevation: 9000,
      height: 3000,
      makeActive: false,
    });
    expect(rejected({ levelId: 'level-3' }, doc)).toContain('has no steel members');
  });
});

describe('members that cannot be analysed', () => {
  it('keeps every member in the report with the reason', () => {
    let doc = squareBay();
    doc = withMember(doc, 'SB2', { profile: 'FOO100' });
    doc = step(doc, 'add_steel_member', {
      role: 'rafter',
      profile: 'IPE300',
      start: [0, 0, 0],
      end: [6000, 0, 500],
      levelId: 'level-2',
    });
    doc = step(doc, 'add_steel_member', {
      role: 'purlin',
      profile: 'IPE200',
      start: [0, 0, 0],
      end: [6000, 0, 0],
      levelId: 'level-2',
    });
    const data = check(doc);
    expect(data.members).toHaveLength(10);
    expect(data.ok).toBe(false);
    expect(data.totals.notAnalysed).toBe(3);
    const unknown = rowOf(data, 'SB2');
    expect(unknown).toMatchObject({ analysed: false, ok: false, check: 'not analysed' });
    expect(unknown.detail).toContain('not in the steel catalogue');
    expect(rowOf(data, 'RF1').detail).toContain('check_portal_frames');
    expect(rowOf(data, 'PU1').detail).toContain('check_purlins');
    const result = checkSteelMembers.run(doc, {});
    expect(result.summary).toContain('not analysed: ');
  });

  it('refuses sloping beams, inclined columns, horizontal braces and zero-length members', () => {
    let doc = squareBay();
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 0],
      end: [2000, 0, 1000],
      levelId: 'level-2',
    });
    doc = step(doc, 'add_steel_member', {
      role: 'column',
      profile: 'HEB200',
      start: [0, 0, 0],
      end: [3000, 0, 1000],
      levelId: 'level-1',
    });
    doc = step(doc, 'add_steel_member', {
      role: 'brace',
      profile: 'CHS139.7x5',
      start: [0, 0, 100],
      end: [6000, 0, 100],
      levelId: 'level-1',
    });
    const data = check(doc);
    expect(rowOf(data, 'SB5').detail).toContain('slopes more than');
    expect(rowOf(data, 'SC5').detail).toContain('inclined');
    expect(rowOf(data, 'BR1').detail).toContain('horizontal brace');
    const zero = withMember(doc, 'SB1', { end: [0, 0, -180], start: [0, 0, -180] });
    expect(rowOf(check(zero), 'SB1').detail).toContain('length is zero');
  });

  it('skips shapes and classes the checks do not cover', () => {
    let doc = twoLevels();
    doc = step(doc, 'add_steel_member', {
      role: 'column',
      profile: 'IPE600',
      start: [0, 0, 0],
      end: [3000, 0, 0],
      levelId: 'level-1',
    });
    doc = step(doc, 'add_steel_member', {
      role: 'column',
      profile: 'IPE600',
      start: [1000, 0, 0],
      end: [1000, 0, 3000],
      levelId: 'level-1',
    });
    doc = step(doc, 'add_steel_member', {
      role: 'column',
      profile: 'L100x10',
      start: [2000, 0, 0],
      end: [2000, 0, 3000],
      levelId: 'level-1',
    });
    doc = beam(doc, [0, 4000], [6000, 4000], 'L100x10', 100);
    doc = beam(doc, [0, 5000], [6000, 5000], 'UPN200', 200);
    const data = check(doc);
    expect(rowOf(data, 'SC2').detail).toContain('class 4 in compression');
    expect(rowOf(data, 'SC3').detail).toContain('not covered');
    expect(rowOf(data, 'SB1').detail).toContain('as beams');
    expect(rowOf(data, 'SB2').detail).toContain('as beams');
  });

  it('uses the elastic modulus for a class 3 section', () => {
    let doc = twoLevels();
    doc = column(doc, 0, 0);
    doc = column(doc, 6000, 0);
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'HEB300',
      material: 'S460',
      start: [0, 0, -180],
      end: [6000, 0, -180],
      levelId: 'level-2',
    });
    const row = rowOf(check(doc), 'SB1');
    expect(row.checks[0]?.name).toContain('class 3');
  });
});

describe('bracing edge cases', () => {
  it('reports braces as not analysable when no floor beam gives a storey load', () => {
    let doc = twoLevels();
    doc = brace(doc, [0, 0, 0], [6000, 0, 3000]);
    const row = rowOf(check(doc), 'BR1');
    expect(row.analysed).toBe(false);
    expect(row.detail).toContain('no floor beams');
  });

  it('refuses a brace that is not in an X or Y plane', () => {
    let doc = squareBay();
    doc = brace(doc, [0, 0, 0], [3000, 3000, 2820]);
    const row = rowOf(check(doc), 'BR1');
    expect(row.detail).toContain('not in a vertical plane parallel to X or Y');
  });

  it('flags a single diagonal whose section cannot be verified in compression', () => {
    let doc = squareBay();
    doc = brace(doc, [0, 0, 0], [6000, 0, 2820], 'L100x10');
    expect(rowOf(check(doc), 'BR1').detail).toContain('single diagonal also acts in compression');
  });

  it('assigns a long Y-direction diagonal to its plane and reports storey shears', () => {
    let doc = squareBay();
    doc = brace(doc, [0, 0, 0], [0, 6000, 2820]);
    doc = brace(doc, [0, 6000, 0], [0, 0, 2820]);
    const data = check(doc, { notionalFactor: 0.01 });
    expect(rowOf(data, 'BR1').forces['panelShear']).toBeCloseTo(data.storeys[0]?.shear ?? 0, 2);
    expect(data.warnings.some((text) => text.includes('direction X'))).toBe(true);
  });
});

describe('beam check internals', () => {
  const lone = (): ReturnType<typeof twoLevels> =>
    beam(twoLevels(), [0, 0], [2000, 0], 'IPE200', 200);

  it('reduces the moment resistance when the shear exceeds half of Vpl,Rd', () => {
    const bar = collectSteelBars(lone()).find((entry) => entry.role === 'beam');
    if (!bar) throw new Error('beam');
    const loads = createBeamLoads(bar);
    loads.floorSupport = true;
    const span = loads.lengthM;
    const heavy = analyseSimpleBeam(span, [], [{ at: span / 2, permanent: 400, imposed: 0 }], {
      permanent: 1,
      imposed: 0,
    });
    const result = {
      loads,
      uls: heavy,
      sls: heavy,
      ends: [{ type: 'none' }, { type: 'none' }] as const,
    };
    const row = checkBeam(bar, result, 250, undefined);
    const bending = row.checks.find((entry) => entry.name.startsWith('bending'));
    const unreduced = checkBeam(
      bar,
      { ...result, uls: { ...heavy, shearAtMoment: 0 } },
      250,
      undefined,
    ).checks.find((entry) => entry.name.startsWith('bending'));
    expect(bending?.utilisation ?? 0).toBeGreaterThan((unreduced?.utilisation ?? 0) * 1.05);
  });

  it('reduces the moment of a hollow section by (1 − ρ) under high shear', () => {
    let doc = twoLevels();
    doc = beam(doc, [0, 0], [2000, 0], 'RHS200x100x6', 200);
    const bar = collectSteelBars(doc).find((entry) => entry.role === 'beam');
    if (!bar) throw new Error('beam');
    const loads = createBeamLoads(bar);
    const heavy = analyseSimpleBeam(loads.lengthM, [], [{ at: 1, permanent: 500, imposed: 0 }], {
      permanent: 1,
      imposed: 0,
    });
    const result = {
      loads,
      uls: heavy,
      sls: heavy,
      ends: [{ type: 'none' }, { type: 'none' }] as const,
    };
    const row = checkBeam(bar, result, 250, { force: 5, note: 'test strut' });
    expect(row.detail).toContain('reduced for V');
    expect(row.checks.map((entry) => entry.name)).toContain('strut compression + bending (§6.3.3)');
  });

  it('builds rows: the worst check governs and a row with no check is not analysed', () => {
    const bar = collectSteelBars(lone())[0];
    if (!bar) throw new Error('bar');
    const row = analysedRow(
      bar,
      [
        { name: 'a', utilisation: 0.4, combination: 'c1', detail: 'd1' },
        { name: 'b', utilisation: 1.2, combination: 'c2', detail: 'd2' },
      ],
      { MEd: 1.23456 },
    );
    expect(row).toMatchObject({ check: 'b', governing: 'c2', ok: false, utilisation: 1.2 });
    expect(row.forces['MEd']).toBe(1.235);
    expect(analysedRow(bar, []).analysed).toBe(false);
    expect(skippedRow(bar, 'why').detail).toBe('why');
  });
});
