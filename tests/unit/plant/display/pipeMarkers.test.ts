import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { profileProblems } from '@core/geometry/colourRules';
import { TOOLSETS } from '@protocol/toolsets';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { routedPumpToVessel } from '../piping/rteFixtures';

type Mark = { positionMm: number[]; tangent: number[]; atMm: number };
type Row = {
  id: string;
  kind: string;
  line: string | null;
  service: string | null;
  lengthMm: number;
  rule: Record<string, unknown> | null;
  markers: Mark[];
};
type Result = { spacingMm: number; profileId: string | null; runs: Row[]; skipped: unknown[]; markerCount: number };

const plant = (): CadDocument => {
  let doc = createEmptyDocument();
  doc = apply(doc, 'add_pipe_run', {
    points: [
      [0, 0, 3000],
      [20000, 0, 3000],
      [20000, 5000, 3000],
    ],
    dn: 100,
    line: 'CW-101',
    service: 'cooling water',
  });
  return apply(doc, 'add_pipe_run', {
    points: [
      [0, 600, 3000],
      [3000, 600, 3000],
    ],
    dn: 50,
    line: 'IA-102',
    service: 'compressed air',
  });
};

const withScheme = (doc: CadDocument, markerLetters: boolean | undefined): CadDocument =>
  apply(doc, 'apply_service_colour_scheme', {
    scheme: 'asme_a13_1',
    profileId: 'svc',
    serviceMap: { 'cooling water': 'water', 'compressed air': 'compressed_air' },
    activate: true,
    ...(markerLetters === undefined ? {} : { markerLetters }),
  });

describe('apply_service_colour_scheme markerLetters', () => {
  it('stores a typed marker on the rules only when asked, and keeps scheme.names to named colours', () => {
    const on = withScheme(plant(), true).display?.colourProfiles['svc']?.rules ?? [];
    expect(on[0]?.marker?.letters).toBe('COOLING WATER');
    expect(on[0]?.marker?.letterHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(on[0]?.scheme?.names).toEqual({ fieldColour: 'green', letterColour: 'white' });
    const off = withScheme(plant(), undefined).display?.colourProfiles['svc']?.rules ?? [];
    expect(off[0]?.marker).toBeUndefined();
  });

  it('ISO 14726 has no letter colour: letters only', () => {
    const doc = apply(plant(), 'apply_service_colour_scheme', {
      scheme: 'iso_14726',
      profileId: 'iso',
      serviceMap: { 'cooling water': 'fresh water' },
      markerLetters: true,
    });
    expect(doc.display?.colourProfiles['iso']?.rules[0]?.marker).toEqual({ letters: 'COOLING WATER' });
  });

  it('colour_by_rule_report rows carry only named-colour keys', () => {
    const report = data<{ groups: Record<string, Record<string, unknown>>; legend: Record<string, unknown>[] }>(
      withScheme(plant(), true),
      'colour_by_rule_report',
      { profileId: 'svc' },
    );
    for (const row of [...Object.values(report.groups), ...report.legend]) {
      expect(Object.keys(row).filter((key) => /marker|letterHex/i.test(key))).toEqual([]);
    }
  });

  it('refuses malformed markers and round-trips a valid one through load validation', () => {
    const doc = withScheme(plant(), true);
    expect(validateDocumentValues(JSON.parse(JSON.stringify(doc)))).toEqual([]);
    const profile = doc.display?.colourProfiles['svc'];
    const rule = profile?.rules[0];
    if (profile === undefined || rule === undefined) throw new Error('profile expected');
    const bad = (marker: unknown): CadDocument => ({
      ...doc,
      display: { colourProfiles: { svc: { ...profile, rules: [{ ...rule, marker } as typeof rule] } } },
    });
    for (const marker of [
      { letters: 5 },
      'x',
      { letters: 'A', letterHex: 7 },
      { letters: '' },
      { letters: 'x'.repeat(81) },
      { letters: 'A', letterHex: 'red' },
    ]) {
      expect(validateDocumentValues(JSON.parse(JSON.stringify(bad(marker)))).length, JSON.stringify(marker)).toBeGreaterThan(0);
    }
    expect(profileProblems({ defaultColour: 'entity', rules: [{ ...rule, marker: { letters: 'A', letterHex: 'red' } }] })[0]).toMatchObject(
      { code: 'VIS_COLOUR_INVALID' },
    );
    expect(
      execute(plant(), 'apply_service_colour_scheme', {
        scheme: 'asme_a13_1',
        profileId: 'long',
        serviceMap: { ['x'.repeat(90)]: 'water' },
        markerLetters: true,
      }).rejected,
    ).toBe(true);
  });
});

describe('pipe_markers', () => {
  it('spreads markers evenly along building pipes in the flow direction', () => {
    const result = data<Result>(plant(), 'pipe_markers', {});
    expect(result.spacingMm).toBe(7620);
    const [long, short] = result.runs as [Row, Row];
    expect(long.lengthMm).toBe(25000);
    expect(long.line).toBe('CW-101');
    expect(long.service).toBe('cooling water');
    expect(long.markers).toHaveLength(4);
    expect(long.markers.map((m) => m.atMm)).toEqual([3125, 9375, 15625, 21875]);
    expect(long.markers[0]).toMatchObject({ positionMm: [3125, 0, 3000], tangent: [1, 0, 0] });
    expect(long.markers[3]).toMatchObject({ positionMm: [20000, 1875, 3000], tangent: [0, 1, 0] });
    expect(short.markers).toHaveLength(1);
    expect(short.markers[0]?.positionMm).toEqual([1500, 600, 3000]);
    expect(result.markerCount).toBe(5);
    expect(long.rule).toBeNull();
    expect(result.profileId).toBeNull();
  });

  it('honours spacingMm, ids and lines filters', () => {
    const result = data<Result>(plant(), 'pipe_markers', { lines: ['IA-102'], spacingMm: 1000 });
    expect(result.runs.map((r) => r.line)).toEqual(['IA-102']);
    expect(result.markerCount).toBe(3);
  });

  it('returns the active profile colours and letters', () => {
    const doc = withScheme(plant(), true);
    const result = data<Result>(doc, 'pipe_markers', {});
    expect(result.profileId).toBe('svc');
    expect(result.runs[0]?.rule).toMatchObject({
      category: 'water',
      markerLetters: 'COOLING WATER',
      letterHex: expect.stringMatching(/^#/),
    });
    expect(result.runs[1]?.rule).toMatchObject({ category: 'compressed_air' });
    const plain = data<Result>(withScheme(plant(), false), 'pipe_markers', {});
    expect(plain.runs[0]?.rule).toMatchObject({ markerLetters: null, letterHex: null });
    const unmatched = data<Result>(doc, 'pipe_markers', { profileId: 'svc', lines: ['CW-101'] });
    expect(unmatched.runs).toHaveLength(1);
  });

  it('covers 02 RTE routed runs', () => {
    const { doc, runId } = routedPumpToVessel();
    const result = data<Result>(doc, 'pipe_markers', { ids: [runId], spacingMm: 2000 });
    const run = result.runs[0] as Row;
    expect(run.kind).toBe('run');
    expect(run.line).not.toBeNull();
    expect(run.markers.length).toBeGreaterThan(3);
    expect(run.markers.every((m) => Math.abs(Math.hypot(...(m.tangent as [number, number, number])) - 1) < 1e-2)).toBe(true);
  });

  it('is pure and deterministic', () => {
    const doc = plant();
    const before = JSON.stringify(doc);
    const first = execute(doc, 'pipe_markers', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.document).toBe(doc);
    expect(first.affected).toEqual([]);
    expect(execute(doc, 'pipe_markers', {}).data).toEqual(first.data);
  });

  it('refuses unknown ids, profiles and too many placements; an empty document answers with none', () => {
    expectRefusal(plant(), 'pipe_markers', { ids: ['nope'] }, 'VIS_MARKER_NOT_FOUND', 'ids');
    expectRefusal(plant(), 'pipe_markers', { profileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND', 'profileId');
    const started = Date.now();
    expectRefusal(plant(), 'pipe_markers', { spacingMm: 0.0001 }, 'VIS_MARKER_LIMIT', 'spacingMm');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(execute(plant(), 'pipe_markers', { spacingMm: -1 }).rejected).toBe(true);
    expect(data<Result>(createEmptyDocument(), 'pipe_markers', {}).markerCount).toBe(0);
  });

  it('is registered in the review toolset', () => {
    expect(TOOLSETS.review).toContain('pipe_markers');
  });
});
