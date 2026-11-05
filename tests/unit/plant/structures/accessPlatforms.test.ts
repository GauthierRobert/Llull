/**
 * Plant 06 STA M8: the platform rules of check_access (width ISO-PLT-WIDTH 600 mm, headroom ISO-PLT-HEADROOM 2100 mm, route to grade through the access
 * graph, several independent routes on request) and the valve targets of check_reachability (02 RTE handwheel = valve centre + stem x stem height).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { rect, TYPE } from './accessFixtures';
import { addTie, cs150Line } from '../piping/rteFixtures';
import { operatorsDocument } from '../piping/smallBoreFixtures';

interface Finding {
  code: string;
  ruleId: string;
  ruleset: string;
  severity: string;
  ids: string[];
  measured: { value: number; unit: string };
  limit: { min?: number; max?: number };
  source: string;
}
interface Checked {
  verdict: string;
  findings: Finding[];
  platforms: Array<{ assemblyId: string; widthMm: number | null; headroomMm: number | null; routes: number | null }>;
  checked: { platforms: number };
  notEvaluated: Array<{ ruleId: string; reason: string }>;
}

const ISO = ['iso_14122'];
const check = (doc: CadDocument, extra: Record<string, unknown> = {}): Checked =>
  data<Checked>(doc, 'check_access', { rulesets: ISO, include: ['platforms'], ...extra });

/** Grade and a 6000 x `depth` deck at +3000 (bars along x), ladders optional. */
function deck(depth = 3000): CadDocument {
  let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  doc = apply(doc, 'add_level', { name: '+6000', elevation: 6000, height: 3000 });
  return apply(doc, 'add_access_platform', {
    bounds: [
      [0, 0],
      [6000, depth],
    ],
    topOffset: 3000,
    gratingType: TYPE,
    bearingBarDirection: [1, 0],
    levelId: 'level-1',
  });
}
const ladderAt = (doc: CadDocument, x: number): CadDocument =>
  apply(doc, 'add_ladder', { base: [x, -250, 0], facing: [0, 1], attachTo: 'assembly-1', levelId: 'level-1' });

describe('check_access: platform egress (STA_ACCESS_NO_EGRESS)', () => {
  it('a platform no ladder or stair reaches fails; a ladder from grade clears it', () => {
    const alone = check(deck());
    expect(alone.findings).toEqual([
      expect.objectContaining({
        code: 'STA_ACCESS_NO_EGRESS',
        ruleset: 'project',
        severity: 'fail',
        ids: ['assembly-1'],
        measured: { value: 0, unit: 'routes to grade' },
        limit: { min: 1, unit: 'routes to grade' },
      }),
    ]);
    expect(alone.verdict).toBe('fail');
    expect(alone.platforms).toEqual([
      { assemblyId: 'assembly-1', widthMm: 3000, headroomMm: null, routes: 0, gradeLevelId: 'level-1', gradeElevationMm: 0 },
    ]);
    const reached = check(ladderAt(deck(), 3000));
    expect(reached.findings).toEqual([]);
    expect(reached.verdict).toBe('pass');
    expect(reached.platforms[0]?.routes).toBe(1);
  });

  it('egressRoutesRequired: 2 asks for a second independent route and echoes its source', () => {
    const one = ladderAt(deck(), 1000);
    const asked = check(one, { egressRoutesRequired: 2, egressSource: 'fire plan FP-2, clause 4' });
    expect(asked.findings).toEqual([
      expect.objectContaining({
        code: 'STA_ACCESS_NO_EGRESS',
        measured: { value: 1, unit: 'routes to grade' },
        limit: { min: 2, unit: 'routes to grade' },
        source: 'fire plan FP-2, clause 4',
      }),
    ]);
    expect(check(one, { egressRoutesRequired: 2 }).findings[0]?.source).toBe('caller');
    const two = ladderAt(one, 5000);
    expect(check(two, { egressRoutesRequired: 2, egressSource: 'fire plan FP-2, clause 4' }).findings).toEqual([]);
    expect(check(two, { egressRoutesRequired: 3 }).findings[0]?.measured.value).toBe(2);
  });

  it('reports an omitted egressRoutesRequired (1 route) in data.defaulted and the summary (INT-14)', () => {
    const omitted = execute(ladderAt(deck(), 3000), 'check_access', { rulesets: ISO, include: ['platforms'] });
    expect((omitted.data as { defaulted: unknown }).defaulted).toEqual([{ input: 'egressRoutesRequired', value: 1 }]);
    expect(omitted.summary).toContain('egressRoutesRequired 1 (defaulted)');
    const given = execute(ladderAt(deck(), 3000), 'check_access', { rulesets: ISO, include: ['platforms'], egressRoutesRequired: 1 });
    expect((given.data as { defaulted: unknown }).defaulted).toEqual([]);
    expect(given.summary).not.toContain('(defaulted)');
  });

  it('a ladder and a steel stair count as two routes', () => {
    const withLadder = ladderAt(deck(), 1000);
    const withStair = apply(withLadder, 'add_steel_stair', {
      start: [-4480, 1500, 0],
      angle: 0,
      toSurfaceId: 'assembly-1',
      riserMax: 180,
      going: 280,
      levelId: 'level-1',
    });
    expect(check(withStair, { egressRoutesRequired: 2 }).findings).toEqual([]);
  });

  it('rejects an egressRoutesRequired outside 1..4 as invalid params', () => {
    for (const bad of [0, 5, 1.5])
      expect(execute(deck(), 'check_access', { rulesets: ISO, egressRoutesRequired: bad }).summary).toContain('invalid params');
  });

  it('the check runs for the default include (all five) and for ids that name a part of the platform', () => {
    const doc = deck();
    const all = data<Checked>(doc, 'check_access', { rulesets: ISO, edgeDropThresholdMm: 500 });
    expect(all.findings.map((finding) => finding.code)).toContain('STA_ACCESS_NO_EGRESS');
    expect(all.checked.platforms).toBe(1);
    const part = data<Checked>(doc, 'check_access', { rulesets: ISO, ids: ['grating-1'], include: ['platforms'] });
    expect(part.checked.platforms).toBe(1);
    expect(data<Checked>(doc, 'check_access', { rulesets: ISO, include: ['edges'], edgeDropThresholdMm: 500 }).checked.platforms).toBe(0);
  });

  it('is read-only and pure', () => {
    const doc = deck();
    expectPure(doc, () => execute(doc, 'check_access', { rulesets: ISO }));
  });

  it('a platform in a model without a level cannot be judged: warn STA_NO_GRADE, never a pass', () => {
    const doc = deck();
    const levels = { ...doc.building, levels: {} } as NonNullable<CadDocument['building']>;
    const orphan = check({ ...doc, building: levels });
    expect(orphan.findings.map((finding) => [finding.code, finding.severity])).toContainEqual(['STA_NO_GRADE', 'warn']);
    expect(orphan.verdict).not.toBe('pass');
  });
});

describe('check_access: scope of the platform rules and the grade', () => {
  it('osha_1910 alone judges neither width nor headroom and says so under notEvaluated', () => {
    const osha = check(ladderAt(deck(500), 3000), { rulesets: ['osha_1910'] });
    expect(osha.findings).toEqual([]);
    const entries = osha.notEvaluated.filter((entry) => entry.reason.includes('judged only under iso_14122'));
    expect(entries.map((entry) => entry.ruleId)).toEqual(['ISO-PLT-WIDTH', 'ISO-PLT-HEADROOM']);
    expect(check(ladderAt(deck(500), 3000)).notEvaluated.some((entry) => entry.reason.includes('judged only under iso_14122'))).toBe(false);
  });

  it('grade is the lowest level: a basement is grade, reported by level id and elevation', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Ground',
      elevation: 0,
      height: 4000,
    });
    doc = apply(doc, 'add_level', { name: 'Basement', elevation: -3000, height: 3000 });
    doc = apply(doc, 'add_access_platform', {
      bounds: [
        [0, 0],
        [6000, 3000],
      ],
      topOffset: 3000,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      levelId: 'level-1',
    });
    const graph = data<{ gradeLevelId: string; gradeElevationMm: number }>(doc, 'access_graph', {});
    expect(graph).toMatchObject({ gradeLevelId: 'level-2', gradeElevationMm: -3000 });
    expect(check(doc).platforms[0]).toMatchObject({ gradeLevelId: 'level-2', gradeElevationMm: -3000, routes: 0 });
  });
});

describe('check_access: platform width (STA_PLATFORM_WIDTH, ISO-PLT-WIDTH 600 mm)', () => {
  it('a 500 mm deck fails, 600 mm is the limit, 1000 mm passes; OSHA alone has no such row', () => {
    const narrow = check(ladderAt(deck(500), 3000));
    expect(narrow.findings).toEqual([
      expect.objectContaining({
        code: 'STA_PLATFORM_WIDTH',
        ruleId: 'ISO-PLT-WIDTH',
        severity: 'fail',
        measured: { value: 500, unit: 'mm' },
        limit: expect.objectContaining({ min: 600 }),
      }),
    ]);
    expect(check(ladderAt(deck(600), 3000)).findings).toEqual([]);
    expect(check(ladderAt(deck(1000), 3000)).findings).toEqual([]);
    expect(check(ladderAt(deck(500), 3000), { rulesets: ['osha_1910'] }).findings).toEqual([]);
  });

  it('a circular platform is judged on its radial width', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
    doc = apply(doc, 'add_equipment', {
      name: 'Column',
      mark: 'C-101',
      location: [0, 0],
      size: [3000, 3000, 18000],
      shape: 'vertical_vessel',
    });
    const narrow = apply(doc, 'add_circular_access_platform', {
      equipmentId: 'equipment-1',
      elevation: 6000,
      startAngleDeg: 0,
      sweepDeg: 180,
      gap: 150,
      width: 500,
    });
    expect(check(narrow).findings.map((finding) => [finding.code, finding.measured.value])).toContainEqual(['STA_PLATFORM_WIDTH', 500]);
    expect(check(narrow).platforms[0]?.widthMm).toBe(500);
  });

  it('a hand-edited platform whose stored parameters do not parse is a STA_INVALID_GEOMETRY failure, not a pass', () => {
    const doc = ladderAt(deck(), 3000);
    const broken = JSON.parse(JSON.stringify(doc)) as CadDocument;
    (broken.building?.elements['assembly-1'] as { params: Record<string, unknown> }).params = { kind: 'platform' };
    const answer = check(broken);
    expect(answer.findings.map((finding) => [finding.code, finding.severity])).toContainEqual(['STA_INVALID_GEOMETRY', 'fail']);
    expect(answer.platforms[0]?.widthMm).toBeNull();
  });
});

describe('check_access: platform headroom (STA_PLATFORM_HEADROOM, ISO-PLT-HEADROOM 2100 mm)', () => {
  const reached = (): CadDocument => ladderAt(deck(), 3000);

  it('a slab 1800 mm over the deck fails with the measured clearance; one 2600 mm over passes', () => {
    const base = reached();
    const low = ok(base, 'add_slab', { boundary: rect(0, 0, 6000, 3000), thickness: 200, levelId: 'level-2', offset: -1200 });
    const failing = check(low.document);
    // slab top 6000 - 1200 = 4800, underside 4600 over a deck at 3000: 1600 mm.
    expect(failing.findings).toEqual([
      expect.objectContaining({
        code: 'STA_PLATFORM_HEADROOM',
        severity: 'fail',
        measured: { value: 1600, unit: 'mm' },
        limit: expect.objectContaining({ min: 2100 }),
      }),
    ]);
    expect(failing.platforms[0]?.headroomMm).toBe(1600);
    const high = ok(base, 'add_slab', { boundary: rect(0, 0, 6000, 3000), thickness: 200, levelId: 'level-2', offset: -200 });
    const passing = check(high.document);
    expect(passing.findings).toEqual([]);
    expect(passing.platforms[0]?.headroomMm).toBe(2600);
  });

  it('steel overhead counts by its underside; a column that stands through the deck is not headroom; a surface elsewhere in plan does not count', () => {
    const base = reached();
    const beam = apply(base, 'add_steel_member', {
      role: 'beam',
      start: [1000, 0, 4000],
      end: [1000, 3000, 4000],
      profile: 'IPE200',
      levelId: 'level-1',
    });
    expect(check(beam).platforms[0]?.headroomMm).toBe(900);
    expect(check(beam).findings.map((finding) => finding.code)).toEqual(['STA_PLATFORM_HEADROOM']);
    const column = apply(base, 'add_column', { location: [3000, 1500], width: 300, depth: 300, height: 8000, levelId: 'level-1' });
    expect(check(column).platforms[0]?.headroomMm).toBeNull();
    const aside = ok(base, 'add_slab', { boundary: rect(8000, 0, 9000, 1000), thickness: 200, levelId: 'level-2', offset: -1200 });
    expect(check(aside.document).platforms[0]?.headroomMm).toBeNull();
  });

  it('names in notEvaluated what is not an obstruction (pipes, trays, ducts, ladders and stairs) and skips headroom for osha alone', () => {
    const answer = check(reached());
    expect(answer.notEvaluated.map((entry) => entry.ruleId)).toContain('ISO-PLT-HEADROOM');
    const beam = apply(reached(), 'add_steel_member', {
      role: 'beam',
      start: [1000, 0, 4000],
      end: [1000, 3000, 4000],
      profile: 'IPE200',
      levelId: 'level-1',
    });
    expect(check(beam, { rulesets: ['osha_1910'] }).findings).toEqual([]);
  });

  it('a second platform above the first is an obstruction through its grating underside', () => {
    const lower = reached();
    const upper = apply(lower, 'add_access_platform', {
      bounds: [
        [0, 0],
        [6000, 3000],
      ],
      topOffset: 4500,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      levelId: 'level-1',
    });
    // the upper deck's IPE200 beams (top of steel at the grating underside 4468.25) hang 200 mm lower: bottom 4268.25, 1268.25 mm over the first deck.
    expect(check(upper, { ids: ['assembly-1'] }).platforms[0]?.headroomMm).toBeCloseTo(1268.25, 3);
  });
});

describe('check_reachability: valve targets from the routed piping (02 RTE)', () => {
  /** DN100 line at z 0 between two tie-ins, a gate valve with tag HV-1 at the middle; the stub catalogue gives it a 650 mm stem. */
  function valved(): CadDocument {
    let doc = operatorsDocument();
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '7001', spec: 'CS150OP', dn: 100 });
    const lineId = doc.plant?.piping?.lineOrder[0] as string;
    doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [1, 0, 0], dn: 100, endType: 'BW' });
    doc = apply(doc, 'add_tie_in_point', { tag: 'B', position: [6000, 0, 0], direction: [-1, 0, 0], dn: 100, endType: 'BW' });
    const [a, b] = doc.plant?.piping?.tieInOrder as [string, string];
    const routed = ok(doc, 'route_pipe', { lineId, from: { portId: a }, to: { portId: b } });
    const runId = (routed.data as { runId: string }).runId;
    doc = apply(routed.document, 'insert_inline_component', {
      runId,
      type: 'valveGate',
      tag: 'HV-1',
      at: { leg: 0, centreDistance: 3000 },
    });
    return apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  }
  const BAND = { min: 0, max: 1800, source: 'project rule' };

  it('the handwheel centre (valve centre + stem x stem height = [3000, 0, 650]) is operated from grade 650 mm above it', () => {
    const answer = data<{
      targets: Array<{ tag: string; kind: string; pointMm: number[]; ok: boolean; surfaceId: string; heightAboveSurfaceMm: number }>;
    }>(valved(), 'check_reachability', { targetsFrom: ['valves'], operatingHeightMm: BAND, maxHorizontalReachMm: 600 });
    expect(answer.targets).toEqual([
      expect.objectContaining({
        tag: 'HV-1',
        kind: 'valve_handwheel',
        pointMm: [3000, 0, 650],
        ok: true,
        surfaceId: 'grade',
        heightAboveSurfaceMm: 650,
      }),
    ]);
  });

  it('a band below the handwheel height fails it with STA_OPERATING_HEIGHT (650 > 500)', () => {
    const answer = data<{ targets: Array<{ findings: Array<{ code: string }> }> }>(valved(), 'check_reachability', {
      targetsFrom: ['valves'],
      operatingHeightMm: { ...BAND, max: 500 },
      maxHorizontalReachMm: 600,
    });
    expect(answer.targets[0]?.findings.map((finding) => finding.code)).toEqual(['STA_OPERATING_HEIGHT']);
  });

  it('explicit targets and valves mix; a tag used twice (explicit and valve) is refused', () => {
    const doc = valved();
    const mixed = data<{ targets: Array<{ tag: string }> }>(doc, 'check_reachability', {
      targets: [{ tag: 'PI-1', kind: 'instrument', point: [0, 0, 1200] }],
      targetsFrom: ['valves'],
      operatingHeightMm: BAND,
      maxHorizontalReachMm: 0,
    });
    expect(mixed.targets.map((target) => target.tag)).toEqual(['PI-1', 'HV-1']);
    expectRefusal(
      doc,
      'check_reachability',
      {
        targets: [{ tag: 'HV-1', kind: 'x', point: [0, 0, 0] }],
        targetsFrom: ['valves'],
        operatingHeightMm: BAND,
        maxHorizontalReachMm: 0,
      },
      'STA_TARGET_DUPLICATE',
    );
  });

  it('two valves with one tag are refused naming both inline ids', () => {
    const doc = valved();
    const runId = Object.keys(doc.plant?.piping?.runs ?? {})[0] as string;
    const twice = apply(doc, 'insert_inline_component', { runId, type: 'valveGate', tag: 'HV-1', at: { leg: 0, centreDistance: 1500 } });
    const result = expectRefusal(
      twice,
      'check_reachability',
      { targetsFrom: ['valves'], operatingHeightMm: BAND, maxHorizontalReachMm: 600 },
      'STA_TARGET_DUPLICATE',
    );
    expect(result.summary).toContain('HV-1 (valve-');
    expect(result.summary.match(/valve-/g)).toHaveLength(2);
    const mixed = expectRefusal(
      doc,
      'check_reachability',
      {
        targets: [{ tag: 'HV-1', kind: 'x', point: [0, 0, 0] }],
        targetsFrom: ['valves'],
        operatingHeightMm: BAND,
        maxHorizontalReachMm: 600,
      },
      'STA_TARGET_DUPLICATE',
    );
    expect(mixed.summary).toContain('HV-1 (explicit, valve-');
  });

  it('a valve whose catalogue row has no stem height cannot be placed: STA_TARGET_UNLOCATED (warn, never a pass)', () => {
    const line = cs150Line(100, '1001');
    const first = addTie(line.doc, 'TP-1', [0, 0, 0], [1, 0, 0], { dn: 100 });
    const tied = addTie(first.doc, 'TP-2', [6000, 0, 0], [-1, 0, 0], { dn: 100 });
    const routed = ok(tied.doc, 'route_pipe', { lineId: line.lineId, from: { portId: first.id }, to: { portId: tied.id } });
    const runId = (routed.data as { runId: string }).runId;
    const plain = apply(routed.document, 'insert_inline_component', {
      runId,
      type: 'valveGate',
      tag: 'XV-9',
      at: { leg: 0, centreDistance: 3000 },
    });
    const answer = data<{
      verdict: string;
      targets: Array<{ tag: string; ok: boolean; pointMm: unknown; findings: Array<{ code: string; severity: string }> }>;
    }>(apply(plain, 'add_level', { name: 'Grade', elevation: 0, height: 4000 }), 'check_reachability', {
      targetsFrom: ['valves'],
      operatingHeightMm: BAND,
      maxHorizontalReachMm: 600,
    });
    expect(answer.targets).toEqual([
      expect.objectContaining({
        tag: 'XV-9',
        ok: false,
        pointMm: null,
        findings: [expect.objectContaining({ code: 'STA_TARGET_UNLOCATED', severity: 'warn' })],
      }),
    ]);
    expect(answer.verdict).toBe('warn');
  });

  it('a run that does not derive is named in sourceSkippedRuns, not silently dropped', () => {
    const doc = valved();
    const broken = JSON.parse(JSON.stringify(doc)) as CadDocument;
    const runs = broken.plant?.piping?.runs ?? {};
    const run = Object.values(runs)[0] as unknown as { lineId: string };
    run.lineId = 'no-such-line';
    const answer = data<{ targets: unknown[]; sourceSkippedRuns: Array<{ runId: string; code: string }> }>(broken, 'check_reachability', {
      targets: [{ tag: 'A', kind: 'x', point: [0, 0, 0] }],
      targetsFrom: ['valves'],
      operatingHeightMm: BAND,
      maxHorizontalReachMm: 0,
    });
    expect(answer.targets).toHaveLength(1);
    expect(answer.sourceSkippedRuns).toEqual([{ runId: Object.keys(runs)[0], code: expect.stringMatching(/^RTE_/) }]);
  });
});
