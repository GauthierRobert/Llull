import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FtrCheckData, FtrFinding } from '@core/model/manufacturing';
import { apply, data, expectRefusal, ok } from './helpers';

const ROW = {
  material: 'TEST-ALLOY',
  temper: 'T0',
  thickness: 0.8,
  minInsideRadius: 2,
  units: 'mm',
  bendAngle: 90,
  source: 'synthetic test row (not engineering data)',
  verification: 'unverified',
};

interface Built {
  doc: CadDocument;
  part: string;
}

/** The VC-FTR-10 part: 0.8 mm TEST-ALLOY/T0, 20 x 20 base, 90-degree flange of 20, inside radius `radius`. */
function testPart(
  radius: number,
  options: { row?: boolean; rule?: Record<string, unknown>; flange?: Record<string, unknown> } = {},
): Built {
  let doc = createEmptyDocument();
  if (options.row !== false) doc = apply(doc, 'import_bend_radius_table', { rows: [ROW] });
  doc = apply(doc, 'create_sheet_metal_rule', {
    name: 'TEST',
    material: 'TEST-ALLOY',
    temper: 'T0',
    thickness: 0.8,
    insideRadius: radius,
    kFactor: 0.4,
    kFactorStandard: 'ansi',
    ...options.rule,
  });
  const drawn = ok(doc, 'draw_rectangle', { width: 20, height: 20, position: [0, 0, 0] });
  const made = ok(drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: 'TEST', side: 'up' });
  const part = made.affected[0] as string;
  const doc2 = apply(made.document, 'add_flange', {
    id: part,
    edge: { near: [20, 10, 0] },
    angle: 90,
    length: 20,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
    ...options.flange,
  });
  return { doc: doc2, part };
}

const codes = (check: FtrCheckData): string[] => check.findings.map((finding) => finding.code);
const find = (check: FtrCheckData, code: string): FtrFinding | undefined => check.findings.find((finding) => finding.code === code);

describe('minimum bend radius (VC-FTR-10)', () => {
  it('fails R 1.0 against the 2.0 row and cites the row source', () => {
    const { doc, part } = testPart(1.0);
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    expect(check.status).toBe('fail');
    const finding = find(check, 'FTR_BEND_RADIUS_BELOW_MIN');
    expect(finding).toMatchObject({ severity: 'fail', limit: 2, value: 1, unit: 'mm', source: ROW.source });
    expect(finding?.ids).toEqual([part, 'b1']);
    expect(check.rulesApplied).toContain('min_bend_radius');
  });

  it('passes R 2.4 (no BELOW_MIN) but still warns about the unverified row', () => {
    const { doc, part } = testPart(2.4);
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    expect(codes(check)).not.toContain('FTR_BEND_RADIUS_BELOW_MIN');
    expect(codes(check)).toContain('FTR_UNVERIFIED_DATA');
    expect(check.status).toBe('warn');
  });

  it('refuses R = 0 at add_flange when the rule forbids sharp bends, and reports it on a sharp-allowed part', () => {
    const rejected = createEmptyDocument();
    const rule = apply(rejected, 'create_sheet_metal_rule', { name: 'S', material: 'A', thickness: 0.8, insideRadius: 0, kFactor: 0.33 });
    const drawn = ok(rule, 'draw_rectangle', { width: 20, height: 20, position: [0, 0, 0] });
    const made = ok(drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: 'S', side: 'up' });
    const flange = {
      id: made.affected[0],
      edge: { near: [20, 10, 0] },
      angle: 90,
      length: 20,
      lengthReference: 'outside_mold_line',
      position: 'material_outside',
    };
    expectRefusal(made.document, 'add_flange', flange, 'FTR_SHARP_BEND_FORBIDDEN', 'insideRadius');
    const allowed = apply(made.document, 'create_sheet_metal_rule', {
      name: 'S2',
      material: 'A',
      thickness: 0.8,
      insideRadius: 0,
      kFactor: 0.33,
      allowSharpBends: true,
    });
    const sharpBase = ok(allowed, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: 'S2', side: 'up' });
    const sharp = apply(sharpBase.document, 'add_flange', { ...flange, id: sharpBase.affected[0] });
    expect(
      data<FtrCheckData>(sharp, 'check_sheet_metal', { id: sharpBase.affected[0] }).findings.some(
        (finding) => finding.code === 'FTR_BEND_RADIUS_NO_TABLE_ROW',
      ),
    ).toBe(true);
  });

  it('reports a missing table row as a warning and lists the rule as skipped', () => {
    const { doc, part } = testPart(1.0, { row: false });
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    expect(codes(check)).toContain('FTR_BEND_RADIUS_NO_TABLE_ROW');
    expect(codes(check)).not.toContain('FTR_BEND_RADIUS_BELOW_MIN');
    expect(check.rulesSkipped).toContainEqual({ rule: 'min_bend_radius', code: 'FTR_BEND_RADIUS_NO_TABLE_ROW' });
    expect(check.rulesApplied).not.toContain('min_bend_radius');
    expect(check.status).toBe('warn');
  });
});

describe('unverified propagation and review (VC-FTR-40, 41)', () => {
  it('flags the check, the flat pattern and the DXF notes from an unverified row', () => {
    const { doc, part } = testPart(2.4);
    const check = data<FtrCheckData & { unverified: boolean }>(doc, 'check_sheet_metal', { id: part });
    expect(check.unverified).toBe(true);
    expect(check.unverifiedInputs[0]).toMatchObject({ kind: 'radius_row', source: ROW.source });
    expect(find(check, 'FTR_UNVERIFIED_DATA')?.severity).toBe('warn');
    expect(data<{ unverified: boolean }>(doc, 'flat_pattern', { id: part }).unverified).toBe(true);
    const dxf = data<{ dxf: string; unverified: boolean }>(doc, 'export_flat_pattern_dxf', { id: part });
    expect(dxf.unverified).toBe(true);
    expect(dxf.dxf).toContain('UNVERIFIED radius_row');
  });

  it('carries an unverified K table and unverified thresholds from the rule', () => {
    const { doc, part } = testPart(2.4, {
      rule: {
        kFactor: undefined,
        kTable: {
          rows: [
            { rOverT: 1, k: 0.4 },
            { rOverT: 4, k: 0.45 },
          ],
          source: 'secondary chart',
        },
        thresholds: { minFlange: { value: 3, source: 'rule 1' } },
      },
    });
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    expect(check.unverifiedInputs.map((input) => input.kind).sort()).toEqual(['k_table', 'preset', 'radius_row']);
    const flat = data<{ unverified: boolean; bends: Array<{ kFactor: { value: number; verification: string } }> }>(doc, 'flat_pattern', {
      id: part,
    });
    expect(flat.unverified).toBe(true);
    expect(flat.bends[0]?.kFactor.value).toBeCloseTo(0.4 + (0.05 * (3 - 1)) / 3, 9);
    expect(flat.bends[0]?.kFactor.verification).toBe('unverified');
  });

  it('is verified when every input is verified', () => {
    const { doc, part } = testPart(2.4);
    const verifiedDoc = apply(doc, 'import_bend_radius_table', { rows: [{ ...ROW, verification: 'verified' }] });
    expect(data<FtrCheckData>(verifiedDoc, 'check_sheet_metal', { id: part }).unverified).toBe(false);
    expect(execute(verifiedDoc, 'check_sheet_metal', { id: part }).summary).toContain('not approved');
  });
});

describe('waivers (VC-FTR-42)', () => {
  it('keeps the finding failing and adds FTR_WAIVER_NOT_APPROVED', () => {
    const { doc, part } = testPart(1.0);
    const waivers = [{ code: 'FTR_BEND_RADIUS_BELOW_MIN', ids: [part], approvalRef: 'approval-does-not-exist' }];
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part, waivers });
    expect(check.status).toBe('fail');
    expect(codes(check)).toEqual(expect.arrayContaining(['FTR_BEND_RADIUS_BELOW_MIN', 'FTR_WAIVER_NOT_APPROVED']));
    expect(find(check, 'FTR_WAIVER_NOT_APPROVED')).toMatchObject({ severity: 'fail', source: 'approval-does-not-exist' });
  });
});

describe('hole, edge, flange and relief rules (VC-FTR-16)', () => {
  const thresholds = {
    holeToBend: { value: 3, source: 'company rule 7', verification: 'verified' },
    holeToEdge: { value: 3, source: 'company rule 8', verification: 'verified' },
    minFlange: { value: 25, source: 'company rule 9', verification: 'verified' },
  };
  const withHole = (rule: Record<string, unknown>, center: [number, number], radius = 1): Built => {
    const base = testPart(2.4, { rule, flange: { widthStart: 4 } });
    const circle = ok(base.doc, 'draw_arc', { center, radius });
    return {
      part: base.part,
      doc: apply(circle.document, 'add_sheet_cutout', { id: base.part, face: { near: [5, 5, 0] }, profileId: circle.affected[0] }),
    };
  };

  it('flags a hole 2 mm from the bend tangent against a 3 mm threshold', () => {
    const { doc, part } = withHole({ thresholds }, [17, 12]);
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    const finding = find(check, 'FTR_HOLE_TO_BEND_TOO_CLOSE');
    expect(finding).toMatchObject({ severity: 'fail', limit: 3, unit: 'mm', source: 'company rule 7' });
    expect(finding?.value).toBeCloseTo(2, 6);
    expect(finding?.ids).toEqual([part, 'f1/cutout1', 'b1']);
    expect(check.rulesApplied).toEqual(expect.arrayContaining(['hole_to_bend', 'hole_to_edge']));
  });

  it('flags a hole too close to a free edge, and passes a well placed hole', () => {
    const near = withHole({ thresholds }, [10, 3.5]);
    const nearCheck = data<FtrCheckData>(near.doc, 'check_sheet_metal', { id: near.part });
    expect(find(nearCheck, 'FTR_HOLE_TO_EDGE_TOO_CLOSE')?.value).toBeCloseTo(2.5, 6);
    const good = withHole({ thresholds }, [10, 10]);
    const goodCodes = codes(data<FtrCheckData>(good.doc, 'check_sheet_metal', { id: good.part }));
    expect(goodCodes).not.toContain('FTR_HOLE_TO_BEND_TOO_CLOSE');
    expect(goodCodes).not.toContain('FTR_HOLE_TO_EDGE_TOO_CLOSE');
  });

  it('reports missing thresholds, never skipping silently', () => {
    const { doc, part } = withHole({}, [10, 10]);
    const check = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    expect(check.rulesSkipped).toEqual(
      expect.arrayContaining([
        { rule: 'hole_to_bend', code: 'FTR_RULE_THRESHOLD_MISSING' },
        { rule: 'hole_to_edge', code: 'FTR_RULE_THRESHOLD_MISSING' },
        { rule: 'min_flange', code: 'FTR_RULE_THRESHOLD_MISSING' },
        { rule: 'relief', code: 'FTR_RULE_THRESHOLD_MISSING' },
      ]),
    );
    expect(codes(check).filter((code) => code === 'FTR_RULE_THRESHOLD_MISSING')).toHaveLength(4);
  });

  it('checks the minimum flange length', () => {
    const { doc, part } = testPart(2.4, { rule: { thresholds } });
    const finding = find(data<FtrCheckData>(doc, 'check_sheet_metal', { id: part }), 'FTR_FLANGE_TOO_SHORT');
    expect(finding).toMatchObject({ severity: 'fail', limit: 25, ids: [part, 'f2'] });
    expect(finding?.value).toBeCloseTo(20 - 3.2, 6);
  });

  it('asks for a relief where the flange stops short of the edge, and is satisfied by add_relief', () => {
    const rule = { relief: { type: 'rectangular', widthRatio: 2 } };
    const { doc, part } = testPart(2.4, { rule, flange: { widthStart: 4, widthEnd: 4 } });
    const missing = data<FtrCheckData>(doc, 'check_sheet_metal', { id: part });
    expect(missing.findings.filter((finding) => finding.code === 'FTR_RELIEF_MISSING')).toHaveLength(2);
    const once = apply(doc, 'add_relief', { id: part, bend: 'b1', end: 'start' });
    const twice = apply(once, 'add_relief', { id: part, bend: 'b1', end: 'end' });
    expect(codes(data<FtrCheckData>(twice, 'check_sheet_metal', { id: part }))).not.toContain('FTR_RELIEF_MISSING');
    expect(codes(data<FtrCheckData>(once, 'check_sheet_metal', { id: part })).filter((code) => code === 'FTR_RELIEF_MISSING')).toHaveLength(
      1,
    );
    const none = testPart(2.4, { rule: { relief: { type: 'none', widthRatio: 1 } }, flange: { widthStart: 4 } });
    expect(codes(data<FtrCheckData>(none.doc, 'check_sheet_metal', { id: none.part }))).not.toContain('FTR_RELIEF_MISSING');
  });
});

describe('check_sheet_metal basics', () => {
  it('passes a clean verified part and is read-only', () => {
    const { doc, part } = testPart(2.4, {
      rule: { thresholds: { minFlange: { value: 5, source: 'rule', verification: 'verified' } }, relief: { type: 'none', widthRatio: 1 } },
    });
    const verified = apply(doc, 'import_bend_radius_table', { rows: [{ ...ROW, verification: 'verified' }] });
    const result = ok(verified, 'check_sheet_metal', { id: part });
    expect((result.data as FtrCheckData).status).toBe('pass');
    expect(result.document).toBe(verified);
    expect((result.data as FtrCheckData).reviewRequired).toBe(true);
  });

  it('refuses an unknown part', () => {
    expectRefusal(createEmptyDocument(), 'check_sheet_metal', { id: 'sm-1.1' }, 'FTR_PART_NOT_FOUND', 'id');
  });
});
