import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PipeMarker } from '@core/model/display';
import { markerMatrices, parsePipeColours, storedMarkerScene } from '@ui/viewport/3d/pipeMarkers/pipeMarkerData';
import { apply } from '../helpers/commandAssertions';

const run = (doc: CadDocument, points: number[][], dn: number, line: string): CadDocument =>
  apply(doc, 'add_pipe_run', { points, dn, line, service: 'cooling water' });

const stored = (doc: CadDocument): PipeMarker[] => Object.values(doc.display?.pipeMarkers ?? {}) as PipeMarker[];
const pipeIds = (doc: CadDocument): string[] =>
  Object.values(doc.building?.elements ?? {})
    .filter((element) => element.category === 'pipe')
    .map((element) => element.id);

describe('storedMarkerScene on markers placed by add_pipe_markers', () => {
  // elbow (CW-101: +X then +Y) and a straight pipe (IA-102) beside it
  let doc = run(
    createEmptyDocument(),
    [
      [0, 0, 3000],
      [20000, 0, 3000],
      [20000, 5000, 3000],
    ],
    100,
    'CW-101',
  );
  doc = run(
    doc,
    [
      [0, 600, 3000],
      [3000, 600, 3000],
    ],
    50,
    'IA-102',
  );
  const [cw, ia] = pipeIds(doc) as [string, string];
  doc = apply(doc, 'add_pipe_markers', {});
  const colours = new Map<string, string | null>([
    [cw, '#112233'],
    [ia, null],
  ]);
  const scene = storedMarkerScene(stored(doc), colours);

  it('one arrow per marker, at the stored position, along the stored tangent, as long as the A13.1 field (straight run)', () => {
    expect(scene.markers).toHaveLength(stored(doc).length);
    const straight = scene.markers.filter((marker) => marker.tangent[0] === 1 && marker.positionMm[1] === 600);
    expect(straight.length).toBeGreaterThan(0);
    for (const marker of straight) {
      expect(marker.positionMm[2]).toBe(3000);
      expect(marker.lengthMm).toBeGreaterThan(200);
    }
  });

  it('the elbow has a bend marker and an arrow at the corner', () => {
    expect(stored(doc).some((marker) => marker.pipeId === cw && marker.reason === 'bend')).toBe(true);
    expect(scene.markers.some((marker) => marker.tangent[0] === 1 && marker.positionMm[0] === 20000 && marker.positionMm[1] === 0)).toBe(
      true,
    );
  });

  it('colours by pipe (rule colour, neutral grey without a rule); orphans are not drawn', () => {
    expect(new Set(scene.markers.map((marker) => marker.colour))).toEqual(new Set(['#112233', '#c8d0dc']));
    expect(storedMarkerScene(stored(doc), new Map([[ia, null]])).markers.every((marker) => marker.positionMm[1] === 600)).toBe(true);
    expect(storedMarkerScene(stored(doc), new Map()).markers).toEqual([]);
  });

  it('draws two half-length opposite arrows for a bidirectional marker and a label at the letter height', () => {
    const base = stored(doc)[0] as PipeMarker;
    const both = storedMarkerScene(
      [{ ...base, bidirectional: true, letters: 'CW', letterHex: '#ffffff', fieldLengthMm: 400, letterHeightMm: 20 }],
      new Map([[base.pipeId, '#000000']]),
    );
    expect(both.markers.map((marker) => marker.lengthMm)).toEqual([200, 200]);
    const [a, b] = both.markers;
    expect(a?.tangent[0]).toBeCloseTo(-(b?.tangent[0] ?? 0), 9);
    expect(a?.tangent[1]).toBeCloseTo(-(b?.tangent[1] ?? 0), 9);
    expect(both.labels).toEqual([{ runId: base.pipeId, positionMm: [...base.positionMm], letters: 'CW', colour: '#ffffff', heightMm: 20 }]);
  });

  it('writes one instance matrix per arrow, scaled by its own length', () => {
    const m = markerMatrices([{ positionMm: [0, 0, 0], tangent: [1, 0, 0], colour: '#000000', lengthMm: 500 }], 1000);
    expect(m[4]).toBeCloseTo(0.5, 5);
    expect(markerMatrices(scene.markers, 1)).toHaveLength(scene.markers.length * 16);
  });
});

describe('parsePipeColours', () => {
  it('maps pipe ids to their field colour, null without a rule, and ignores a refusal', () => {
    const answer = { runs: [{ id: 'a', rule: { fieldHex: '#abcdef' } }, { id: 'b', rule: null }, { rule: {} }] };
    expect(parsePipeColours(answer)).toEqual(
      new Map([
        ['a', '#abcdef'],
        ['b', null],
      ]),
    );
    expect(parsePipeColours(undefined)).toEqual(new Map());
  });
});
