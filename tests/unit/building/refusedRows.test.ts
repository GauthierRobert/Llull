import { describe, expect, it } from 'vitest';
import { portalHall } from '../../helpers/portalHall';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { BuildingElement, MomentConnectionElement } from '@aec/building/types';
import { scoreRows } from '@aec/industrial/frames/frameDesignLoop';
import { utilisationStats } from '@aec/industrial/reports/designReport';
import { failingRows, highestUtilisation, maxUtilisation, refusedRows, REFUSED_UTILISATION } from '@aec/industrial/common/utilisation';
import { connectionWelds } from '@aec/industrial/connections/connections';
import { BOLT_CLASS_SHAPE } from '@aec/industrial/frames/frameLoadParams';
import { mapElements } from './elementEdits';

const BOLT_CLASS_DESCRIPTION = BOLT_CLASS_SHAPE.boltClass.description ?? '';

const hall = (params: Record<string, unknown> = {}): CadDocument =>
  portalHall({ span: 24000, length: 30000, ...params }, createEmptyDocument());

const withMaterial = (doc: CadDocument, material: string, only?: (element: BuildingElement) => boolean): CadDocument =>
  mapElements(doc, (element) =>
    (element.category === 'member' || element.category === 'plate') && (only?.(element) ?? true) ? { ...element, material } : element,
  );

const profilesOf = (doc: CadDocument): Record<string, string> =>
  Object.fromEntries(
    Object.values(doc.building?.elements ?? {}).flatMap((element) =>
      element.category === 'member' ? [[element.id, element.profile]] : [],
    ),
  );

interface Row {
  readonly utilisation: number;
  readonly kind: string;
  readonly check: string;
  readonly refusal?: { code: string; message: string };
}
interface Data {
  readonly rows: Row[];
  readonly maxUtilisation: number;
  readonly refused: Array<{ elementId: string; code: string }>;
  readonly csv: string;
}

const refusal = { code: 'STL_GRADE_UNKNOWN', message: 'STL_GRADE_UNKNOWN: x' };
const refused = { utilisation: REFUSED_UTILISATION, refusal };

describe('refused rows are not utilisations', () => {
  it('helpers exclude refused rows from max, failing and worst', () => {
    const rows = [{ utilisation: 0.4 }, { utilisation: 1.3 }, refused];
    expect(maxUtilisation(rows)).toBe(1.3);
    expect(failingRows(rows)).toEqual([{ utilisation: 1.3 }]);
    expect(highestUtilisation(rows)).toEqual({ utilisation: 1.3 });
    expect(refusedRows(rows)).toEqual([refused]);
    expect(maxUtilisation([refused])).toBe(0);
    expect(highestUtilisation([refused])).toBeUndefined();
  });
  it('scoreRows and utilisationStats do not count a refused row as a failure or a maximum', () => {
    const rows = [
      {
        frame: 'F',
        elementId: 'a',
        mark: 'a',
        kind: 'column',
        combination: '',
        axial: 0,
        moment: 0,
        shear: 0,
        utilisation: 0.5,
        check: '',
      },
      { frame: 'F', elementId: 'b', mark: 'b', kind: 'rafter', combination: '', axial: 0, moment: 0, shear: 0, check: '', ...refused },
    ] as const;
    expect(scoreRows(rows, 0.95)).toMatchObject({ failing: 0, max: 0.5, refused: 1 });
    expect(utilisationStats(rows)).toEqual({ maxUtilisation: 0.5, failures: 0, refusedCount: 1 });
  });
});

describe('design_portal_frames with a refused member', () => {
  it('leaves every profile untouched and names the refusal (grade A36)', () => {
    const bad = withMaterial(hall(), 'A36');
    const result = execute(bad, 'design_portal_frames', {});
    expect(profilesOf(result.document)).toEqual(profilesOf(bad));
    expect(result.document).toBe(bad);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/not designed — STL_GRADE_UNKNOWN/);
    expect(result.summary).not.toMatch(/Max utilisation now/);
    const data = result.data as { refused: Array<{ code: string; mark: string }> };
    expect(data.refused.length).toBeGreaterThanOrEqual(2);
    expect(data.refused[0]?.code).toBe('STL_GRADE_UNKNOWN');
  });
  it('still designs a sound model', () => {
    const result = execute(hall(), 'design_portal_frames', { windPressure: 0.7 });
    expect(result.summary).not.toMatch(/not designed/);
  });
});

describe('check_portal_frames reports refused rows separately', () => {
  it('prints refused (<code>), excludes them from maxUtilisation and lists them', () => {
    const result = execute(withMaterial(hall(), 'A36'), 'check_portal_frames', {});
    const data = result.data as Data;
    expect(data.maxUtilisation).toBeLessThan(REFUSED_UTILISATION);
    expect(data.rows.filter((row) => row.refusal).length).toBeGreaterThanOrEqual(2);
    expect(data.refused.length).toBe(data.rows.filter((row) => row.refusal).length);
    expect(result.summary).toContain('refused (STL_GRADE_UNKNOWN)');
    expect(result.summary).not.toMatch(/all OK/);
    expect(result.summary).not.toMatch(/ 99\b/);
    expect(data.csv).toContain('REFUSED');
  });
});

describe('design_purlins with a refused purlin', () => {
  it('does not up-size members whose grade was refused', () => {
    const bad = withMaterial(hall(), 'Fe360');
    const result = execute(bad, 'design_purlins', {});
    expect(profilesOf(result.document)).toEqual(profilesOf(bad));
    expect(result.summary).toContain('STL_GRADE_UNKNOWN');
  });
});

describe('the other checks mark refused rows', () => {
  it.each(['check_bracing', 'check_purlins'])('%s: refused rows carry the marker and stay out of maxUtilisation', (tool) => {
    const data = execute(withMaterial(hall(), 'A36'), tool, {}).data as Data;
    const marked = data.rows.filter((row) => row.refusal);
    expect(marked.length).toBeGreaterThan(0);
    expect(data.refused.length).toBe(marked.length);
    expect(data.maxUtilisation).toBeLessThan(REFUSED_UTILISATION);
  });
  it('check_foundations marks a refused plate row', () => {
    const doc = withMaterial(hall({ columnBase: 'fixed' }), 'A36', (element) => element.category === 'plate');
    const data = execute(doc, 'check_foundations', {}).data as Data;
    expect(data.rows.some((row) => row.refusal?.code === 'STL_GRADE_UNKNOWN')).toBe(true);
    expect(data.maxUtilisation).toBeLessThan(REFUSED_UTILISATION);
  });
  it('check_crane_runways marks a refused beam row', () => {
    const doc = withMaterial(portalHall({ span: 24000, length: 30000, crane: { capacity: 10, railHeight: 6000 } }), 'A36');
    const result = execute(doc, 'check_crane_runways', {});
    expect((result.data as Data).rows.some((row) => row.refusal?.code === 'STL_GRADE_UNKNOWN')).toBe(true);
    expect(result.summary).toContain('refused (STL_GRADE_UNKNOWN)');
  });
});

describe('connection welds follow the rafter grade (INT-04)', () => {
  const eaves = (doc: CadDocument): MomentConnectionElement =>
    Object.values(doc.building?.elements ?? {}).find(
      (element): element is MomentConnectionElement => element.category === 'connection' && element.kind === 'eaves',
    ) as MomentConnectionElement;
  const rafterGrade = (doc: CadDocument, material: string): CadDocument =>
    withMaterial(doc, material, (element) => element.category === 'member' && element.role === 'rafter');

  it('uses the grade of the rafter at the section thickness, not S355', () => {
    const base = hall();
    const s355 = connectionWelds(base, base.building as NonNullable<CadDocument['building']>, eaves(base));
    const s235Doc = rafterGrade(base, 'S235JR');
    const s235 = connectionWelds(s235Doc, s235Doc.building as NonNullable<CadDocument['building']>, eaves(s235Doc));
    expect(s355).toMatchObject({ flangeThroat: 9, webThroat: 6 });
    expect(s235).toMatchObject({ flangeThroat: 7, webThroat: 5 });
  });
  it('refuses an unknown grade: no weld sizes, a named refusal in the schedule and the takeoff', () => {
    const bad = rafterGrade(hall(), 'A36');
    const welds = connectionWelds(bad, bad.building as NonNullable<CadDocument['building']>, eaves(bad));
    expect(welds).toMatchObject({ refusal: { code: 'STL_GRADE_UNKNOWN' } });
    const schedule = execute(bad, 'building_schedule', { kind: 'connection' }).data as { rows: unknown[][] };
    expect(schedule.rows[0]?.[9]).toBe('refused (STL_GRADE_UNKNOWN)');
    const lines = (execute(bad, 'quantity_takeoff', {}).data as { lines: Array<{ key: string; description: string }> }).lines;
    expect(lines.some((line) => line.key === 'connection.weld.m' || line.key === 'connection.weld metal.kg')).toBe(false);
    expect(
      lines.some((line) => line.description.includes('Fillet welds not quantified') && line.description.includes('STL_GRADE_UNKNOWN')),
    ).toBe(true);
  });
});

describe('anchor bolt basis (EN 1993-1-8 simplified, not EN 1992-4)', () => {
  it('check_foundations states the anchor basis in data.basis and the summary', () => {
    const result = execute(hall({ columnBase: 'fixed' }), 'check_foundations', {});
    expect((result.data as { basis: { anchors: string } }).basis.anchors).toBe(
      'EN 1993-1-8 structural-bolt rules (simplified), not EN 1992-4 anchor design',
    );
    expect(result.summary).toContain('Anchors: EN 1993-1-8 structural-bolt rules (simplified), not EN 1992-4');
  });
  it('the boltClass parameter says anchors use the simplified structural-bolt rules', () => {
    expect(BOLT_CLASS_DESCRIPTION).toContain('anchors: simplified, structural-bolt rules');
  });
});
