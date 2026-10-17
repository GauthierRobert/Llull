import { describe, expect, it } from 'vitest';
import { parseCheck, parseFlatPattern, parseHoleRows, sortHoleRows, type HoleRowView } from '@ui/panels/manufacturing/ftrData';
import { filterValues, markingText, parseMaterialRecord } from '@ui/panels/materials/materialRecordView';
import { parseBom, parseSelection, selectionParams } from '@ui/panels/fasteners/fastenerView';

const row = (label: string, patch: Partial<HoleRowView> = {}): HoleRowView => ({
  label,
  x: 0,
  y: 0,
  kind: 'simple',
  diameter: 1,
  depth: 'through',
  ...patch,
});

describe('sortHoleRows', () => {
  it('sorts labels numerically and toggles direction', () => {
    const rows = [row('H10'), row('H2'), row('H1')];
    expect(sortHoleRows(rows, 'label', true).map((r) => r.label)).toEqual(['H1', 'H2', 'H10']);
    expect(sortHoleRows(rows, 'label', false).map((r) => r.label)).toEqual(['H10', 'H2', 'H1']);
  });
  it('sorts through-holes after blind depths and keeps the input untouched', () => {
    const rows = [row('H1', { depth: 'through' }), row('H2', { depth: '3' })];
    expect(sortHoleRows(rows, 'depth', true).map((r) => r.label)).toEqual(['H2', 'H1']);
    expect(rows[0]?.label).toBe('H1');
  });
  it('sorts by diameter and kind', () => {
    const rows = [row('H1', { diameter: 5, kind: 'simple' }), row('H2', { diameter: 2, kind: 'countersink' })];
    expect(sortHoleRows(rows, 'diameter', true).map((r) => r.label)).toEqual(['H2', 'H1']);
    expect(sortHoleRows(rows, 'kind', true).map((r) => r.label)).toEqual(['H2', 'H1']);
  });
});

describe('payload readers', () => {
  it('rejects data that is not the expected shape', () => {
    expect(parseCheck(undefined)).toBeNull();
    expect(parseFlatPattern({})).toBeNull();
    expect(parseHoleRows({ rows: 3 })).toBeNull();
    expect(parseMaterialRecord(null)).toBeNull();
    expect(parseBom({})).toBeNull();
    expect(parseSelection({})).toBeNull();
  });
  it('reads a finding with its value, limit, source and unverified provenance', () => {
    const view = parseCheck({
      status: 'fail',
      findings: [
        {
          code: 'FTR_BEND_RADIUS_BELOW_MIN',
          severity: 'fail',
          ids: ['b1'],
          value: 2,
          limit: 3,
          unit: 'mm',
          source: 'row 1',
          remediation: 'raise R',
        },
      ],
      rulesSkipped: [{ rule: 'holeToBend', code: 'FTR_RULE_THRESHOLD_MISSING' }],
      unverified: true,
      reviewRequired: true,
      provenance: { sources: ['table A'], formulas: { ba: 'theta*(R+K*T)' } },
      unverifiedInputs: [{ kind: 'radius_row', id: 'r1', source: 'draft' }],
    });
    expect(view?.findings[0]).toMatchObject({ code: 'FTR_BEND_RADIUS_BELOW_MIN', value: 2, limit: 3, unit: 'mm' });
    expect(view?.rulesSkipped).toEqual(['holeToBend: FTR_RULE_THRESHOLD_MISSING']);
    expect(view?.provenance.map((p) => p.label)).toEqual(['Formula ba', 'Source', 'Unverified radius_row']);
  });
});

describe('material record view', () => {
  const values = [
    { id: 'a', property: 'Ftu', unit: 'ksi', basis: 'A', direction: 'L', value: 1, unverified: false },
    {
      id: 'b',
      property: 'Ftu',
      unit: 'ksi',
      basis: 'typical',
      direction: 'LT',
      value: 2,
      unverified: true,
      unverifiedReasons: ['typical basis'],
    },
  ];
  it('filters by basis and direction', () => {
    const view = parseMaterialRecord({ legacy: false, density: { available: false }, values });
    const rows = view?.values ?? [];
    expect(filterValues(rows, { basis: 'A', direction: 'all' }).map((r) => r.id)).toEqual(['a']);
    expect(filterValues(rows, { basis: 'all', direction: 'LT' }).map((r) => r.id)).toEqual(['b']);
    expect(filterValues(rows, { basis: 'A', direction: 'LT' })).toEqual([]);
    expect(rows[1]?.unverified).toBe(true);
  });
  it('words export markings', () => {
    expect(markingText({ regime: 'EAR', eccn: '1C002' })).toBe('EAR 1C002');
    expect(markingText({ regime: 'ITAR' })).toBe('ITAR');
    expect(markingText({ regime: 'none' })).toBe('No marking');
  });
});

describe('selectionParams', () => {
  const draft = {
    family: 'MS20470',
    diameterDash: '4',
    stack: '0.2',
    unit: 'in',
    nut: '',
    washer: '',
    useSelection: false,
    axisPoint: '',
    holeMode: 'none',
  };
  it('is null while the draft is incomplete', () => {
    expect(selectionParams({ ...draft, family: '' }, [], { stack: 0.2, axisPoint: null })).toBeNull();
    expect(selectionParams(draft, [], { stack: undefined, axisPoint: null })).toBeNull();
    expect(selectionParams({ ...draft, useSelection: true }, [], { stack: 0.2, axisPoint: [0, 0, 0] })).toBeNull();
  });
  it('carries the stack value or the selected plates', () => {
    expect(selectionParams(draft, [], { stack: 0.2, axisPoint: null })).toEqual({
      family: 'MS20470',
      diameterDash: '4',
      stack: { value: 0.2, unit: 'in' },
    });
    expect(selectionParams({ ...draft, useSelection: true, nut: 'N1' }, ['a'], { stack: undefined, axisPoint: [1, 2, 3] })).toEqual({
      family: 'MS20470',
      diameterDash: '4',
      nut: 'N1',
      stackIds: ['a'],
      axisPoint: [1, 2, 3],
    });
  });
});
