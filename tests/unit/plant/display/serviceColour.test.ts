import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { findRow, rowsOf } from '@aec/plant/display/serviceSchemes';
import { paletteHex } from '@aec/plant/display/palette';
import { TOOLSETS } from '@protocol/toolsets';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document } from '../piping/rteFixtures';

/** SC-VIS-01: seven runs with free-text services (the last one, nitrogen, is never mapped under A13.1). */
const LINES: ReadonlyArray<readonly [string, string, number, number]> = [
  ['CW-101', 'cooling water', 100, 0],
  ['IA-102', 'compressed air', 50, 600],
  ['FG-103', 'natural gas', 100, 1200],
  ['FO-104', 'diesel', 80, 1800],
  ['CS-105', 'caustic soda', 50, 2400],
  ['FW-106', 'fire water', 150, 3000],
  ['N2-107', 'nitrogen', 50, 3600],
];

function plant(): CadDocument {
  let doc = createEmptyDocument();
  for (const [line, service, dn, y] of LINES)
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [0, y, 3000],
        [20000, y, 3000],
      ],
      dn,
      line,
      service,
    });
  return doc;
}

const ASME_MAP = {
  'cooling water': 'water',
  'compressed air': 'compressed_air',
  'natural gas': 'flammable_oxidizing',
  diesel: 'combustible',
  'caustic soda': 'toxic_corrosive',
  'fire water': 'fire_quenching',
};

const ISO_MAP = {
  'cooling water': 'sea water',
  'compressed air': 'non-flammable gases',
  'natural gas': 'flammable gases',
  diesel: 'fuel',
  'caustic soda': 'acids, alkalis',
  'fire water': 'fire fighting',
  nitrogen: 'non-flammable gases',
};

type Group = Record<string, unknown>;
interface Report {
  palette: string;
  approximate: boolean;
  reviewRequired: boolean;
  groups: Record<string, Group>;
  unmatched: string[];
  warnings: Array<{ code: string; ids: string[] }>;
  outOfScope: number;
}

describe('list_service_colour_schemes', () => {
  it('lists both schemes with sources, grades, conflicts and an approximate palette', () => {
    const result = data<{
      schemes: Array<{ scheme: string; approximate: boolean; palette: string; rows: Array<Record<string, unknown>> }>;
    }>(createEmptyDocument(), 'list_service_colour_schemes', {});
    expect(result.schemes.map((s) => [s.scheme, s.rows.length, s.approximate, s.palette])).toEqual([
      ['asme_a13_1', 10, true, 'llull-ral-approx-v1'],
      ['iso_14726', 12, true, 'llull-ral-approx-v1'],
    ]);
    const toxic = result.schemes[0]?.rows.find((row) => row['id'] === 'A13-TC');
    expect(toxic).toMatchObject({ grade: 'A', sources: ['S1', 'S3'], names: { fieldColour: 'orange', letterColour: 'black' } });
    expect(toxic?.['conflict']).toContain('S2');
    expect(typeof toxic?.['displayHex']).toBe('string');
    const one = data<{ schemes: unknown[] }>(createEmptyDocument(), 'list_service_colour_schemes', { scheme: 'iso_14726' });
    expect(one.schemes).toHaveLength(1);
  });

  it('refuses an unknown scheme', () => {
    expectRefusal(createEmptyDocument(), 'list_service_colour_schemes', { scheme: 'ral' }, 'VIS_SCHEME_UNKNOWN', 'scheme');
  });

  it('every row resolves to a palette colour; lookups accept category, id and ISO code', () => {
    for (const scheme of ['asme_a13_1', 'iso_14726'] as const)
      for (const row of rowsOf(scheme))
        expect(paletteHex(row.names['fieldColour'] ?? row.names['mainColour'] ?? ''), row.id).toMatch(/^#[0-9a-f]{6}$/);
    expect(findRow('iso_14726', 'GN')?.id).toBe('ISO-GN');
    expect(findRow('asme_a13_1', 'a13-wa')?.category).toBe('water');
    expect(findRow('asme_a13_1', 'nothing')).toBeUndefined();
    expect(paletteHex('chartreuse')).toBeUndefined();
  });
});

describe('apply_service_colour_scheme (VC-VIS-01, VC-VIS-02, SC-VIS-01)', () => {
  it('ASME A13.1: maps six services to category / field / letter colours and flags the unmatched nitrogen line', () => {
    const doc = plant();
    const result = ok(doc, 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'services-asme',
      serviceMap: ASME_MAP,
      activate: true,
    });
    expect(result.data).toEqual({ profileId: 'services-asme', mapped: 6, unmapped: ['nitrogen'], reviewRequired: true });
    expect(result.affected).toEqual([]);
    expect(result.document.display?.activeProfileId).toBe('services-asme');
    expect(result.document.display?.colourProfiles['services-asme']).toMatchObject({
      reviewRequired: true,
      palette: 'llull-ral-approx-v1',
    });
    expect(result.summary).toContain('review required');
    expect(result.document.entities).toBe(doc.entities);

    const report = data<Report>(result.document, 'colour_by_rule_report', {
      profileId: 'services-asme',
      groupBy: 'property',
      groupProperty: 'line',
    });
    expect(report).toMatchObject({ palette: 'llull-ral-approx-v1', approximate: true, reviewRequired: true });
    const expected: Array<[string, string, string, string]> = [
      ['CW-101', 'water', 'green', 'white'],
      ['IA-102', 'compressed_air', 'blue', 'white'],
      ['FG-103', 'flammable_oxidizing', 'yellow', 'black'],
      ['FO-104', 'combustible', 'brown', 'white'],
      ['CS-105', 'toxic_corrosive', 'orange', 'black'],
      ['FW-106', 'fire_quenching', 'red', 'white'],
    ];
    for (const [line, category, fieldColour, letterColour] of expected)
      expect(report.groups[line], line).toMatchObject({ category, fieldColour, letterColour });
    expect(Object.keys(report.groups)).toEqual(['CW-101', 'IA-102', 'FG-103', 'FO-104', 'CS-105', 'FW-106', 'N2-107']);
    expect(report.groups['N2-107']).toMatchObject({ category: null, ruleId: null, displayHex: null });
    expect(report.warnings[0]?.code).toBe('VIS_COLOUR_UNMATCHED');
    expect(report.warnings[0]?.ids).toEqual(report.groups['N2-107']?.['ids']);
    expect(report.unmatched.length).toBeGreaterThan(0);
  });

  it('ISO 14726: main colours per medium; switching profiles changes no geometry', () => {
    const doc = plant();
    const asme = apply(doc, 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'services-asme',
      serviceMap: ASME_MAP,
      activate: true,
    });
    const both = apply(asme, 'apply_service_colour_scheme', { scheme: 'iso_14726', profileId: 'services-iso', serviceMap: ISO_MAP });
    expect(both.display?.activeProfileId).toBe('services-asme');
    const report = data<Report>(both, 'colour_by_rule_report', { profileId: 'services-iso', groupBy: 'property', groupProperty: 'line' });
    const expected: Array<[string, string]> = [
      ['CW-101', 'green'],
      ['IA-102', 'grey'],
      ['FG-103', 'yellow'],
      ['FO-104', 'brown'],
      ['CS-105', 'violet'],
      ['FW-106', 'red'],
      ['N2-107', 'grey'],
    ];
    for (const [line, mainColour] of expected) expect(report.groups[line], line).toMatchObject({ mainColour });
    expect(report.unmatched).toEqual([]);
    expect(report.warnings).toEqual([]);
    const switched = apply(both, 'set_active_colour_profile', { profileId: 'services-iso' });
    expect(JSON.stringify(switched.entities)).toBe(JSON.stringify(doc.entities));
    expect(JSON.stringify(switched.building)).toBe(JSON.stringify(doc.building));
  });

  it('check_display lists the unmatched entities of the active profile and the review gate', () => {
    const asme = apply(plant(), 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'services-asme',
      serviceMap: ASME_MAP,
      activate: true,
    });
    const nitrogen = data<Report>(asme, 'colour_by_rule_report', { groupBy: 'property', groupProperty: 'line' }).groups['N2-107']?.[
      'ids'
    ] as string[];
    expect(nitrogen.length).toBeGreaterThan(0);
    const check = data<{ status: string; issues: Array<{ code: string; ids: string[]; severity: string }> }>(asme, 'check_display', {});
    expect(check.status).toBe('warn');
    expect(check.issues.find((i) => i.code === 'VIS_COLOUR_UNMATCHED')?.ids).toEqual(nitrogen);
    expect(check.issues.map((i) => i.code)).toContain('VIS_SCHEME_REVIEW_REQUIRED');
  });

  it('re-running with the same profile id replaces it; service texts compare case-insensitively', () => {
    const doc = plant();
    const first = apply(doc, 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'p',
      serviceMap: { 'COOLING WATER': 'water' },
    });
    const second = ok(first, 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'p',
      serviceMap: { 'cooling water': 'A13-FQ' },
    });
    expect(Object.keys(second.document.display?.colourProfiles ?? {})).toEqual(['p']);
    expect(second.document.display?.colourProfiles['p']?.rules[0]?.scheme?.category).toBe('fire_quenching');
    expect((second.data as { unmapped: string[] }).unmapped).toEqual([
      'caustic soda',
      'compressed air',
      'diesel',
      'fire water',
      'natural gas',
      'nitrogen',
    ]);
    const matched = data<Report>(first, 'colour_by_rule_report', { profileId: 'p', groupBy: 'rule' });
    expect(Object.keys(matched.groups)).toContain('A13-WA:COOLING WATER');
  });

  it('is pure', () => {
    const doc = plant();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'apply_service_colour_scheme', { scheme: 'iso_14726', profileId: 'p', serviceMap: ISO_MAP, activate: true });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('refuses unknown schemes and categories, empty and duplicate maps, bad ids', () => {
    const doc = plant();
    const base = { scheme: 'asme_a13_1', profileId: 'p', serviceMap: ASME_MAP };
    expectRefusal(doc, 'apply_service_colour_scheme', { ...base, scheme: 'bs_1710' }, 'VIS_SCHEME_UNKNOWN', 'scheme');
    const unknown = expectRefusal(
      doc,
      'apply_service_colour_scheme',
      { ...base, serviceMap: { diesel: 'combustible', 'cooling water': 'sea water' } },
      'VIS_SCHEME_CATEGORY_UNKNOWN',
      'serviceMap.cooling water',
    );
    expect(unknown.summary).toContain("'cooling water' -> 'sea water'");
    expectRefusal(doc, 'apply_service_colour_scheme', { ...base, serviceMap: {} }, 'VIS_RULE_INVALID', 'serviceMap');
    expectRefusal(doc, 'apply_service_colour_scheme', { ...base, property: '' }, 'VIS_RULE_INVALID', 'serviceMap');
    expectRefusal(
      doc,
      'apply_service_colour_scheme',
      { ...base, serviceMap: { Water: 'water', water: 'water' } },
      'VIS_RULE_INVALID',
      'serviceMap',
    );
    expectRefusal(doc, 'apply_service_colour_scheme', { ...base, profileId: '' }, 'VIS_RULE_INVALID', 'profileId');
    expectRefusal(doc, 'apply_service_colour_scheme', { ...base, profileId: 'constructor' }, 'CMD_RESERVED_ID');
  });

  it('the report refuses without a profile, and check_display fails on a dangling active profile', () => {
    const doc = plant();
    expectRefusal(doc, 'colour_by_rule_report', {}, 'VIS_PROFILE_NOT_FOUND');
    expectRefusal(doc, 'colour_by_rule_report', { profileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND');
    const dangling: CadDocument = { ...doc, display: { colourProfiles: {}, activeProfileId: 'ghost' } };
    const check = data<{ status: string; issues: Array<{ code: string }> }>(dangling, 'check_display', {});
    expect(check).toMatchObject({ status: 'fail', issues: [{ code: 'VIS_PROFILE_NOT_FOUND' }] });
    expect(data<{ status: string }>(doc, 'check_display', {}).status).toBe('pass');
  });

  it('check_display warns about a rule testing a property no entity has', () => {
    const doc = apply(plant(), 'define_colour_profile', {
      id: 'x',
      name: 'x',
      rules: [{ id: 'r', when: { property: 'noSuchKey', equals: 1 }, colour: '#ffffff', legend: 'l' }],
    });
    const check = data<{ issues: Array<{ code: string; paths: string[] }> }>(doc, 'check_display', {});
    expect(check.issues).toMatchObject([{ code: 'VIS_RULE_PROPERTY_UNKNOWN', paths: ['display.colourProfiles.x.rules.r'] }]);
  });

  it('saved profiles load back (persistence round trip)', () => {
    const doc = apply(plant(), 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'p',
      serviceMap: ASME_MAP,
      activate: true,
    });
    expect(validateDocumentValues(JSON.parse(JSON.stringify(doc)))).toEqual([]);
  });

  it('is listed in the review toolset with the core display commands', () => {
    for (const name of [
      'apply_service_colour_scheme',
      'list_service_colour_schemes',
      'define_colour_profile',
      'check_display',
      'colour_by_rule_report',
    ])
      expect(TOOLSETS.review).toContain(name);
  });
});

describe('plant property provider', () => {
  it('reports pipe facts (dn, line, service) of building pipe elements through ctx.properties', () => {
    const profiled = apply(plant(), 'define_colour_profile', {
      id: 'dn',
      name: 'dn',
      rules: [{ id: 'big', when: { property: 'dn', range: [100, 150] }, colour: '#ff0000', legend: 'big' }],
    });
    const report = data<Report>(profiled, 'colour_by_rule_report', { profileId: 'dn', groupBy: 'property', groupProperty: 'line' });
    const big = Object.entries(report.groups)
      .filter(([, group]) => group['ruleId'] === 'big')
      .map(([line]) => line);
    expect(big).toEqual(['CW-101', 'FG-103', 'FW-106']);
    expect(Object.keys(report.groups)).toHaveLength(7);
    expect(report.unmatched.length).toBeGreaterThan(0);
  });

  it('classifies equipment, ignores other entities, and reads plant piping runs', () => {
    let doc = apply(createEmptyDocument(), 'add_equipment', { mark: 'P-1', name: 'Pump', location: [2000, 0], size: [1000, 1000, 1000] });
    doc = apply(doc, 'add_box', { size: [1, 1, 1] });
    const byCategory = apply(doc, 'define_colour_profile', {
      id: 'cat',
      name: 'cat',
      rules: [{ id: 'eq', when: { property: 'category', equals: 'equipment' }, colour: '#00ff00', legend: 'equipment' }],
    });
    const report = data<Report>(byCategory, 'colour_by_rule_report', { profileId: 'cat', groupBy: 'rule' });
    expect(Object.keys(report.groups)).toEqual(['eq']);
    expect(report.outOfScope).toBe(1);

    let piping = cs150Document();
    const tie = (tag: string, position: number[], direction: number[]): string => {
      const result = ok(piping, 'add_tie_in_point', { tag, position, direction, dn: 100, endType: 'BW' });
      piping = result.document;
      return result.affected[0] as string;
    };
    const p1 = tie('DR-1', [0, 0, 0], [1, 0, 0]);
    const p2 = tie('DR-2', [3000, 2000, 1000], [0, 0, -1]);
    const line = ok(piping, 'create_pipeline', { service: 'CW', sequence: '8101', spec: 'CS150', dn: 100 });
    const routed = ok(line.document, 'auto_route_pipe', { lineId: line.affected[0], from: { portId: p1 }, to: { portId: p2 } });
    const runId = routed.affected[0] as string;
    const profiled = apply(routed.document, 'define_colour_profile', {
      id: 'svc',
      name: 'svc',
      rules: [{ id: 'cw', when: { property: 'service', equals: 'cw' }, colour: '#0000ff', legend: 'cw' }],
    });
    // The run derives one entity per part (<runId>/<kind>-<k>); each resolves to its run's line and takes the service colour.
    const parts = routed.document.plant?.piping?.entityIds[runId] ?? [];
    expect(parts.length).toBeGreaterThan(0);
    const runReport = data<Report>(profiled, 'colour_by_rule_report', { profileId: 'svc', groupBy: 'entity', entityIds: parts });
    expect(Object.keys(runReport.groups).sort()).toEqual([...parts].sort());
    for (const part of parts) expect(runReport.groups[part]).toMatchObject({ ruleId: 'cw', count: 1 });
  });
});
