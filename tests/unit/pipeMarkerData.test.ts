import { describe, expect, it } from 'vitest';
import { markerMatrices, MAX_LABELS, parsePipeMarkers } from '@ui/viewport/3d/pipeMarkers/pipeMarkerData';

const run = (id: string, rule: unknown, n = 3): unknown => ({
  id,
  rule,
  markers: Array.from({ length: n }, (_, i) => ({ positionMm: [i * 1000, 0, 500], tangent: [1, 0, 0], atMm: i * 1000 })),
});

describe('parsePipeMarkers', () => {
  it('reads placements with the field colour and one label per lettered run, at its middle marker', () => {
    const scene = parsePipeMarkers({
      runs: [
        run('a', { fieldHex: '#112233', markerLetters: 'CW', letterHex: '#ffffff' }),
        run('b', { fieldHex: '#445566', markerLetters: null }),
      ],
    });
    expect(scene.markers).toHaveLength(6);
    expect(scene.markers[0]).toMatchObject({ colour: '#112233', tangent: [1, 0, 0] });
    expect(scene.labels).toEqual([{ runId: 'a', positionMm: [1000, 0, 500], letters: 'CW', colour: '#ffffff' }]);
  });

  it('skips runs without a rule or colour, and malformed placements', () => {
    const scene = parsePipeMarkers({
      runs: [
        run('none', null),
        run('bad', { fieldHex: 'red' }),
        { id: 'x', rule: { fieldHex: '#000000' }, markers: [{ positionMm: [1, 2], tangent: [1, 0, 0] }, 4] },
      ],
    });
    expect(scene).toEqual({ markers: [], labels: [] });
  });

  it('answers nothing for a refusal or a non-object, caps the labels and defaults the letter colour', () => {
    expect(parsePipeMarkers(undefined)).toEqual({ markers: [], labels: [] });
    expect(parsePipeMarkers({ message: 'refused' })).toEqual({ markers: [], labels: [] });
    const many = Array.from({ length: MAX_LABELS + 20 }, (_, i) => run(`r${i}`, { fieldHex: '#000000', markerLetters: 'X' }, 1));
    expect(parsePipeMarkers({ runs: many }).labels).toHaveLength(MAX_LABELS);
    const odd = parsePipeMarkers({ runs: [run('d', { fieldHex: '#000000', markerLetters: 'X', letterHex: 'no' }, 1)] });
    expect(odd.labels[0]?.colour).toBe('#ffffff');
  });
});

describe('markerMatrices', () => {
  it('places the arrow base at the placement in document units and turns +Y onto the tangent', () => {
    const m = Array.from(markerMatrices([{ positionMm: [2000, 0, 500], tangent: [1, 0, 0], colour: '#000000' }], 1000, 100));
    expect(m.slice(12, 16)).toEqual([2, 0, 0.5, 1]);
    // local +Y (second column) maps to +X, scaled by length / mmPerUnit = 0.1
    expect(m[4]).toBeCloseTo(0.1, 5);
    expect(m[5]).toBeCloseTo(0, 5);
    expect(m[6]).toBeCloseTo(0, 5);
  });

  it('handles the opposite direction and an empty list', () => {
    const m = markerMatrices([{ positionMm: [0, 0, 0], tangent: [0, -1, 0], colour: '#000000' }], 1, 100);
    expect(m[5]).toBeCloseTo(-100, 4);
    expect(markerMatrices([], 1)).toHaveLength(0);
  });
});
