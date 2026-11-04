/**
 * Plant 09 VIS-FU (TR-VIS-04, §5.7): `add_pipe_markers` / `check_pipe_markers`. Legend size rows (incl. the gaps and the covering), the placement rule (a marker within 600 mm
 * of each valve, flanged joint and direction change; interval between), stored form, replace-on-rerun, refusals, purity, replay, save / load.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PipeMarker } from '@core/model/display';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { legendFor } from '@aec/plant/display/markerLegend';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { valveScene } from '../piping/rteFixtures';
import { addPipe, libraryDocument } from '../data/dataFixtures';

interface Added {
  markers: number;
  pipes: number;
  perPipe: Array<{ id: string; markers: number; row: string; fieldLengthMm: number; letterHeightMm: number; bandInterpolated: boolean }>;
  interpolated: string[];
}
interface Checked {
  status: string;
  rows: Array<{ id: string; markers: number; legendCurrent: boolean; missingAt: Array<{ atMm: number; reason: string }> }>;
  orphans: string[];
  unknown: string[];
}

const pipes = (): { doc: CadDocument; cw: string; ia: string } => {
  let doc = apply(createEmptyDocument(), 'add_pipe_run', {
    points: [
      [0, 0, 3000],
      [20000, 0, 3000],
      [20000, 5000, 3000],
    ],
    dn: 100,
    line: 'CW-101',
    service: 'cooling water',
  });
  doc = apply(doc, 'add_pipe_run', {
    points: [
      [0, 600, 3000],
      [3000, 600, 3000],
    ],
    dn: 50,
    line: 'IA-102',
    service: 'compressed air',
  });
  const ids = Object.values(doc.building?.elements ?? {})
    .filter((element) => element.category === 'pipe')
    .map((element) => element.id);
  return { doc, cw: ids[0] as string, ia: ids[1] as string };
};
const markersOf = (doc: CadDocument, pipeId?: string): PipeMarker[] =>
  (Object.values(doc.display?.pipeMarkers ?? {}) as PipeMarker[]).filter((marker) => pipeId === undefined || marker.pipeId === pipeId);
const close = (a: number, b: number, tolerance = 1): boolean => Math.abs(a - b) <= tolerance;

describe('A13.1 legend size (§5.7 examples)', () => {
  it.each([
    [26.9, 0, '0.75-1.25', 203.2, 12.7, false],
    [33.7, 0, '1.5-2', 203.2, 19.05, true],
    [60.3, 0, '2.5-6', 304.8, 31.75, true],
    [114.3, 0, '2.5-6', 304.8, 31.75, false],
    [114.3, 50, '8-10', 609.6, 63.5, false],
    [168.3, 0, '8-10', 609.6, 63.5, true],
    [273.1, 0, '>10', 812.8, 88.9, false],
    [10, 0, '0.75-1.25', 203.2, 12.7, true],
  ])('OD %s mm + %s mm covering -> row %s', (od, insulation, row, field, letters, interpolated) => {
    expect(legendFor(od, insulation)).toEqual({ row, fieldLengthMm: field, letterHeightMm: letters, bandInterpolated: interpolated });
  });
});

describe('add_pipe_markers on building pipes', () => {
  it('stores the direction change and interval markers, the legend size of each pipe, and names the interpolated rows', () => {
    const scene = pipes();
    const out = execute(scene.doc, 'add_pipe_markers', {});
    expect(out.rejected).toBeUndefined();
    expect(out.affected.sort()).toEqual([scene.cw, scene.ia].sort());
    const cw = markersOf(out.document, scene.cw);
    expect(cw.map((marker) => [marker.reason, Math.round(marker.atMm)])).toEqual([
      ['interval', 6667],
      ['interval', 13333],
      ['bend', 20000],
    ]);
    expect(cw[2]?.positionMm).toEqual([20000, 0, 3000]);
    expect(cw.every((marker) => marker.fieldLengthMm === 304.8 && marker.letterHeightMm === 31.75 && !marker.bandInterpolated)).toBe(true);
    expect(cw.map((marker) => marker.id)).toEqual([`${scene.cw}:1`, `${scene.cw}:2`, `${scene.cw}:3`]);
    const ia = markersOf(out.document, scene.ia);
    expect(ia).toHaveLength(1);
    expect(ia[0]).toMatchObject({ reason: 'interval', atMm: 1500, bandInterpolated: true });
    const result = out.data as Added;
    expect(result).toMatchObject({ markers: 4, pipes: 2, interpolated: [scene.ia] });
    expect(out.summary).toContain('VIS_MARKER_BAND_INTERPOLATED');
    expect(out.summary).toContain('no penetration');
  });

  it('takes the legend letters from the profile rule of the service, insulation sizes the row, spacing changes the count', () => {
    const scene = pipes();
    const profiled = apply(scene.doc, 'apply_service_colour_scheme', {
      scheme: 'asme_a13_1',
      profileId: 'svc',
      serviceMap: { 'cooling water': 'water' },
      activate: true,
      markerLetters: true,
    });
    const out = apply(profiled, 'add_pipe_markers', { ids: [scene.cw], insulationMm: 50, spacingMm: 5000 });
    const cw = markersOf(out, scene.cw);
    expect(cw.every((marker) => marker.letters === 'COOLING WATER' && marker.fieldLengthMm === 609.6)).toBe(true);
    expect(cw.filter((marker) => marker.reason === 'interval')).toHaveLength(3);
    expect(markersOf(out, scene.ia)).toEqual([]);
  });

  it('replaces the markers of a pipe on a rerun, keeps the others, and is deterministic', () => {
    const scene = pipes();
    const first = apply(scene.doc, 'add_pipe_markers', {});
    const again = apply(first, 'add_pipe_markers', { ids: [scene.cw], spacingMm: 3000 });
    expect(markersOf(again, scene.cw).length).toBeGreaterThan(3);
    expect(markersOf(again, scene.ia)).toEqual(markersOf(first, scene.ia));
    expect(apply(scene.doc, 'add_pipe_markers', {})).toEqual(first);
  });

  it('is pure, survives save / load validation and a replay of the history', () => {
    const scene = pipes();
    const before = structuredClone(scene.doc);
    const out = execute(scene.doc, 'add_pipe_markers', {});
    expect(scene.doc).toEqual(before);
    expect(validateDocumentValues(JSON.parse(JSON.stringify(out.document)) as Record<string, unknown>)).toEqual([]);
    expect(execute(out.document, 'replay_history', {}).document.display?.pipeMarkers).toEqual(out.document.display?.pipeMarkers);
  });

  it('refuses unknown ids, an unknown profile, prototype names; nothing selected is a no-op; more than 5000 markers is refused', () => {
    const scene = pipes();
    expectRefusal(scene.doc, 'add_pipe_markers', { ids: ['nope'] }, 'VIS_MARKER_NOT_FOUND', 'ids');
    expectRefusal(scene.doc, 'add_pipe_markers', { ids: ['constructor'] }, 'CMD_RESERVED_ID');
    expectRefusal(scene.doc, 'add_pipe_markers', { profileId: 'missing' }, 'VIS_PROFILE_NOT_FOUND', 'profileId');
    expectRefusal(scene.doc, 'add_pipe_markers', { spacingMm: 1 }, 'VIS_MARKER_LIMIT', 'spacingMm');
    const none = execute(scene.doc, 'add_pipe_markers', { lines: ['XX-999'] });
    expect(none.document).toBe(scene.doc);
    expect(none.affected).toEqual([]);
    expect(execute(scene.doc, 'add_pipe_markers', { scheme: 'iso_14726' }).rejected).toBe(true);
    expect(execute(scene.doc, 'add_pipe_markers', { spacingMm: -1 }).rejected).toBe(true);
  });
});

describe('both-ways arrow', () => {
  it('is set when the plant data line object of the pipe is flagged bidirectional, and only then', () => {
    let doc = apply(libraryDocument(), 'define_plant_class', {
      name: 'TwoWayLine',
      parent: 'ProcessLine',
      properties: [{ name: 'bidirectional', type: 'boolean' }],
    });
    const pipe = addPipe(doc, { dn: 100 });
    const assign = (bidirectional: boolean): CadDocument =>
      apply(pipe.doc, 'assign_plant_object', {
        target: pipe.id,
        className: 'TwoWayLine',
        hierarchy: 'U10',
        tagFields: { nominalSize: 100, fluidCode: 'P', seq: 7, spec: 'A1A' },
        properties: { bidirectional },
      });
    doc = apply(assign(true), 'add_pipe_markers', {});
    expect(markersOf(doc, pipe.id).every((marker) => marker.bidirectional)).toBe(true);
    expect(markersOf(apply(assign(false), 'add_pipe_markers', {}), pipe.id).every((marker) => !marker.bidirectional)).toBe(true);
    expect(markersOf(apply(pipe.doc, 'add_pipe_markers', {}), pipe.id).every((marker) => !marker.bidirectional)).toBe(true);
  });
});

describe('add_pipe_markers on a routed run with a valve (02 RTE)', () => {
  const scene = valveScene();
  const out = apply(scene.doc, 'add_pipe_markers', { ids: [scene.runId] });
  const marks = markersOf(out, scene.runId);

  it('puts one marker on the valve, none on its flanges (within 600 mm), one on the nozzle flanges at the run ends, and one on each elbow', () => {
    const valve = marks.filter((marker) => marker.reason === 'valve');
    expect(valve).toHaveLength(1);
    expect(close(valve[0]?.atMm ?? 0, 800)).toBe(true);
    const flanges = marks.filter((marker) => marker.reason === 'flange');
    expect(flanges.length).toBeGreaterThan(0);
    expect(flanges.every((marker) => Math.abs(marker.atMm - 800) > 600)).toBe(true);
    expect(marks.map((marker) => [marker.reason, Math.round(marker.atMm)])).toEqual([
      ['flange', 0],
      ['valve', 800],
      ['bend', 1500],
      ['bend', 4500],
      ['bend', 7500],
      ['bend', 9000],
      ['flange', 12000],
    ]);
    expect(marks.map((marker) => marker.atMm)).toEqual([...marks.map((marker) => marker.atMm)].sort((a, b) => a - b));
  });

  it('check_pipe_markers passes on the stored placement and lists what a missing valve marker costs', () => {
    expect(data<Checked>(out, 'check_pipe_markers', { ids: [scene.runId] })).toMatchObject({
      status: 'pass',
      rows: [{ markers: marks.length, missingAt: [] }],
    });
    const valveId = marks.find((marker) => marker.reason === 'valve')?.id as string;
    const { [valveId]: _dropped, ...rest } = out.display?.pipeMarkers ?? {};
    const lacking: CadDocument = { ...out, display: { ...(out.display as NonNullable<CadDocument['display']>), pipeMarkers: rest } };
    const found = data<Checked>(lacking, 'check_pipe_markers', { ids: [scene.runId] });
    expect(found.status).toBe('warn');
    expect(found.rows[0]?.missingAt.map((item) => item.reason)).toEqual(['flange', 'valve']);
  });
});

describe('check_pipe_markers', () => {
  it('a pipe with no marker lacks its interval marker; a long stretch lacks one in the middle; a resized pipe has a stale legend', () => {
    const scene = pipes();
    const bare = data<Checked>(scene.doc, 'check_pipe_markers', {});
    expect(bare.status).toBe('warn');
    expect(bare.rows.map((row) => row.missingAt.map((item) => item.reason))).toEqual([['interval', 'bend'], ['interval']]);
    const stored = apply(scene.doc, 'add_pipe_markers', {});
    expect(data<Checked>(stored, 'check_pipe_markers', {}).status).toBe('pass');
    expect(data<Checked>(stored, 'check_pipe_markers', { spacingMm: 3000 }).rows[0]?.missingAt.length).toBeGreaterThan(0);
    const covered = data<Checked>(stored, 'check_pipe_markers', { insulationMm: 50 });
    expect(covered.rows.every((row) => !row.legendCurrent)).toBe(true);
    expect(covered.status).toBe('warn');
  });

  it('reports markers whose pipe is gone, unknown ids and the lines filter; is read-only', () => {
    const scene = pipes();
    const stored = apply(scene.doc, 'add_pipe_markers', {});
    const removed = apply(stored, 'delete_building_element', { elementIds: [scene.ia] });
    const result = data<Checked>(removed, 'check_pipe_markers', {});
    expect(result.orphans).toEqual([`${scene.ia}:1`]);
    expect(result.status).toBe('warn');
    expect(data<Checked>(stored, 'check_pipe_markers', { ids: ['nope'] }).unknown).toEqual(['nope']);
    expect(data<Checked>(stored, 'check_pipe_markers', { lines: ['CW-101'] }).rows).toHaveLength(1);
    const before = structuredClone(stored);
    expect(execute(stored, 'check_pipe_markers', {}).document).toBe(stored);
    expect(stored).toEqual(before);
  });
});

describe('hostile display.pipeMarkers on load', () => {
  const scene = apply(pipes().doc, 'add_pipe_markers', {});
  const first = Object.values(scene.display?.pipeMarkers ?? {})[0] as PipeMarker;
  const withMarkers = (markers: unknown): unknown => ({ ...scene, display: { ...scene.display, pipeMarkers: markers } });

  it.each([
    ['a non-record', []],
    ['a reserved id', { __proto__: first, ['constructor']: first }],
    ['a wrong key', { other: first }],
    ['a bad reason', { [first.id]: { ...first, reason: 'x' } }],
    ['a bad position', { [first.id]: { ...first, positionMm: [1, 2] } }],
    ['a missing flag', { [first.id]: { ...first, bidirectional: 'no' } }],
  ])('refuses %s', (_name, markers) => {
    expect(validateDocumentValues(JSON.parse(JSON.stringify(withMarkers(markers))) as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});
