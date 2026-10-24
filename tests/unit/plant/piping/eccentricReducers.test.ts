/**
 * Plant 02 RTE V1: eccentric reducers (flat side, offset of the centreline, effect on the adjacent leg). Hand calculations from the CS150 stub: NPS 6 OD 168.3,
 * NPS 4 OD 114.3 (offset e = (168.3 - 114.3) / 2 = 27), reducer length H = 140, NPS 4 LR 90 elbow A = 152.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel, RoutedPart } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface Scene {
  doc: CadDocument;
  lineId: string;
  tie: string;
}

/** A DN150 line with a butt-weld tie-in at the origin facing +X. */
function scene(): Scene {
  const line = cs150Line(150, '3001');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
  return { doc: tie.doc, lineId: line.lineId, tie: tie.id };
}

interface Route {
  runId: string;
  pipePieces: Array<{ cutLengthMm: number }>;
  counts: Record<string, number>;
  centrelineLengthMm: number;
  legs: Array<{ lengthMm: number }>;
}

interface Takeoff {
  pipePieces: Array<{ cutLengthMm: number; dn: number }>;
  legs: Array<{ lengthMm: number; end: number[] }>;
}

const takeoffOf = (doc: CadDocument, runId: string): Takeoff => data<Takeoff>(doc, 'piping_takeoff', { runId });

const eccentric = (flat: 'top' | 'bottom', centreDistance = 2000, dn2 = 100): Record<string, unknown> => ({
  type: 'reducerEccentric',
  tag: 'RE-1',
  dn2,
  flat,
  at: { leg: 0, centreDistance },
});

const riser = (s: Scene, flat: 'top' | 'bottom'): ReturnType<typeof ok> =>
  ok(s.doc, 'route_pipe', {
    lineId: s.lineId,
    from: { portId: s.tie },
    legs: [
      { direction: '+X', length: 4000 },
      { direction: '+Z', length: 1000 },
    ],
    inline: [eccentric(flat)],
  });

function partsOf(doc: CadDocument, runId: string): RoutedPart[] {
  const derived = deriveRun(doc, piping(doc).runs[runId] as PipeRun);
  expect(derived.ok).toBe(true);
  return derived.ok ? [...derived.parts] : [];
}

describe('eccentric reducer 6x4 flat on top (FOT) before a riser', () => {
  const s = scene();
  const result = riser(s, 'top');
  const route = result.data as Route;

  it('the DN100 axis rises e = 27 toward the flat: tops line up (84.15 both), the elbow centre is at z 27', () => {
    const parts = partsOf(result.document, route.runId);
    const reducer = parts.find((part) => part.kind === 'reducer');
    expect(reducer?.ports[0]?.position).toEqual([1930, 0, 0]);
    expect(reducer?.ports[1]?.position[0]).toBeCloseTo(2070, 9);
    expect(reducer?.ports[1]?.position[2]).toBeCloseTo(27, 9);
    expect(reducer?.typeKey).toBe('reducerEccentric');
    expect(reducer?.flatDirection).toEqual([0, 0, 1]);
    expect(reducer?.dims['offset']).toBeCloseTo(27, 9);
    const top150 = 168.3 / 2;
    const top100 = 27 + 114.3 / 2;
    expect(top100).toBeCloseTo(top150, 9);
    const elbow = parts.find((part) => part.kind === 'elbow');
    expect(elbow?.centre?.[2]).toBeCloseTo(27, 9);
    expect(elbow?.centre?.[0]).toBe(4000);
  });

  it('pieces: DN150 1930, DN100 4000 - 152 - 2070 = 1778, riser 1000 - (27 + 152) = 821', () => {
    expect(takeoffOf(result.document, route.runId).pipePieces.map((piece) => [piece.dn, piece.cutLengthMm])).toEqual([
      [150, 1930],
      [100, 1778],
      [100, 821],
    ]);
  });

  it('the riser starts 27 higher: legs 4000 and 973, centreline 4973 - 304 + 152 pi / 2 = 4907.761', () => {
    expect(route.legs.map((leg) => leg.lengthMm)).toEqual([4000, 973]);
    expect(takeoffOf(result.document, route.runId).legs[0]?.end[2]).toBeCloseTo(27, 9);
    expect(route.centrelineLengthMm).toBeCloseTo(4973 - 304 + (152 * Math.PI) / 2, 5);
    expect(route.counts).toMatchObject({ reducerEccentric: 1, elbow90LR: 1, buttWelds: 5 });
  });

  it('piping_takeoff reports the flat side and the offset of the reducer', () => {
    const takeoff = data<{ inline: Array<{ type: string; flat?: { label: string; offsetMm: number; direction: number[] } }> }>(
      result.document,
      'piping_takeoff',
      {},
    );
    const placed = takeoff.inline.find((item) => item.type === 'reducerEccentric');
    expect(placed?.flat).toMatchObject({ label: 'top', direction: [0, 0, 1] });
    expect(placed?.flat?.offsetMm).toBeCloseTo(27, 9);
  });

  it('the run has no open end besides the riser end and no clash with itself (valid graph through the offset)', () => {
    const check = data<{ counts: { byCode: Record<string, number> }; status: string }>(result.document, 'check_piping', {});
    expect(check.counts.byCode['RTE_OPEN_END']).toBe(1);
  });
});

describe('flat on bottom (FOB): bottoms line up', () => {
  const s = scene();
  const result = riser(s, 'bottom');
  const route = result.data as Route;

  it('the DN100 axis drops 27: bottoms at -84.15 both, the riser is 27 longer: elbow cut 1000 - (-27 + 152) = 875', () => {
    const parts = partsOf(result.document, route.runId);
    const reducer = parts.find((part) => part.kind === 'reducer');
    expect(reducer?.ports[1]?.position[2]).toBeCloseTo(-27, 9);
    expect(-27 - 114.3 / 2).toBeCloseTo(-168.3 / 2, 9);
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([1930, 1778, 875]);
    expect(route.legs.map((leg) => leg.lengthMm)).toEqual([4000, 1027]);
  });
});

describe('an expander (small to large) offsets the other way, and a reducer + expander pair cancels on the last leg', () => {
  it('DN150 -> DN100 -> DN150, both flat on bottom: the DN100 piece sits 27 lower, the run ends on the axis again', () => {
    const s = scene();
    const result = ok(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { portId: s.tie },
      legs: [{ direction: '+X', length: 5000 }],
      inline: [eccentric('bottom', 1000), { ...eccentric('bottom', 3000, 150), tag: 'RE-2' }],
    });
    const route = result.data as Route;
    expect(takeoffOf(result.document, route.runId).pipePieces.map((piece) => [piece.dn, piece.cutLengthMm])).toEqual([
      [150, 930],
      [100, 1860],
      [150, 1930],
    ]);
    const parts = partsOf(result.document, route.runId);
    const pipes = parts.filter((part) => part.kind === 'pipe');
    expect(pipes.map((pipe) => pipe.ports[0]?.position[2])).toEqual([0, -27, 0].map((z) => expect.closeTo(z, 9)));
    expect(pipes.at(-1)?.ports[1]?.position).toEqual([5000, 0, 0]);
  });
});

describe('refusals', () => {
  it('an offset the next leg cannot take (a turn along +Y after a flat-on-top reducer) is RTE_ECCENTRIC_OFFSET, document unchanged', () => {
    const s = scene();
    const refused = expectRefusal(
      s.doc,
      'route_pipe',
      {
        lineId: s.lineId,
        from: { portId: s.tie },
        legs: [
          { direction: '+X', length: 4000 },
          { direction: '+Y', length: 1000 },
        ],
        inline: [eccentric('top')],
      },
      'RTE_ECCENTRIC_OFFSET',
    );
    expect(refused.summary).toContain('next leg');
    expect(refused.error?.detail?.['angleDeg']).toBeCloseTo(90, 9);
    expect(refused.error?.detail?.['toleranceDeg']).toBe(1);
  });

  it('a reducer on the last leg leaves the offset with nothing to take it up: RTE_ECCENTRIC_OFFSET', () => {
    const s = scene();
    expectRefusal(
      s.doc,
      'route_pipe',
      { lineId: s.lineId, from: { portId: s.tie }, legs: [{ direction: '+X', length: 4000 }], inline: [eccentric('top')] },
      'RTE_ECCENTRIC_OFFSET',
    );
  });

  it('inserting one into a routed run that cannot take it is refused and the run stays as it was', () => {
    const s = scene();
    const routed = ok(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { portId: s.tie },
      legs: [
        { direction: '+X', length: 4000 },
        { direction: '+Y', length: 1000 },
      ],
    });
    const runId = (routed.data as Route).runId;
    expectRefusal(
      routed.document,
      'insert_inline_component',
      { runId, type: 'reducerEccentric', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 2000 } },
      'RTE_ECCENTRIC_OFFSET',
    );
    const fine = apply(routed.document, 'insert_inline_component', {
      runId,
      type: 'reducerEccentric',
      dn2: 100,
      flatDirection: [0, 1, 0],
      at: { leg: 0, centreDistance: 2000 },
    });
    // flat toward +Y: the DN100 axis moves +27 in Y, the +Y leg starts 27 further along itself
    const legs = data<{ legs: Array<{ lengthMm: number }> }>(fine, 'piping_takeoff', { runId }).legs;
    expect(legs.map((leg) => leg.lengthMm)).toEqual([4000, 973]);
  });

  it('flat is for eccentric reducers only, and an eccentric reducer needs exactly one of flat / flatDirection', () => {
    const s = scene();
    const routed = ok(s.doc, 'route_pipe', { lineId: s.lineId, from: { portId: s.tie }, legs: [{ direction: '+X', length: 4000 }] });
    const runId = (routed.data as Route).runId;
    const at = { leg: 0, centreDistance: 2000 };
    expectRefusal(
      routed.document,
      'insert_inline_component',
      { runId, type: 'reducerConcentric', dn2: 100, flat: 'top', at },
      'RTE_ECCENTRIC_INVALID',
    );
    expectRefusal(routed.document, 'insert_inline_component', { runId, type: 'reducerEccentric', dn2: 100, at }, 'RTE_ECCENTRIC_INVALID');
    expectRefusal(
      routed.document,
      'insert_inline_component',
      { runId, type: 'reducerEccentric', dn2: 100, flat: 'top', flatDirection: [0, 0, 1], at },
      'RTE_ECCENTRIC_INVALID',
    );
  });

  it('top / bottom on a vertical pipe is meaningless, and a flat direction along the pipe has no side', () => {
    const s = scene();
    const up = addTie(s.doc, 'B', [0, 5000, 0], [0, 0, 1], { dn: 150 });
    const routed = ok(up.doc, 'route_pipe', { lineId: s.lineId, from: { portId: up.id }, legs: [{ direction: '+Z', length: 4000 }] });
    const runId = (routed.data as Route).runId;
    const at = { leg: 0, centreDistance: 2000 };
    expectRefusal(
      routed.document,
      'insert_inline_component',
      { runId, type: 'reducerEccentric', dn2: 100, flat: 'top', at },
      'RTE_ECCENTRIC_INVALID',
    );
    expectRefusal(
      routed.document,
      'insert_inline_component',
      { runId, type: 'reducerEccentric', dn2: 100, flatDirection: [0, 0, 1], at },
      'RTE_ECCENTRIC_INVALID',
    );
  });

  it('is pure: the input document is untouched by a successful route with an eccentric reducer', () => {
    const s = scene();
    const before = JSON.stringify(s.doc);
    riser(s, 'top');
    expect(JSON.stringify(s.doc)).toBe(before);
  });

  it('is pure: inserting an eccentric reducer into a routed run leaves the input document untouched', () => {
    const s = scene();
    const routed = ok(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { portId: s.tie },
      legs: [
        { direction: '+X', length: 4000 },
        { direction: '+Z', length: 1000 },
      ],
    });
    const before = JSON.stringify(routed.document);
    ok(routed.document, 'insert_inline_component', {
      runId: (routed.data as Route).runId,
      type: 'reducerEccentric',
      dn2: 100,
      flat: 'top',
      at: { leg: 0, centreDistance: 2000 },
    });
    expect(JSON.stringify(routed.document)).toBe(before);
  });
});

describe('branches and persistence', () => {
  it('the flat side is stored intent: a save / load re-derives the same parts, and removing the reducer gives the plain legs back (4000, 1000)', () => {
    const routed = riser(scene(), 'top');
    const loaded = deserializeDocument(serializeDocument(routed.document));
    expect(piping(loaded).entityIds).toEqual(piping(routed.document).entityIds);
    for (const id of Object.values(piping(routed.document).entityIds).flat())
      expect(loaded.entities[id]).toEqual(routed.document.entities[id]);
    const run = piping(loaded).runs[(routed.data as Route).runId] as PipeRun;
    expect(run.inline?.[0]?.flatDirection).toEqual([0, 0, 1]);
    const removed = apply(loaded, 'remove_inline_component', { runId: run.id, componentId: run.inline?.[0]?.id });
    const back = deriveRun(removed, piping(removed).runs[run.id] as PipeRun);
    expect(back.ok && back.legs.map((leg) => leg.lengthMm)).toEqual([4000, 1000]);
  });

  it('a file whose flatDirection is zero, or sits on a component that is not an eccentric reducer, is a validation error', () => {
    const routed = riser(scene(), 'top');
    const runId = (routed.data as Route).runId;
    const corrupt = (patch: Record<string, unknown>): unknown => {
      const raw = JSON.parse(JSON.stringify(piping(routed.document))) as {
        runs: Record<string, { inline: Array<Record<string, unknown>> }>;
      };
      Object.assign(raw.runs[runId]?.inline[0] ?? {}, patch);
      return raw;
    };
    expect(pipingErrors(corrupt({}))).toEqual([]);
    for (const patch of [{ flatDirection: [0, 0, 0] }, { type: 'reducerConcentric' }])
      expect(pipingErrors(corrupt(patch))).toEqual([expect.stringContaining(`plant.piping.runs.${runId}.inline.0 `)]);
  });

  it('a stored flatDirection along the pipe derives the RTE_ECCENTRIC_INVALID refusal', () => {
    const routed = riser(scene(), 'top');
    const run = piping(routed.document).runs[(routed.data as Route).runId] as PipeRun;
    const inline = (run.inline ?? []).map((item) => ({ ...item, flatDirection: [1, 0, 0] as [number, number, number] }));
    const derived = deriveRun(routed.document, { ...run, inline });
    expect(derived.ok).toBe(false);
    expect(!derived.ok && derived.code).toBe('RTE_ECCENTRIC_INVALID');
  });

  it('a branch downstream of an eccentric reducer on the same leg is refused (its port would sit off the stored axis); before it is fine', () => {
    const s = scene();
    const routed = riser(s, 'top');
    const runId = (routed.data as Route).runId;
    const branch = (distance: number): Record<string, unknown> => ({
      runId,
      at: { leg: 0, distance },
      dn: 100,
      legs: [{ direction: '-Y', length: 500 }],
    });
    expectRefusal(routed.document, 'add_branch', branch(3000), 'RTE_BRANCH_ON_FITTING');
    ok(routed.document, 'add_branch', branch(1000));
  });
});

describe('on a graded (gravity) line: the invert step and the sloped leg', () => {
  const graded = (flat: 'top' | 'bottom'): { doc: CadDocument; runId: string } => {
    const base = scene();
    const line = apply(base.doc, 'create_pipeline', {
      service: 'D',
      sequence: '5001',
      spec: 'CS150',
      dn: 150,
      slope: { value: 1, unit: 'percent', fall: true },
    });
    const result = ok(line, 'route_pipe', {
      lineId: piping(line).lineOrder.at(-1),
      from: { portId: base.tie },
      legs: [
        { direction: '+X', planLength: 4000, slope: { value: 1, unit: 'percent', fall: true } },
        { direction: '-Z', length: 500 },
      ],
      inline: [eccentric(flat)],
    });
    return { doc: result.document, runId: (result.data as Route).runId };
  };

  it('flat on top steps the bottom up by 2e: RTE_POCKET (a gravity line holds liquid at the step); flat on bottom keeps it flush', () => {
    const top = graded('top');
    const check = data<{ issues: Array<{ code: string; detail: Record<string, unknown> }> }>(top.doc, 'check_piping', {});
    const pocket = check.issues.find((issue) => issue.code === 'RTE_POCKET' && issue.detail['kind'] === 'eccentric-invert-step');
    expect(pocket?.detail['flat']).toBe('top');
    expect(pocket?.detail['invertStepMm']).toBeCloseTo(27 * Math.cos(Math.atan(0.01)) + 27, 4);
    const bottom = graded('bottom');
    const flush = data<{ issues: Array<{ code: string; detail: Record<string, unknown> }> }>(bottom.doc, 'check_piping', {});
    expect(flush.issues.some((issue) => issue.detail['kind'] === 'eccentric-invert-step')).toBe(false);
  });

  it('the offset is perpendicular to the sloped pipe, so it is 0.573 deg off the vertical leg: taken up within the 1 deg tolerance, residual 27 sin(0.573 deg) = 0.27 mm reported', () => {
    const top = graded('top');
    const check = data<{ issues: Array<{ code: string; detail: Record<string, unknown> }> }>(top.doc, 'check_piping', {});
    const warning = check.issues.find((issue) => issue.code === 'RTE_ECCENTRIC_OFFSET');
    expect(warning?.detail['residualMm']).toBeCloseTo(27 * Math.sin(Math.atan(0.01)), 4);
    expect(warning?.detail['angleDeg']).toBeCloseTo((Math.atan(0.01) * 180) / Math.PI, 5);
    // the vertical leg is longer by the rise of the corner: 500 + 27 cos(atan 0.01)
    const legs = data<{ legs: Array<{ lengthMm: number }> }>(top.doc, 'piping_takeoff', { runId: top.runId }).legs;
    expect(legs[1]?.lengthMm).toBeCloseTo(500 + 27 * Math.cos(Math.atan(0.01)), 4);
  });
});
