import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface FindingRow {
  code: string;
  ruleId: string;
  ruleset: string;
  clause: string;
  severity: string;
  ids: string[];
  measured: { value: number; unit: string };
  limit: { min?: number; max?: number; unit: string };
  remediation: string;
  source: string;
  location?: string;
}
interface Access {
  verdict: string;
  findings: FindingRow[];
  byId: Record<string, { verdict: string; findings: number[] }>;
  edges: Array<{ slabId: string; location: string; dropMm: number; protected: boolean }>;
  checked: { stairs: number; slabs: number; edges: number };
  skipped: string[];
  ruleTableVersion: string;
  reviewRequired: boolean;
  unverifiedRulesUsed: string[];
  notEvaluated: Array<{ ruleId: string }>;
}

const BOTH = ['iso_14122', 'osha_1910'];
const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Document with one stair climbing a level of `rise` mm. */
function stairDoc(rise: number, stair: Record<string, unknown>): { doc: CadDocument; id: string } {
  const withLevel = apply(createEmptyDocument(), 'add_level', { name: 'L0', height: rise });
  const added = ok(withLevel, 'add_stair', { start: [0, 0], ...stair });
  return { doc: added.document, id: added.affected[0] as string };
}

const check = (doc: CadDocument, params: Record<string, unknown>): Access => data<Access>(doc, 'check_access', params);

describe('check_access: stairs (VC-STA-04)', () => {
  it('passes the 3000 / 180 / 280 stair under both rulesets', () => {
    const { doc, id } = stairDoc(3000, { riserCount: 17, treadDepth: 280 });
    const result = check(doc, { rulesets: BOTH, include: ['stairs'] });
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
    expect(result.byId[id]).toEqual({ verdict: 'pass', findings: [] });
    expect(result.checked).toEqual({ stairs: 1, slabs: 0, edges: 0 });
    expect(result.reviewRequired).toBe(true);
    expect(result.ruleTableVersion).toBe('2026-10-18');
    expect(result.unverifiedRulesUsed).toEqual(['ISO-STR-FLIGHT-RISE']);
    expect(result.notEvaluated.map((row) => row.ruleId)).toEqual(['ISO-STR-HEADROOM', 'OSHA-STR-LANDING', 'OSHA-STR-UNIFORM']);
  });

  it('warns STA_STAIR_FLIGHT_RISE with STA_RULE_UNVERIFIED for the 4500 mm flight (B rule, never fail)', () => {
    const { doc, id } = stairDoc(4500, { riserCount: 24, treadDepth: 250 });
    const result = check(doc, { rulesets: BOTH, include: ['stairs'] });
    expect(result.verdict).toBe('warn');
    expect(result.findings.map((f) => [f.code, f.severity, f.ruleId])).toEqual([
      ['STA_STAIR_FLIGHT_RISE', 'warn', 'ISO-STR-FLIGHT-RISE'],
      ['STA_RULE_UNVERIFIED', 'warn', 'ISO-STR-FLIGHT-RISE'],
    ]);
    expect(result.findings[0]?.measured.value).toBeCloseTo(4500, 6);
    expect(result.findings[0]?.limit).toEqual({ max: 3000, unit: 'mm' });
    expect(result.findings[1]?.ids).toEqual([id]);
  });

  it('measures the flight rise per flight: a landing at 12 of 24 risers brings it under 3000 mm', () => {
    const { doc } = stairDoc(4500, { riserCount: 24, treadDepth: 250, landingAt: 12 });
    expect(check(doc, { rulesets: ['iso_14122'], include: ['stairs'] }).verdict).toBe('pass');
  });

  it('fails OSHA STA_STAIR_TREAD for a 200 mm going while ISO Blondel (636.4) passes', () => {
    const { doc, id } = stairDoc(2400, { riserCount: 11, treadDepth: 200 });
    const result = check(doc, { rulesets: BOTH, include: ['stairs'] });
    expect(result.verdict).toBe('fail');
    expect(result.findings.map((f) => f.code)).toEqual(['STA_STAIR_TREAD']);
    const [finding] = result.findings;
    expect(finding).toMatchObject({ ruleId: 'OSHA-STR-TREAD', ruleset: 'osha_1910', clause: '1910.25(c)(3)', severity: 'fail', ids: [id] });
    expect(finding?.measured.value).toBeCloseTo(200, 6);
    expect(finding?.limit).toEqual({ min: 241.3, unit: 'mm' });
    expect(result.byId[id]).toEqual({ verdict: 'fail', findings: [0] });
    expect(check(doc, { rulesets: ['iso_14122'], include: ['stairs'] }).verdict).toBe('pass');
  });

  it('reports riser, angle, width and Blondel breaches with their codes and fixes', () => {
    const { doc } = stairDoc(3000, { riserCount: 10, treadDepth: 150, width: 500 });
    const result = check(doc, { rulesets: BOTH, include: ['stairs'] });
    const codes = result.findings.map((f) => `${f.ruleId}:${f.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'ISO-STR-BLONDEL:STA_STAIR_BLONDEL',
        'ISO-STR-WIDTH:STA_STAIR_WIDTH',
        'OSHA-STR-RISER:STA_STAIR_RISER',
        'OSHA-STR-TREAD:STA_STAIR_TREAD',
        'OSHA-STR-ANGLE:STA_STAIR_ANGLE',
        'OSHA-STR-WIDTH:STA_STAIR_WIDTH',
      ]),
    );
    const angle = result.findings.find((f) => f.code === 'STA_STAIR_ANGLE');
    expect(angle?.measured.unit).toBe('deg');
    expect(angle?.measured.value).toBeCloseTo((Math.atan2(300, 150) * 180) / Math.PI, 6);
  });

  it('every finding carries the VC-STA-13 fields', () => {
    const { doc } = stairDoc(4500, { riserCount: 10, treadDepth: 150, width: 500 });
    for (const finding of check(doc, { rulesets: BOTH, include: ['stairs'] }).findings) {
      for (const key of ['code', 'ruleId', 'ruleset', 'clause', 'severity', 'ids', 'measured', 'limit', 'remediation', 'source'] as const) {
        expect(finding[key], `${finding.code} ${key}`).toBeDefined();
      }
      expect(finding.remediation.length).toBeGreaterThan(0);
      expect(['fail', 'warn']).toContain(finding.severity);
    }
  });

  it('only evaluates the requested ruleset', () => {
    const { doc } = stairDoc(2400, { riserCount: 11, treadDepth: 200 });
    expect(check(doc, { rulesets: ['iso_14122'], include: ['stairs'] }).unverifiedRulesUsed).toEqual(['ISO-STR-FLIGHT-RISE']);
    expect(check(doc, { rulesets: ['osha_1910'], include: ['stairs'] }).unverifiedRulesUsed).toEqual([]);
  });

  it('is read-only and pure', () => {
    const { doc } = stairDoc(2400, { riserCount: 11, treadDepth: 200 });
    const before = JSON.stringify(doc);
    const result = execute(doc, 'check_access', { rulesets: BOTH });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

/** Grade 0 / +4000 levels with a 4000 x 2000 deck on the upper one (SC-STA-05). */
function deckDoc(): { doc: CadDocument; deck: string; upper: string; lower: string } {
  let doc = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  const lower = Object.keys(doc.building?.levels ?? {})[0] as string;
  const withUpper = ok(doc, 'add_level', { name: '+4000', elevation: 4000, height: 3000 });
  doc = withUpper.document;
  const upper = Object.keys(doc.building?.levels ?? {}).find((id) => id !== lower) as string;
  const slab = ok(doc, 'add_slab', { boundary: rect(0, 0, 4000, 2000), thickness: 30, levelId: upper });
  return { doc: slab.document, deck: slab.affected[0] as string, upper, lower };
}

describe('check_access: slab edges', () => {
  it('skips the edge check with STA_EDGE_RULE_UNSET when no threshold is given', () => {
    const { doc, deck } = deckDoc();
    const result = check(doc, { rulesets: BOTH });
    expect(result.findings.map((f) => [f.code, f.severity])).toEqual([['STA_EDGE_RULE_UNSET', 'warn']]);
    expect(result.edges).toEqual([]);
    expect(result.verdict).toBe('warn');
    expect(result.byId[deck]?.findings).toEqual([]);
  });

  it('reports the four unprotected 4000 mm edges of the deck', () => {
    const { doc, deck } = deckDoc();
    const result = check(doc, { rulesets: BOTH, edgeDropThresholdMm: 500, edgeDropSource: 'project spec 3.2' });
    expect(result.verdict).toBe('fail');
    expect(result.findings).toHaveLength(4);
    expect(result.findings.every((f) => f.code === 'STA_EDGE_UNPROTECTED' && f.ids[0] === deck && f.severity === 'fail')).toBe(true);
    expect(result.findings[0]?.measured.value).toBe(4000);
    expect(result.findings[0]?.limit).toEqual({ max: 500, unit: 'mm' });
    expect(result.findings[0]?.clause).toBe('project spec 3.2');
    expect(result.findings.map((f) => f.location)).toEqual(['boundary edge 0', 'boundary edge 1', 'boundary edge 2', 'boundary edge 3']);
    expect(result.checked).toEqual({ stairs: 0, slabs: 1, edges: 4 });
  });

  it('passes when the threshold is above the drop', () => {
    const { doc } = deckDoc();
    expect(check(doc, { rulesets: BOTH, edgeDropThresholdMm: 4000 }).verdict).toBe('pass');
  });

  it('treats an adjacent lower slab as a surface below (drop 600 mm on the overlapped side)', () => {
    const { doc, lower } = deckDoc();
    const withFloor = apply(doc, 'add_slab', { boundary: rect(-3000, -3000, 8000, 5000), levelId: lower, offset: 3400 });
    const result = check(withFloor, {
      rulesets: BOTH,
      edgeDropThresholdMm: 1000,
      include: ['edges'],
      ids: [Object.keys(withFloor.building?.elements ?? {})[0] as string],
    });
    expect(result.edges.map((edge) => edge.dropMm)).toEqual([600, 600, 600, 600]);
    expect(result.verdict).toBe('pass');
  });

  it('counts a wall at least 1100 mm above the deck as protection, but not a short one', () => {
    const { doc, upper } = deckDoc();
    const tall = apply(doc, 'draw_walls', {
      points: [
        [0, 2000],
        [4000, 2000],
      ],
      thickness: 100,
      height: 1200,
      levelId: upper,
    });
    const guarded = check(tall, { rulesets: BOTH, edgeDropThresholdMm: 500 });
    expect(guarded.edges.map((edge) => edge.protected)).toEqual([false, false, true, false]);
    const short = apply(doc, 'draw_walls', {
      points: [
        [0, 2000],
        [4000, 2000],
      ],
      thickness: 100,
      height: 1000,
      levelId: upper,
    });
    expect(check(short, { rulesets: BOTH, edgeDropThresholdMm: 500 }).findings).toHaveLength(4);
    const partial = apply(doc, 'draw_walls', {
      points: [
        [0, 2000],
        [3000, 2000],
      ],
      thickness: 100,
      height: 1200,
      levelId: upper,
    });
    expect(check(partial, { rulesets: BOTH, edgeDropThresholdMm: 500 }).findings).toHaveLength(4);
  });

  it('checks the edges of a slab opening (open side inside the opening)', () => {
    const { doc, deck } = deckDoc();
    const holed = apply(doc, 'add_slab_opening', { slabId: deck, boundary: rect(1000, 500, 2000, 1500) });
    const result = check(holed, { rulesets: BOTH, edgeDropThresholdMm: 500 });
    const openingEdges = result.edges.filter((edge) => edge.location.startsWith('opening 0'));
    expect(openingEdges).toHaveLength(4);
    expect(openingEdges.every((edge) => edge.dropMm === 4000 && !edge.protected)).toBe(true);
  });

  it('converts document units (a metre document gives the same drops in mm)', () => {
    const base = apply(createEmptyDocument(), 'set_units', { units: 'm' });
    const grade = apply(base, 'add_level', { name: 'Grade', elevation: 0, height: 4 });
    const withLevel = apply(grade, 'add_level', { name: 'Deck', elevation: 4, height: 3 });
    const slab = apply(withLevel, 'add_slab', {
      boundary: rect(0, 0, 4, 2),
      thickness: 0.03,
      levelId: Object.keys(withLevel.building?.levels ?? {})[1],
    });
    const result = check(slab, { rulesets: BOTH, edgeDropThresholdMm: 500 });
    expect(result.edges.map((edge) => edge.dropMm)).toEqual([4000, 4000, 4000, 4000]);
  });
});

describe('check_access: selection, refusals, VC-STA-13', () => {
  it('lists non-checkable elements under skipped and honours ids / include', () => {
    const { doc, deck } = deckDoc();
    const withColumn = ok(doc, 'add_column', { location: [100, 100] });
    const column = withColumn.affected[0] as string;
    const result = check(withColumn.document, { rulesets: BOTH, ids: [column, deck], edgeDropThresholdMm: 500 });
    expect(result.skipped).toEqual([column]);
    expect(result.checked.slabs).toBe(1);
    const none = check(withColumn.document, { rulesets: BOTH, include: ['stairs'] });
    expect(none.checked).toEqual({ stairs: 0, slabs: 0, edges: 0 });
    expect(none.verdict).toBe('pass');
    expect(none.notEvaluated).toEqual([]);
  });

  it('answers on an empty document', () => {
    const result = check(createEmptyDocument(), { rulesets: BOTH });
    expect(result).toMatchObject({ verdict: 'pass', reviewRequired: true, findings: [] });
  });

  it('refuses an unknown element id (STA_UNKNOWN_ELEMENT)', () => {
    expectRefusal(createEmptyDocument(), 'check_access', { rulesets: BOTH, ids: ['stair-9'] }, 'STA_UNKNOWN_ELEMENT', 'ids');
  });

  it('rejects an unknown or missing ruleset as invalid params', () => {
    for (const params of [{ rulesets: ['din_nope'] }, { rulesets: [] }, {}]) {
      const result = execute(createEmptyDocument(), 'check_access', params);
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe('CMD_INVALID_PARAMS');
    }
  });
});
