/**
 * Plant 02 RTE V1: trimmed elbows and pipe bends for turns no spec angle fits. Hand calculations from the CS150 stub: NPS 4 LR 90 elbow A = R = 152, NPS 4 OD 114.3,
 * tangent length c = R tan(turn / 2): 60 deg -> 152 tan 30 = 87.757241; a 500 mm bend -> 500 tan 30 = 288.675135.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { createSpecLookup, isMiss } from '@aec/plant/piping/specLookup';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Line } from './rteFixtures';
import { smallBoreDocument } from './smallBoreFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const TAN30 = Math.tan(Math.PI / 6);

/** A 60 degree turn: +X 3000, then 2000 along (cos 60, sin 60, 0). */
const SIXTY = [
  { direction: '+X', length: 3000 },
  { direction: [0.5, Math.sqrt(3) / 2, 0], length: 2000 },
];

const allowTrimmed = (doc: CadDocument): CadDocument =>
  apply(doc, 'edit_pipe_spec', {
    specId: 'CS150',
    ops: [{ op: 'setHeader', fields: { elbowAngles: { anglesDeg: [90, 45], toleranceDeg: 1, trimmedAllowed: true } } }],
  });

const withBendD = (doc: CadDocument, bendRadiusD: number): CadDocument =>
  apply(doc, 'edit_pipe_spec', {
    specId: 'CS150',
    ops: [{ op: 'setHeader', fields: { elbowAngles: { anglesDeg: [90, 45], toleranceDeg: 1, trimmedAllowed: false, bendRadiusD } } }],
  });

interface RouteData {
  runId: string;
  pipePieces: Array<{ cutLengthMm: number }>;
  turns: Array<{ kind: string; fitting: string; centreToEnd: number; turnDeg: number; nominalDeg: number; deviationDeg: number }>;
  counts: Record<string, number>;
  centrelineLengthMm: number;
  warnings: Array<{ code: string; ids: string[]; detail: Record<string, unknown> }>;
}

const route = (doc: CadDocument, lineId: string, extra: Record<string, unknown> = {}): ReturnType<typeof ok> =>
  ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0], direction: [1, 0, 0] }, legs: SIXTY, ...extra });

describe('a 60 degree turn on the CS150 spec', () => {
  const line = cs150Line(100, '4001');

  it('is refused while the spec allows neither trimmed elbows nor bends, and the refusal says what to set', () => {
    const refused = expectRefusal(
      line.doc,
      'route_pipe',
      { lineId: line.lineId, from: { point: [0, 0, 0], direction: [1, 0, 0] }, legs: SIXTY },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
    expect(refused.summary).toContain('trimmedAllowed');
    expect(refused.error?.detail).toMatchObject({ trimmedAllowed: false, bendRadiusD: null });
  });

  it('becomes a trimmed 90 LR elbow when the spec allows it: c = 152 tan 30 = 87.757241, pieces 2912.242759 / 1912.242759', () => {
    const doc = allowTrimmed(line.doc);
    const result = route(doc, line.lineId);
    const data1 = result.data as RouteData;
    expect(data1.pipePieces[0]?.cutLengthMm).toBeCloseTo(3000 - 152 * TAN30, 6);
    expect(data1.pipePieces[1]?.cutLengthMm).toBeCloseTo(2000 - 152 * TAN30, 6);
    expect(data1.turns[0]).toMatchObject({
      kind: 'trimmed',
      fitting: 'elbow90LRTrimmed',
      nominalDeg: expect.closeTo(60, 9),
      deviationDeg: 0,
    });
    expect(data1.turns[0]?.centreToEnd).toBeCloseTo(87.757241, 6);
    expect(data1.counts).toMatchObject({ elbow90LRTrimmed: 1, buttWelds: 2, pipePieces: 2 });
    // centreline: 5000 - 2 x 87.757241 + 152 x pi / 3 = 4983.659541
    expect(data1.centrelineLengthMm).toBeCloseTo(4983.659541, 5);
  });

  it('raises RTE_NONSTANDARD_FITTING in the route data and in check_piping (warning, status warn)', () => {
    const doc = allowTrimmed(line.doc);
    const result = route(doc, line.lineId);
    const warning = (result.data as RouteData).warnings.find((entry) => entry.code === 'RTE_NONSTANDARD_FITTING');
    expect(warning?.detail).toMatchObject({ kind: 'trimmed', turnDeg: expect.closeTo(60, 9) });
    expect(warning?.detail['radiusMm']).toBe(152);
    const check = data<{ status: string; issues: Array<{ code: string; severity: string; ids: string[]; remediation: string }> }>(
      result.document,
      'check_piping',
      {},
    );
    const issue = check.issues.find((entry) => entry.code === 'RTE_NONSTANDARD_FITTING');
    expect(issue).toMatchObject({ severity: 'warning' });
    expect(issue?.ids[0]).toMatch(/\/elbow-1$/);
    expect(issue?.remediation).toContain('reviewer');
  });

  it('a trimmed elbow only takes turns up to 90 degrees: 120 degrees is refused with the hint to use a bend', () => {
    const doc = allowTrimmed(line.doc);
    const refused = expectRefusal(
      doc,
      'route_pipe',
      {
        lineId: line.lineId,
        from: { point: [0, 0, 0], direction: [1, 0, 0] },
        legs: [
          { direction: '+X', length: 3000 },
          { direction: [-0.5, Math.sqrt(3) / 2, 0], length: 2000 },
        ],
      },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
    expect(refused.summary).toContain('up to 90 degrees');
  });

  it('a run bendRadius gives a pipe bend (R 500): tangent 288.675135, pieces 2711.324865 / 1711.324865, developed length 523.598776', () => {
    const result = route(line.doc, line.lineId, { bendRadius: 500 });
    const out = result.data as RouteData;
    const c = 500 * TAN30;
    expect(out.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([expect.closeTo(3000 - c, 6), expect.closeTo(2000 - c, 6)]);
    expect(out.turns[0]).toMatchObject({ kind: 'bend', fitting: 'pipeBend' });
    expect(out.counts).toMatchObject({ pipeBend: 1, buttWelds: 2 });
    expect(out.centrelineLengthMm).toBeCloseTo(5000 - 2 * c + (500 * Math.PI) / 3, 5);
    const warning = out.warnings.find((entry) => entry.code === 'RTE_NONSTANDARD_FITTING');
    expect(warning?.detail).toMatchObject({ kind: 'bend', radiusSource: 'run bendRadius', radiusMm: 500 });
    expect(warning?.detail['developedLengthMm']).toBeCloseTo((500 * Math.PI) / 3, 6);
    const takeoff = data<{ parts: Array<{ typeKey: string; radiusMm?: number; developedLengthMm?: number }> }>(
      result.document,
      'piping_takeoff',
      {},
    );
    const bend = takeoff.parts.find((part) => part.typeKey === 'pipeBend');
    expect(bend?.radiusMm).toBe(500);
    expect(bend?.developedLengthMm).toBeCloseTo(523.598776, 6);
  });

  it('a bend wins over a trimmed elbow when the run gives the radius', () => {
    const result = route(allowTrimmed(line.doc), line.lineId, { bendRadius: 500 });
    expect((result.data as RouteData).turns[0]?.kind).toBe('bend');
  });

  it('the spec bendRadiusD (5 x OD 114.3 = 571.5) makes bends without a run radius: tangent 329.955672', () => {
    const doc = withBendD(line.doc, 5);
    const out = route(doc, line.lineId).data as RouteData;
    const c = 571.5 * TAN30;
    expect(out.pipePieces[0]?.cutLengthMm).toBeCloseTo(3000 - c, 6);
    expect(out.warnings.find((entry) => entry.code === 'RTE_NONSTANDARD_FITTING')?.detail).toMatchObject({
      kind: 'bend',
      radiusSource: 'spec bendRadiusD x OD',
      radiusMm: 571.5,
    });
    const lookup = createSpecLookup(doc, 'CS150');
    expect(isMiss(lookup) ? null : lookup.elbowAngles().bendRadiusD).toBe(5);
  });

  it('standard turns stay catalogue elbows even with a bendRadius: a 90 degree turn is the LR elbow', () => {
    const result = ok(line.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      bendRadius: 500,
      legs: [
        { direction: '+X', length: 3000 },
        { direction: '+Y', length: 2000 },
      ],
    });
    expect((result.data as RouteData).turns[0]).toMatchObject({ kind: 'standard', fitting: 'elbow90LR', centreToEnd: 152 });
  });

  it('a bend tighter than one outside diameter is refused (R 50 < OD 114.3)', () => {
    expectRefusal(
      line.doc,
      'route_pipe',
      { lineId: line.lineId, from: { point: [0, 0, 0], direction: [1, 0, 0] }, legs: SIXTY, bendRadius: 50 },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
  });

  it('pipe bends are for butt-weld pipe only: plain-end (socket-weld) pipe refuses', () => {
    let doc = smallBoreDocument('spec_sw800.json');
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '7', spec: 'SW800', dn: 25 });
    expectRefusal(
      doc,
      'route_pipe',
      {
        lineId: piping(doc).lineOrder[0],
        from: { point: [0, 0, 0], direction: [1, 0, 0] },
        legs: [
          { direction: '+X', length: 1000 },
          { direction: [0.5, Math.sqrt(3) / 2, 0], length: 800 },
        ],
        bendRadius: 200,
      },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
  });
});

describe('persistence and edits keep the bend', () => {
  const line = cs150Line(100, '4002');
  const routed = route(line.doc, line.lineId, { bendRadius: 500 });
  const runId = (routed.data as RouteData).runId;

  it('bendRadiusMm is stored intent: a save / load re-derives the same bend; a non-positive radius is a value error on load', () => {
    const loaded = deserializeDocument(serializeDocument(routed.document));
    expect((piping(loaded).runs[runId] as PipeRun).bendRadiusMm).toBe(500);
    for (const id of Object.values(piping(routed.document).entityIds).flat())
      expect(loaded.entities[id]).toEqual(routed.document.entities[id]);
    const raw = JSON.parse(JSON.stringify(piping(routed.document))) as { runs: Record<string, { bendRadiusMm: number }> };
    (raw.runs[runId] as { bendRadiusMm: number }).bendRadiusMm = -5;
    expect(pipingErrors(raw)).toContain(`plant.piping.runs.${runId}.bendRadiusMm must be a positive radius (mm)`);
  });

  it('edit_route keeps the bend radius: stretching the first leg changes the cut and keeps the bend', () => {
    const edited = ok(routed.document, 'edit_route', { runId, op: 'stretch_leg', index: 1, length: 2500 });
    expect((piping(edited.document).runs[runId] as PipeRun).bendRadiusMm).toBe(500);
    const takeoff = data<{ pipePieces: Array<{ cutLengthMm: number }>; counts: Record<string, number> }>(
      edited.document,
      'piping_takeoff',
      { runId },
    );
    expect(takeoff.counts['pipeBend']).toBe(1);
    expect(takeoff.pipePieces[1]?.cutLengthMm).toBeCloseTo(2500 - 500 * TAN30, 6);
  });

  it('is pure: routing a bend leaves its input document untouched', () => {
    const before = JSON.stringify(line.doc);
    route(line.doc, line.lineId, { bendRadius: 500 });
    expect(JSON.stringify(line.doc)).toBe(before);
  });
});

describe('convert_pipe_run with a non-standard bend', () => {
  const bent = [
    [0, 0, 0],
    [3000, 0, 0],
    [3000 + 1000, 1000 * Math.sqrt(3), 0],
  ];
  const legacy = (doc: CadDocument): { doc: CadDocument; pipeId: string } => {
    const result = ok(doc, 'add_pipe_run', { points: bent, dn: 100, line: 'L-9', service: 'cooling water' });
    return { doc: result.document, pipeId: result.affected[0] as string };
  };

  it('a 60 degree bend has no spec elbow on CS150 (refused, vertex 1 listed) and converts once the spec allows trimmed elbows or bends', () => {
    const base = legacy(cs150Line(100, '4003').doc);
    expectRefusal(base.doc, 'convert_pipe_run', { pipeId: base.pipeId, spec: 'CS150' }, 'RTE_NO_FITTING_FOR_ANGLE');
    const trimmed = legacy(allowTrimmed(cs150Line(100, '4004').doc));
    const result = data<{ counts: Record<string, number> }>(trimmed.doc, 'convert_pipe_run', { pipeId: trimmed.pipeId, spec: 'CS150' });
    expect(result.counts['elbow90LRTrimmed']).toBe(1);
    const bends = legacy(withBendD(cs150Line(100, '4005').doc, 4));
    expect(
      data<{ counts: Record<string, number> }>(bends.doc, 'convert_pipe_run', { pipeId: bends.pipeId, spec: 'CS150' }).counts['pipeBend'],
    ).toBe(1);
  });
});
