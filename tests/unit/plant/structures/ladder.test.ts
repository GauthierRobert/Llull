/**
 * Plant 06 STA M4: add_ladder (VC-STA-01 rung counts, defaults named from the rule rows), the ladder rules of check_access (VC-STA-02 / 03),
 * the railing gate, back clearance, evaluation, takeoff, schedule, persistence, IFC and budgets. Hand numbers: spaces = ceil(H / 300),
 * rungs = spaces - 1, pitch = H / spaces (7300 mm: 25 spaces, 24 rungs, 292 mm); hoops from 2200 mm to the stile top (7300 + 1100 = 8400 mm)
 * at <= 1500 mm: ceil(6200 / 1500) = 5 spaces, 6 hoops.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { LadderElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { hoopHeightsOf } from '@aec/plant/structures/ladder/ladderLayout';
import { defaultFallProtection, defaultLandingsMm, pitchRange, planPitch } from '@aec/plant/structures/ladder/ladderDefaults';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { BOTH, gratedFrame, rect } from './accessFixtures';

interface Frame {
  doc: CadDocument;
  grade: string;
  top: string;
  deck: string;
}

/** Grade level 0 and a platform level at `height` with a 3000 x 2000 deck; the ladder base [1500, -250, 0] stands on grade. */
function frame(height = 7300): Frame {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: Math.max(height, 3000) });
  const grade = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_level', { name: 'Platform', elevation: height, height: 3000 });
  const top = Object.keys(doc.building?.levels ?? {}).find((id) => id !== grade) as string;
  const slab = ok(doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: top });
  return { doc: slab.document, grade, top, deck: slab.affected[0] as string };
}

const LADDER = { base: [1500, -250, 0], facing: [0, 1] };
const ladderOf = (doc: CadDocument, id = 'ladder-1'): LadderElement => {
  const element = doc.building?.elements[id];
  if (element?.category !== 'ladder') throw new Error(`no ladder ${id}`);
  return element;
};
const addTo = (f: Frame, extra: Record<string, unknown> = {}): CommandResult =>
  ok(f.doc, 'add_ladder', { ...LADDER, levelId: f.grade, ...extra });

interface Finding {
  code: string;
  ruleset: string;
  severity: string;
  remediation: string;
  measured: { value: number };
}
interface CheckData {
  findings: Finding[];
  verdict: string;
  reviewRequired: boolean;
  checked: { ladders: number };
  unverifiedRulesUsed: string[];
}
const checked = (doc: CadDocument, rulesets: string[] = BOTH): CheckData =>
  data<CheckData>(doc, 'check_access', { rulesets, include: ['ladders'] });
const codes = (findings: Finding[], ruleset?: string): string[] =>
  findings.filter((finding) => ruleset === undefined || finding.ruleset === ruleset).map((finding) => finding.code);

describe('add_ladder: VC-STA-01 rung count and pitch', () => {
  const rows: Array<[number, number, number]> = [
    [2800, 9, 280],
    [4500, 14, 300],
    [6000, 19, 300],
    [7300, 24, 292],
    [8000, 26, 296.2963],
    [9000, 29, 300],
  ];
  it.each(rows)('H = %i mm gives %i rungs at %f mm', (height, rungs, pitch) => {
    const result = addTo(frame(height), { climbHeight: height });
    const answer = result.data as { rungCount: number; rungPitchMm: number; arrivalSurfaceId: string };
    expect(answer.rungCount).toBe(rungs);
    expect(Math.abs(answer.rungPitchMm - pitch)).toBeLessThanOrEqual(1e-3);
    expect(ladderOf(result.document).rungCount).toBe(rungs);
    expect(answer.arrivalSurfaceId).toBe('slab-1');
  });

  it('creates one element, its entities and a deterministic id; names every default', () => {
    const f = frame();
    const result = addTo(f, { climbHeight: 7300, fallProtection: 'cage' });
    const answer = result.data as {
      defaults: string[];
      cage: { startHeightMm: number; hoopSpacingMm: number; diameterMm: number; bars: number };
    };
    expect(result.affected[0]).toBe('ladder-1');
    expect(result.affected.length).toBeGreaterThan(3);
    expect(result.document.building?.elements['ladder-1']?.mark).toBe('LD1');
    expect(answer.cage).toEqual({ startHeightMm: 2200, hoopSpacingMm: 1500, diameterMm: 650, bars: 5 });
    expect(answer.defaults.join(' | ')).toContain('rungPitchMax 300 mm (ISO-LAD-PITCH + OSHA-LAD-RUNG-PITCH)');
    expect(answer.defaults.join(' | ')).toContain('clearWidth 406.4 mm (OSHA-LAD-CLEAR-WIDTH)');
    expect(answer.defaults.join(' | ')).toContain('railExtension 1100 mm (ISO-LAD-STILE-EXT)');
    expect(answer.defaults.join(' | ')).toContain('installedOn unset');
    const entityIds = ladderOf(result.document).entityIds.map((id) => result.document.entities[id]?.name ?? id);
    expect(entityIds.length).toBe(4);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('places six hoops from 2200 mm to the stile top at <= 1500 mm', () => {
    const heights = hoopHeightsOf({ startHeight: 2200, hoopSpacing: 1500, diameter: 650, bars: 5 }, 8400);
    expect(heights).toHaveLength(6);
    expect(heights[0]).toBe(2200);
    expect(heights[5]).toBe(8400);
    expect(hoopHeightsOf({ startHeight: 9000, hoopSpacing: 1500, diameter: 650, bars: 5 }, 8400)).toEqual([]);
  });

  it('keeps an explicit rungPitch (rungs at k x pitch, a shorter last step)', () => {
    const f = frame(4000);
    const answer = addTo(f, { climbHeight: 4000, rungPitch: 320, fallProtection: 'none' }).data as {
      rungCount: number;
      rungPitchMm: number;
    };
    expect(answer).toMatchObject({ rungCount: 12, rungPitchMm: 320 });
  });

  it('takes the height from attachTo', () => {
    const f = frame(5000);
    const answer = addTo(f, { attachTo: f.deck, fallProtection: 'none' }).data as { rungCount: number; rungPitchMm: number };
    expect(answer.rungCount).toBe(16);
    expect(answer.rungPitchMm).toBeCloseTo(5000 / 17, 3);
  });

  it('is pure and replays to the same document', () => {
    const f = frame();
    expectPure(f.doc, () => execute(f.doc, 'add_ladder', { ...LADDER, levelId: f.grade, climbHeight: 7300 }));
    const built = addTo(f, { climbHeight: 7300 }).document;
    const replayed = execute(built, 'replay_history', {}).document;
    expect(replayed.building?.elements['ladder-1']).toEqual(built.building?.elements['ladder-1']);
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(built.entities).sort());
  });
});

describe('add_ladder: defaults from the rules', () => {
  it('picks fall protection by height, ruleset and installation date', () => {
    const both = pitchRange(['iso_14122', 'osha_1910']);
    expect([both.min, both.max]).toEqual([254, 300]);
    expect(defaultFallProtection(2800, undefined, ['iso_14122', 'osha_1910']).value).toBe('none');
    expect(defaultFallProtection(5000, undefined, ['iso_14122', 'osha_1910']).value).toBe('cage');
    expect(defaultFallProtection(7300, '2026-10-18', ['iso_14122', 'osha_1910']).value).toBe('cage');
    expect(defaultFallProtection(8000, '2026-10-18', ['iso_14122', 'osha_1910']).value).toBe('ladder_safety_system');
    expect(defaultFallProtection(8000, '2010-05-01', ['osha_1910']).value).toBe('cage');
    expect(defaultFallProtection(5000, undefined, ['osha_1910']).value).toBe('none');
  });

  it('generates landings from the OSHA intervals only', () => {
    expect(defaultLandingsMm(16000, 'cage', ['osha_1910'])).toEqual([8000]);
    expect(defaultLandingsMm(16000, 'cage', ['iso_14122'])).toEqual([]);
    expect(defaultLandingsMm(15000, 'cage', ['osha_1910'])).toEqual([]);
    expect(defaultLandingsMm(50000, 'pfas', ['osha_1910'])).toEqual([25000]);
    expect(defaultLandingsMm(20000, 'none', ['osha_1910'])).toEqual([]);
  });

  it('plans the pitch and refuses what no pitch can satisfy', () => {
    expect(planPitch(7300, 300, 254, 'x')).toEqual({ ok: true, spaces: 25, pitchMm: 292 });
    expect(planPitch(500, 300, 254, 'x').ok).toBe(false);
  });

  it('uses the defaults end to end: LSS at 8000 mm, a cage and no landing at 5000 mm', () => {
    const high = addTo(frame(8000), { climbHeight: 8000, installedOn: '2026-10-18' }).data as { fallProtection: string; cage: unknown };
    expect(high).toMatchObject({ fallProtection: 'ladder_safety_system', cage: null });
    const mid = addTo(frame(5000), { climbHeight: 5000 }).data as { fallProtection: string; cage: unknown };
    expect(mid.fallProtection).toBe('cage');
    expect(mid.cage).not.toBeNull();
  });

  it('generates a landing for a caged ladder above 15 240 mm and keeps explicit landings', () => {
    const f = frame(16000);
    const generated = addTo(f, { climbHeight: 16000, fallProtection: 'cage', installedOn: '2010-05-01' });
    expect((generated.data as { landingsMm: number[] }).landingsMm).toEqual([8000]);
    const none = addTo(f, { climbHeight: 16000, fallProtection: 'cage', installedOn: '2010-05-01', landings: [] });
    expect((none.data as { landingsMm: number[] }).landingsMm).toEqual([]);
  });
});

describe('add_ladder: coded refusals leave the document unchanged', () => {
  const f = frame();
  const base = { ...LADDER, levelId: f.grade, climbHeight: 7300 };
  it.each([
    ['no surface at the top', { ...base, climbHeight: 7000 }, 'STA_NO_ARRIVAL_SURFACE', 'climbHeight'],
    ['surface out of plan reach', { ...base, base: [1500, -1000, 0] }, 'STA_NO_ARRIVAL_SURFACE', 'base'],
    ['unknown attachTo', { ...LADDER, levelId: f.grade, attachTo: 'slab-9' }, 'STA_UNKNOWN_ELEMENT', 'attachTo'],
    [
      'attachTo below the base',
      { ...LADDER, base: [1500, -250, 8000], levelId: f.grade, attachTo: f.deck },
      'STA_NO_ARRIVAL_SURFACE',
      'attachTo',
    ],
    ['both height inputs', { ...base, attachTo: f.deck }, 'STA_INVALID_GEOMETRY', 'climbHeight'],
    ['neither height input', { ...LADDER, levelId: f.grade }, 'STA_INVALID_GEOMETRY', 'climbHeight'],
    ['both pitch inputs', { ...base, rungPitch: 300, rungPitchMax: 300 }, 'STA_INVALID_GEOMETRY', 'rungPitch'],
    ['zero facing', { ...base, facing: [0, 0] }, 'STA_INVALID_GEOMETRY', 'facing'],
    ['bad date', { ...base, installedOn: '18/11/2018' }, 'STA_INVALID_GEOMETRY', 'installedOn'],
    ['cage options without a cage', { ...base, fallProtection: 'pfas', cage: { bars: 4 } }, 'STA_INVALID_GEOMETRY', 'cage'],
    ['landings out of order', { ...base, landings: [5000, 3000] }, 'STA_INVALID_GEOMETRY', 'landings'],
    ['landing above the top', { ...base, landings: [7300] }, 'STA_INVALID_GEOMETRY', 'landings'],
    ['unit mistake (too many rungs)', { ...base, rungPitch: 5 }, 'STA_INVALID_GEOMETRY', 'rungPitch'],
    ['unknown level', { ...base, levelId: 'level-99' }, 'STA_INVALID_GEOMETRY', 'levelId'],
  ])('%s', (_, params, code, path) => {
    expectRefusal(f.doc, 'add_ladder', params, code, path);
  });

  it('refuses a pitch no ruleset allows with STA_LADDER_PITCH_INFEASIBLE', () => {
    const low = frame(500);
    expectRefusal(low.doc, 'add_ladder', { ...LADDER, levelId: low.grade, climbHeight: 500 }, 'STA_LADDER_PITCH_INFEASIBLE', 'climbHeight');
  });

  it('refuses the same ladder twice', () => {
    const once = addTo(f, { climbHeight: 7300 }).document;
    expectRefusal(once, 'add_ladder', base, 'STA_INVALID_GEOMETRY');
  });
});

describe('check_access: ladder rules (VC-STA-02, VC-STA-03)', () => {
  const f = frame(5000);
  const make = (extra: Record<string, unknown>, height = 5000, frameDoc: Frame = f): CadDocument =>
    addTo(frameDoc, { climbHeight: height, fallProtection: 'cage', ...extra }).document;

  it('passes a compliant ladder with both rulesets and always asks for review', () => {
    const result = checked(make({ installedOn: '2026-10-18' }));
    expect(result.checked.ladders).toBe(1);
    expect(result.reviewRequired).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
    expect(result.unverifiedRulesUsed).toEqual(expect.arrayContaining(['ISO-LAD-WIDTH', 'ISO-LAD-CAGE-HOOP', 'ISO-LAD-STILE-EXT']));
  });

  it('judges the pitch per ruleset', () => {
    const at = (rungPitch: number): CheckData => checked(make({ rungPitch }));
    expect(codes(at(320).findings, 'iso_14122')).toContain('STA_LADDER_PITCH_OUT_OF_RANGE');
    expect(codes(at(320).findings, 'osha_1910')).not.toContain('STA_LADDER_PITCH_OUT_OF_RANGE');
    expect(codes(at(240).findings, 'osha_1910')).toContain('STA_LADDER_PITCH_OUT_OF_RANGE');
    expect(codes(at(240).findings, 'iso_14122')).not.toContain('STA_LADDER_PITCH_OUT_OF_RANGE');
    expect(codes(at(292).findings)).not.toContain('STA_LADDER_PITCH_OUT_OF_RANGE');
  });

  it('judges width and rail extension; ISO rows are grade B and only warn', () => {
    const narrow = checked(make({ clearWidth: 400 }));
    expect(
      narrow.findings.filter((finding) => finding.code === 'STA_LADDER_WIDTH').map((finding) => [finding.ruleset, finding.severity]),
    ).toEqual([['osha_1910', 'fail']]);
    const low = checked(make({ railExtension: 1000 }));
    const extension = low.findings.filter((finding) => finding.code === 'STA_LADDER_RAIL_EXTENSION');
    expect(extension.map((finding) => [finding.ruleset, finding.severity]).sort()).toEqual([
      ['iso_14122', 'warn'],
      ['osha_1910', 'fail'],
    ]);
    expect(codes(low.findings)).toContain('STA_RULE_UNVERIFIED');
  });

  it('measures the back clearance from the objects behind the rungs', () => {
    const walled = apply(f.doc, 'draw_walls', {
      points: [
        [0, -70],
        [3000, -70],
      ],
      thickness: 20,
      height: 6000,
      levelId: f.grade,
    });
    const near = addTo({ ...f, doc: walled }, { climbHeight: 5000, fallProtection: 'cage' });
    const answer = near.data as { backClearanceMm: number };
    expect(answer.backClearanceMm).toBeCloseTo(170, 6);
    const finding = checked(near.document).findings.find((entry) => entry.code === 'STA_LADDER_BACK_CLEARANCE');
    expect(finding?.severity).toBe('fail');
    expect(finding?.ruleset).toBe('osha_1910');
    expect(finding?.measured.value).toBeCloseTo(170, 6);
    const clear = addTo(f, { climbHeight: 5000, fallProtection: 'cage' }).data as { backClearanceMm: number };
    expect(clear.backClearanceMm).toBe(2000);
  });

  it('requires fall protection from 3000 mm (ISO) and above 24 ft (OSHA)', () => {
    const none5000 = checked(make({ fallProtection: 'none' }));
    expect(
      none5000.findings.filter((finding) => finding.code === 'STA_LADDER_FALL_PROTECTION_MISSING').map((finding) => finding.ruleset),
    ).toEqual(['iso_14122']);
    const short = frame(2800);
    expect(codes(checked(make({ fallProtection: 'none' }, 2800, short)).findings)).not.toContain('STA_LADDER_FALL_PROTECTION_MISSING');
    const tall = frame(8000);
    const bare = checked(make({ fallProtection: 'none' }, 8000, tall));
    expect(codes(bare.findings, 'osha_1910')).toContain('STA_LADDER_FALL_PROTECTION_MISSING');
    expect(codes(checked(make({ fallProtection: 'none' }, 8000, tall), ['osha_1910']).findings)).toEqual([
      'STA_LADDER_FALL_PROTECTION_MISSING',
    ]);
  });

  it('refuses a cage alone above 24 ft for a ladder installed from 2018-11-19, warns for an older one, passes LSS', () => {
    const tall = frame(8000);
    const fresh = checked(make({ installedOn: '2026-10-18' }, 8000, tall), ['osha_1910']);
    expect(fresh.findings.find((finding) => finding.code === 'STA_LADDER_CAGE_NOT_PRIMARY')?.severity).toBe('fail');
    expect(fresh.verdict).toBe('fail');
    const unknown = checked(make({}, 8000, tall), ['osha_1910']);
    expect(codes(unknown.findings)).toContain('STA_LADDER_CAGE_NOT_PRIMARY');
    const old = checked(make({ installedOn: '2010-05-01', landings: [4000] }, 8000, tall), ['osha_1910']);
    const retrofit = old.findings.find((finding) => finding.code === 'STA_LADDER_CAGE_RETROFIT');
    expect(retrofit?.severity).toBe('warn');
    expect(retrofit?.remediation).toContain('2036-11-18');
    expect(old.verdict).toBe('warn');
    const system = checked(make({ fallProtection: 'ladder_safety_system', installedOn: '2026-10-18' }, 8000, tall), ['osha_1910']);
    expect(system.findings).toEqual([]);
    expect(system.verdict).toBe('pass');
    const at7300 = frame(7300);
    expect(codes(checked(make({ installedOn: '2026-10-18' }, 7300, at7300), ['osha_1910']).findings)).toEqual([]);
  });

  it('checks the cage start band and the grade B hoop spacing and diameter', () => {
    const late = checked(make({ cage: { startHeight: 3200 } }));
    expect(late.findings.find((finding) => finding.code === 'STA_LADDER_CAGE_START')?.severity).toBe('fail');
    expect(codes(checked(make({ cage: { startHeight: 2500 } })).findings)).not.toContain('STA_LADDER_CAGE_START');
    const loose = checked(make({ cage: { hoopSpacing: 1800, diameter: 600 } }));
    const geometry = loose.findings.filter((finding) => finding.code === 'STA_LADDER_CAGE_GEOMETRY');
    expect(geometry).toHaveLength(2);
    expect(geometry.every((finding) => finding.severity === 'warn')).toBe(true);
    expect(codes(checked(make({ cage: { startHeight: 3200 } }), ['osha_1910']).findings)).not.toContain('STA_LADDER_CAGE_START');
  });

  it('checks the landing interval: caged 16 000 mm without a landing fails, LSS rests are grade B', () => {
    const tall = frame(16000);
    const caged = checked(make({ installedOn: '2010-05-01', landings: [] }, 16000, tall), ['osha_1910']);
    expect(caged.findings.find((finding) => finding.code === 'STA_LADDER_LANDING_INTERVAL')?.severity).toBe('fail');
    const landed = checked(make({ installedOn: '2010-05-01' }, 16000, tall), ['osha_1910']);
    expect(codes(landed.findings)).not.toContain('STA_LADDER_LANDING_INTERVAL');
    const huge = frame(50000);
    const system = checked(make({ fallProtection: 'pfas', landings: [] }, 50000, huge), ['osha_1910']);
    expect(system.findings.find((finding) => finding.code === 'STA_LADDER_LANDING_INTERVAL')?.severity).toBe('warn');
    expect(system.unverifiedRulesUsed).toContain('OSHA-LAD-LSS-REST');
  });

  it('gives a remediation for every finding and checks only the ids it is given', () => {
    const doc = make({ rungPitch: 320, clearWidth: 400, railExtension: 1000, fallProtection: 'none' });
    const all = checked(doc);
    expect(all.findings.length).toBeGreaterThan(4);
    expect(all.findings.every((finding) => finding.remediation.length > 0)).toBe(true);
    const one = data<{ checked: { ladders: number }; byId: Record<string, unknown> }>(doc, 'check_access', {
      rulesets: BOTH,
      ids: ['ladder-1'],
      include: ['ladders'],
    });
    expect(one.checked.ladders).toBe(1);
    expect(Object.keys(one.byId)).toEqual(['ladder-1']);
    expect(data<{ checked: { ladders: number } }>(doc, 'check_access', { rulesets: BOTH, include: ['stairs'] }).checked.ladders).toBe(0);
  });
});

describe('add_ladder: railing gate', () => {
  const f = frame(5000);
  const railed = (path: number[][], extra: Record<string, unknown> = {}): CadDocument =>
    apply(f.doc, 'add_railing', { path, levelId: f.top, ...extra });
  const params = { ...LADDER, levelId: f.grade, climbHeight: 5000, fallProtection: 'none' };

  it('cuts a gap with a gate where the ladder meets the guard-rail', () => {
    const doc = railed([
      [0, 0, 0],
      [3000, 0, 0],
    ]);
    const result = ok(doc, 'add_ladder', params);
    const gate = (result.data as { gate: { status: string; railingId: string } }).gate;
    expect(gate).toMatchObject({ status: 'cut', railingId: 'railing-1' });
    const railing = result.document.building?.elements['railing-1'];
    const opening = railing?.category === 'railing' ? railing.openings[0] : undefined;
    expect(opening?.gate).toBe(true);
    expect(((opening?.from ?? 0) + (opening?.to ?? 0)) / 2).toBeCloseTo(1500, 6);
    expect((opening?.to ?? 0) - (opening?.from ?? 0)).toBeCloseTo(406.4 + 20 + 48.3, 6);
    expect(result.affected).toContain('railing-1');
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('reports an existing gate, and a gap that does not fit, and cuts nothing for side_step or without a railing', () => {
    const cut = ok(
      railed([
        [0, 0, 0],
        [3000, 0, 0],
      ]),
      'add_ladder',
      params,
    ).document;
    const again = ok(cut, 'add_ladder', { ...params, base: [1550, -250, 0] });
    expect((again.data as { gate: { status: string } }).gate.status).toBe('existing');
    const tight = ok(
      railed([
        [1400, 0, 0],
        [1600, 0, 0],
      ]),
      'add_ladder',
      params,
    );
    expect((tight.data as { gate: { status: string; reason: string } }).gate.status).toBe('skipped');
    expect((tight.data as { gate: { reason: string } }).gate.reason).toContain('does not fit');
    const open = ok(
      railed(
        [
          [0, 0, 0],
          [3000, 0, 0],
        ],
        { openings: [{ from: 1000, to: 2000 }] },
      ),
      'add_ladder',
      params,
    );
    expect((open.data as { gate: { status: string } }).gate.status).toBe('skipped');
    const stepped = ok(
      railed([
        [0, 0, 0],
        [3000, 0, 0],
      ]),
      'add_ladder',
      { ...params, exit: 'side_step' },
    );
    expect((stepped.data as { gate: { status: string } }).gate.status).toBe('none');
    expect((ok(f.doc, 'add_ladder', params).data as { gate: { status: string } }).gate.status).toBe('none');
  });

  it('ignores a railing on another surface level or far away', () => {
    const far = railed([
      [0, 1900, 0],
      [3000, 1900, 0],
    ]);
    expect((ok(far, 'add_ladder', params).data as { gate: { status: string } }).gate.status).toBe('none');
  });
});

describe('ladder evaluation, takeoff, schedule, persistence, IFC', () => {
  const f = frame(7300);
  const built = addTo(f, { climbHeight: 7300, fallProtection: 'cage', installedOn: '2026-10-18' }).document;

  it('derives stiles, rungs, hoops, bars on layer S-LADR', () => {
    const element = ladderOf(built);
    expect(element.entityIds).toHaveLength(4);
    for (const id of element.entityIds) {
      const entity = built.entities[id];
      expect(entity?.kind).toBe('mesh');
      expect(entity?.layerId).toBe('layer-S-LADR');
    }
  });

  it('adds a landing entity for a ladder with a landing', () => {
    const tall = frame(16000);
    const doc = addTo(tall, { climbHeight: 16000, fallProtection: 'cage', installedOn: '2010-05-01' }).document;
    expect(ladderOf(doc).entityIds).toHaveLength(5);
  });

  it('lists ladder lines in quantity_takeoff and a ladder schedule', () => {
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(built, 'quantity_takeoff', {}).lines;
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line.quantity]));
    expect(byKey['ladder.rung.ea']).toBe(24);
    expect(byKey['ladder.cage.m']).toBeCloseTo(6.2, 6);
    expect(byKey['ladder.steel.kg']).toBeGreaterThan(100);
    const schedule = data<{ rows: Array<Array<string | number>> }>(built, 'building_schedule', { kind: 'ladder' });
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0]?.slice(0, 3)).toEqual(['LD1', 7300, 24]);
  });

  it('validates a loaded ladder', () => {
    expect(buildingErrors(built.building)).toEqual([]);
    const damage = (edit: (element: Record<string, unknown>) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(built.building)) as { elements: Record<string, Record<string, unknown>> };
      edit(copy.elements['ladder-1'] as Record<string, unknown>);
      return buildingErrors(copy);
    };
    expect(damage((element) => (element['exit'] = 'up')).join()).toContain('exit');
    expect(damage((element) => (element['fallProtection'] = 'rope')).join()).toContain('fallProtection');
    expect(damage((element) => (element['landings'] = 'x')).join()).toContain('landings');
    expect(damage((element) => delete element['cage']).join()).toContain('cage data');
    expect(damage((element) => (element['cage'] = { startHeight: 1 })).join()).toContain('cage must be');
    expect(damage((element) => (element['base'] = [1, 2])).join()).toContain('base');
    expect(damage((element) => (element['installedOn'] = 3)).join()).toContain('installedOn');
    expect(damage((element) => (element['rungPitch'] = -1)).length).toBeGreaterThan(0);
  });

  it('moves with move_building_element', () => {
    const moved = apply(built, 'move_building_element', { elementIds: ['ladder-1'], delta: [100, 50] });
    expect(ladderOf(moved).base).toEqual([1600, -200, 0]);
  });

  it('exports IfcStair LADDER aggregating stiles, rungs and landings', () => {
    const ifc = data<{ ifc: string }>(built, 'export_ifc', {}).ifc;
    expect(ifc.match(/=IFCSTAIR\([^\n]*\.LADDER\.\);/g)).toHaveLength(1);
    expect(ifc.match(/=IFCMEMBER\([^\n]*\.STRINGER\.\);/g)).toHaveLength(2);
    expect(ifc.match(/=IFCMEMBER\([^\n]*'RUNG'[^\n]*\.MEMBER\.\);/g)).toHaveLength(24);
    expect(ifc).toContain("'Pset_llullLadder'");
    expect(ifc).toContain("IFCRECTANGLEPROFILEDEF(.AREA.,'FL70x10'");
    expect(ifc).toContain("IFCCIRCLEPROFILEDEF(.AREA.,'RD20'");
    const tall = frame(16000);
    const landed = addTo(tall, { climbHeight: 16000, fallProtection: 'cage', installedOn: '2010-05-01' }).document;
    expect(data<{ ifc: string }>(landed, 'export_ifc', {}).ifc).toMatch(/=IFCSLAB\([^\n]*\.LANDING\.\);/);
  });

  it('stays within generous time budgets', () => {
    const started = performance.now();
    const doc = addTo(frame(16000), { climbHeight: 16000, fallProtection: 'cage', installedOn: '2010-05-01' }).document;
    checked(doc);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('add_ladder: arrival on a grating panel', () => {
  it('arrives on the nearest grating whose top is at the climb height', () => {
    const { doc, ids } = gratedFrame();
    const level = Object.keys(doc.building?.levels ?? {})[0] as string;
    const result = ok(doc, 'add_ladder', { base: [300, -250, -3000], facing: [0, 1], climbHeight: 3000, levelId: level });
    expect((result.data as { arrivalSurfaceId: string }).arrivalSurfaceId).toBe(ids[0]);
    const attached = ok(doc, 'add_ladder', { base: [300, -250, -3000], facing: [0, 1], attachTo: ids[0], levelId: level });
    expect((attached.data as { rungCount: number }).rungCount).toBe(9);
  });
});
