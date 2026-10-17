import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { BeadForm, FlangedHoleForm, SheetMetalPart } from '@core/model/sheetMetal';
import { developedHoleRadius, lipGeometry, lipVolume } from '@aero/sheetmetal/formGeometry';
import { apply, data, expectRefusal, meshBounds, meshVolume, ok } from './helpers';
import { beadVolumeChange, integrate, plate } from './plates';

interface FlatData {
  area: number;
  cutoutCount: number;
  unverified: boolean;
  unverifiedInputs: Array<{ kind: string; id: string }>;
  formingNotes: Array<Record<string, unknown>>;
}
interface DxfData {
  dxf: string;
}

const T = 1.6;
const HOLE = { face: { near: [50, 40, 0] }, center: [50, 40, 0], holeDiameter: 40, flangeHeight: 4, flangeAngle: 90, lipRadius: 2 };
const holeParams = (part: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: part, ...HOLE, ...extra });
const CUT_RADIUS = 20 + T + 2;

describe('add_flanged_hole (VC-FTR-13)', () => {
  it('cuts the physical hole, adds the lip and flags the developed cut diameter approximate', () => {
    const { doc, part } = plate(100, 80);
    const result = ok(doc, 'add_flanged_hole', holeParams(part));
    expect(result.affected).toEqual([part]);
    expect(result.document.order).toEqual(doc.order);
    const info = result.data as {
      cutRadius: number;
      wallLength: number;
      flatCutDiameter: { value: number; approximate: boolean; verification: string; source: string };
    };
    expect(info.cutRadius).toBeCloseTo(CUT_RADIUS, 12);
    expect(info.wallLength).toBeCloseTo(2, 12);
    const developed = CUT_RADIUS - (Math.PI / 2) * (2 + 0.44 * T) - 2;
    expect(info.flatCutDiameter.value).toBeCloseTo(2 * developed, 9);
    expect(info.flatCutDiameter).toMatchObject({ approximate: true, verification: 'unverified' });
    expect(info.flatCutDiameter.source).toContain('not verified');
    expect(result.summary).toContain('APPROXIMATE');
    const node = (result.document.sheetMetal?.parts[part] as SheetMetalPart).nodes['m1'];
    expect(node).toMatchObject({ type: 'form', on: 'f1', form: { kind: 'flanged_hole', holeDiameter: 40, flangeHeight: 4, lipRadius: 2 } });
  });

  it('folds to the analytic lip volume, rises by the flange height and develops to a smaller approximate hole', () => {
    const { doc, part } = plate(100, 80);
    const { document } = ok(doc, 'add_flanged_hole', holeParams(part));
    const [a, outer, r] = [20, 20 + T, 2];
    const bend = integrate(
      (phi) => integrate((rho) => 2 * Math.PI * (CUT_RADIUS - rho * Math.sin(phi)) * rho, r, r + T, 400),
      0,
      Math.PI / 2,
      400,
    );
    const wall = Math.PI * (outer ** 2 - a ** 2) * 2;
    const lip = lipVolume((node(document, part) as { form: FlangedHoleForm }).form, T);
    expect(lip).toBeCloseTo(bend + wall, 3);
    const expectedDelta = lip - Math.PI * CUT_RADIUS ** 2 * T;
    const delta = meshVolume(document, part) - meshVolume(doc, part);
    expect(Math.abs(delta / expectedDelta - 1)).toBeLessThan(1e-2);
    expect(meshBounds(document, part).max[2]).toBeCloseTo(T + 4, 6);
    const flat = data<FlatData>(document, 'flat_pattern', { id: part });
    const developed = CUT_RADIUS - (Math.PI / 2) * (2 + 0.44 * T) - 2;
    expect(flat.area).toBeCloseTo(100 * 80 - Math.PI * developed ** 2, 6);
    expect(flat.unverified).toBe(true);
    expect(flat.unverifiedInputs.some((input) => input.kind === 'preset' && input.id.includes('flanged_hole'))).toBe(true);
    expect(flat.formingNotes[0]).toMatchObject({ kind: 'flanged_hole', approximate: true, excludedFromFlatPattern: false });
    const dxf = data<DxfData>(document, 'export_flat_pattern_dxf', { id: part }).dxf;
    expect(dxf).toContain('CIRCLE');
    expect(dxf).toContain('FORMING flanged hole m1');
    expect(dxf).toContain('APPROXIMATE');
  });

  it('bends the lip towards -normal with direction down and supports leaning lips', () => {
    const { doc, part } = plate(100, 80);
    const down = apply(doc, 'add_flanged_hole', holeParams(part, { direction: 'down' }));
    expect(meshBounds(down, part).min[2]).toBeCloseTo(-4, 6);
    const leaning = ok(doc, 'add_flanged_hole', holeParams(part, { flangeAngle: 60, flangeHeight: 3 }));
    const form = (node(leaning.document, part) as { form: FlangedHoleForm }).form;
    const lip = lipGeometry(form, T);
    expect(lip?.wall).toBeCloseTo((3 - 2 * (1 - Math.cos(Math.PI / 3))) / Math.sin(Math.PI / 3), 9);
    expect(developedHoleRadius(lip as NonNullable<typeof lip>, form, 0.44, T)).toBeLessThan(CUT_RADIUS);
  });

  it('refuses unforming sizes, holes that do not fit, and unknown ids', () => {
    const { doc, part } = plate(100, 80);
    expectRefusal(doc, 'add_flanged_hole', holeParams(part, { flangeHeight: 1 }), 'FTR_FORM_INVALID', 'flangeHeight');
    expectRefusal(doc, 'add_flanged_hole', holeParams(part, { flangeAngle: 120 }), 'FTR_FORM_INVALID', 'flangeAngle');
    expectRefusal(doc, 'add_flanged_hole', holeParams(part, { lipRadius: 0 }), 'FTR_FORM_INVALID');
    expectRefusal(doc, 'add_flanged_hole', holeParams(part, { flangeHeight: 60, holeDiameter: 8 }), 'FTR_FORM_INVALID');
    expectRefusal(doc, 'add_flanged_hole', holeParams(part, { center: [10, 10, 0] }), 'FTR_CUTOUT_INVALID', 'center');
    expectRefusal(doc, 'add_flanged_hole', holeParams('nope'), 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(doc, 'add_flanged_hole', holeParams(part, { face: { near: [50, 40, 90] } }), 'FTR_FACE_NOT_FOUND', 'face.near');
    const first = apply(doc, 'add_flanged_hole', holeParams(part, { center: [30, 40, 0], holeDiameter: 10 }));
    expectRefusal(first, 'add_flanged_hole', holeParams(part, { center: [42, 40, 0], holeDiameter: 10 }), 'FTR_CUTOUT_INVALID');
  });

  it('is pure', () => {
    const { doc, part } = plate(100, 80);
    const before = JSON.stringify(doc);
    execute(doc, 'add_flanged_hole', holeParams(part));
    expect(JSON.stringify(doc)).toBe(before);
  });
});

const node = (document: Parameters<typeof meshVolume>[0], part: string): unknown =>
  (document.sheetMetal?.parts[part] as SheetMetalPart).nodes['m1'];

const BEAD_RULE = { name: 'AL1.0', thickness: 1, insideRadius: 3 };
const beadParams = (part: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: part,
  face: { near: [50, 30, 0] },
  path: [
    [20, 30, 0],
    [80, 30, 0],
  ],
  radius: 3,
  depth: 2,
  endShape: 'round',
  ...extra,
});
const BEAD: BeadForm = { kind: 'bead', start: [20, 30], end: [80, 30], radius: 3, depth: 2, endShape: 'round', direction: 'up' };

describe('add_bead (VC-FTR-14)', () => {
  it('forms a bead whose arch has the analytic section and whose volume matches the closed form', () => {
    const { doc, part } = plate(100, 60, BEAD_RULE);
    const result = ok(doc, 'add_bead', beadParams(part));
    expect(result.affected).toEqual([part]);
    const info = result.data as { footprintWidth: number; areaChangePerLength: number; length: number };
    const w = Math.sqrt(2 * (2 * 4 - 2));
    expect(info.footprintWidth).toBeCloseTo(2 * w, 9);
    expect(info.length).toBeCloseTo(60, 9);
    expect(info.areaChangePerLength).toBeCloseTo((Math.PI / 3) * (16 - 9) - 1 * (w + w / 2), 9);
    const expected = beadVolumeChange(BEAD, 1);
    const delta = meshVolume(result.document, part) - meshVolume(doc, part);
    expect(Math.abs(delta / expected - 1)).toBeLessThan(2e-2);
    expect(meshBounds(result.document, part).max[2]).toBeCloseTo(3, 6);
    expect(result.summary).toContain('Excluded from the flat pattern');
  });

  it('is excluded from the flat pattern with a forming note and a DXF note', () => {
    const { doc, part } = plate(100, 60, BEAD_RULE);
    const flat0 = data<FlatData>(doc, 'flat_pattern', { id: part });
    const beaded = apply(doc, 'add_bead', beadParams(part));
    const flat = data<FlatData>(beaded, 'flat_pattern', { id: part });
    expect(flat.area).toBeCloseTo(flat0.area, 12);
    expect(flat.cutoutCount).toBe(0);
    expect(flat.formingNotes).toHaveLength(1);
    expect(flat.formingNotes[0]).toMatchObject({ id: 'm1', kind: 'bead', excludedFromFlatPattern: true, approximate: false });
    expect(String(flat.formingNotes[0]?.['note'])).toContain('NOT IN FLAT PATTERN');
    const dxf = data<DxfData>(beaded, 'export_flat_pattern_dxf', { id: part }).dxf;
    expect(dxf).toContain('FORMING bead m1');
    expect(dxf).not.toContain('CIRCLE');
  });

  it('supports open ends and the -normal side', () => {
    const { doc, part } = plate(100, 60, BEAD_RULE);
    const open = ok(doc, 'add_bead', beadParams(part, { endShape: 'open', direction: 'down' }));
    const delta = meshVolume(open.document, part) - meshVolume(doc, part);
    const expected = beadVolumeChange({ ...BEAD, endShape: 'open' }, 1);
    expect(Math.abs(delta / expected - 1)).toBeLessThan(3e-2);
    expect(meshBounds(open.document, part).min[2]).toBeCloseTo(-2, 1);
  });

  it('refuses a bead that cannot form or does not fit, and unknown ids', () => {
    const { doc, part } = plate(100, 60, BEAD_RULE);
    expectRefusal(doc, 'add_bead', beadParams(part, { depth: 3 }), 'FTR_FORM_INVALID', 'depth');
    expectRefusal(doc, 'add_bead', beadParams(part, { radius: 0 }), 'FTR_FORM_INVALID');
    expectRefusal(
      doc,
      'add_bead',
      beadParams(part, {
        path: [
          [20, 30, 0],
          [20, 30, 0],
        ],
      }),
      'FTR_FORM_INVALID',
      'path',
    );
    expectRefusal(
      doc,
      'add_bead',
      beadParams(part, {
        path: [
          [2, 30, 0],
          [80, 30, 0],
        ],
      }),
      'FTR_CUTOUT_INVALID',
      'path',
    );
    expectRefusal(doc, 'add_bead', beadParams('nope'), 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(doc, 'add_bead', beadParams(part, { face: { near: [50, 30, 90] } }), 'FTR_FACE_NOT_FOUND', 'face.near');
    const beaded = apply(doc, 'add_bead', beadParams(part));
    expectRefusal(
      beaded,
      'add_bead',
      beadParams(part, {
        path: [
          [40, 33, 0],
          [60, 33, 0],
        ],
      }),
      'FTR_CUTOUT_INVALID',
    );
    const hole = apply(doc, 'add_flanged_hole', {
      ...holeParams(part),
      center: [50, 30, 0],
      face: { near: [50, 30, 0] },
      holeDiameter: 10,
    });
    expectRefusal(hole, 'add_bead', beadParams(part), 'FTR_CUTOUT_INVALID');
  });

  it('is pure and blocks a joggle across a formed flat', () => {
    const { doc, part } = plate(100, 60, BEAD_RULE);
    const beaded = apply(doc, 'add_bead', beadParams(part));
    const before = JSON.stringify(doc);
    execute(doc, 'add_bead', beadParams(part));
    expect(JSON.stringify(doc)).toBe(before);
    expectRefusal(
      beaded,
      'add_joggle',
      {
        id: part,
        face: { near: [10, 10, 0] },
        line: [
          [90, 60],
          [90, 0],
        ],
        offset: 3,
        angle: 30,
        side: 'up',
      },
      'FTR_JOGGLE_LINE_INVALID',
    );
  });
});
