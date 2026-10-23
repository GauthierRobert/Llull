/** `route_pipe` (02 RTE §4, §5.1-5.4): SC-RTE-01 end to end, deviations, refusals with stable codes, purity. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, pumpToVessel, routedPumpToVessel, SC01_LEGS, withoutSpecs } from './rteFixtures';

interface RouteData {
  runId: string;
  pis: Vec3[];
  closingLeg: { direction: string; length: number } | null;
  legs: Array<{ index: number; direction: string; lengthMm: number; cutLengthsMm: number[] }>;
  turns: Array<{ deviationDeg: number; centreToEnd: number; radius: number; turnDeg: number; nominalDeg: number }>;
  counts: Record<string, number>;
  pipePieces: Array<{ id: string; cutLengthMm: number; leg: number; dn: number }>;
  partIds: string[];
  totalPipeMm: number;
  centrelineLengthMm: number;
  studs: number;
  warnings: Array<{ code: string; ids: string[] }>;
  angleTolerance: { valueDeg: number; source: string };
  weldGap: { valueMm: number; defaulted: boolean };
  weldSpacing: { minimumMm: number };
  unverified: boolean;
  unverifiedReasons: string[];
  portDeviationDeg: { start: number | null; end: number | null };
  spec: { id: string; status: string };
}

type Joint = { id: string; kind: string; parts: string[]; gapMm: number; accessories?: string[] };
const jointsOf = (doc: CadDocument, runId: string): Joint[] => data<{ joints: Joint[] }>(doc, 'piping_takeoff', { runId }).joints;

describe('route_pipe: SC-RTE-01 pump P-101 to vessel V-101', () => {
  const s = routedPumpToVessel();
  const route = s.route as unknown as RouteData;

  it('adds the closing leg +X 3000 and stores only the points of intersection and the port references', () => {
    expect(route.closingLeg).toEqual({ direction: '+X', length: 3000 });
    expect(route.legs).toHaveLength(5);
    expect(route.pis).toEqual([
      [0, 0, 2500],
      [0, 3000, 2500],
      [3000, 3000, 2500],
      [3000, 3000, 4000],
    ]);
    const run = s.doc.plant?.piping?.runs[s.runId];
    expect(run?.start).toMatchObject({ point: [0, 0, 1000], ref: { kind: 'nozzle', nozzleId: 'N2' } });
    expect(run?.end).toMatchObject({ point: [6000, 3000, 4000], ref: { kind: 'nozzle', nozzleId: 'N1' } });
    expect(run?.pis).toEqual(route.pis);
    // Intent only: no parts or joints in the stored model.
    expect(run).not.toHaveProperty('parts');
    expect(run).not.toHaveProperty('joints');
    expect(run).not.toHaveProperty('broken');
  });

  it('cut lengths 1269 / 2696 / 2696 / 1196 / 2769, total 10 626, centreline 11 739.044 (VC-RTE-01, VC-RTE-03)', () => {
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([1269, 2696, 2696, 1196, 2769]);
    expect(route.pipePieces.map((piece) => piece.leg)).toEqual([0, 1, 2, 3, 4]);
    expect(route.totalPipeMm).toBeCloseTo(10626, 2);
    expect(route.centrelineLengthMm).toBeCloseTo(11739.044, 2);
    expect(route.legs.map((leg) => leg.lengthMm)).toEqual([1500, 3000, 3000, 1500, 3000]);
  });

  it('counts 4 elbows, 2 weld-neck flanges, 2 gaskets, 2 bolt sets (16 studs), 5 pieces, 10 butt welds, 2 flanged joints (VC-RTE-02)', () => {
    expect(route.counts).toMatchObject({
      elbow90LR: 4,
      flangeWeldNeck: 2,
      gasketSpiralWound: 2,
      boltSet: 2,
      studs: 16,
      pipePieces: 5,
      buttWelds: 10,
      flangedJoints: 2,
      fittingToFitting: 0,
    });
    expect(route.studs).toBe(16);
  });

  it('derives parts in route order with deterministic ids <runId>/<kind>-<k>; joints are numbered likewise', () => {
    const ids = s.doc.plant?.piping?.entityIds[s.runId] ?? [];
    const run = s.runId;
    expect(ids).toEqual(
      [
        'gasket-1',
        'flange-1',
        'pipe-1',
        'elbow-1',
        'pipe-2',
        'elbow-2',
        'pipe-3',
        'elbow-3',
        'pipe-4',
        'elbow-4',
        'pipe-5',
        'flange-2',
        'gasket-2',
      ].map((part) => `${run}/${part}`),
    );
    // The bolt sets are parts without geometry: listed in partIds, absent from the entities.
    expect(route.partIds).toEqual([
      `${run}/gasket-1`,
      `${run}/boltSet-1`,
      ...ids.slice(1, 11),
      `${run}/flange-2`,
      `${run}/boltSet-2`,
      `${run}/gasket-2`,
    ]);
    const joints = jointsOf(s.doc, s.runId);
    expect(joints.map((joint) => joint.id)).toEqual(Array.from({ length: 12 }, (_, i) => `${run}/joint-${i + 1}`));
    expect(joints[0]).toMatchObject({ kind: 'flanged', parts: [`${run}/flange-1`, 'P-101:N2'], gapMm: 3 });
    expect(joints[0]?.accessories).toEqual([`${run}/gasket-1`, `${run}/boltSet-1`]);
    expect(joints.at(-1)).toMatchObject({ kind: 'flanged', parts: [`${run}/flange-2`, 'V-101:N1'] });
    for (const id of ids) {
      expect(s.doc.entities[id]?.kind).toBe('revolution');
      expect(s.doc.order).toContain(id);
    }
    expect(s.doc.entities[s.runId]).toBeUndefined();
  });

  it('names the defaults it used and reports the trust of the result (AF-32)', () => {
    expect(route.weldGap).toEqual({ valueMm: 0, defaulted: true });
    expect(route.weldSpacing.minimumMm).toBe(50);
    expect(route.angleTolerance).toEqual({ valueDeg: 1, source: 'spec' });
    expect(route.portDeviationDeg).toEqual({ start: 0, end: 0 });
    expect(route.warnings).toEqual([]);
    expect(route.unverified).toBe(true);
    expect(route.unverifiedReasons[0]).toContain('draft');
    expect(route.unverifiedReasons[1]).toContain('CS150/E90-LR/100');
    expect(route.spec).toMatchObject({ id: 'CS150', status: 'draft' });
    expect(route.turns.every((turn) => turn.deviationDeg === 0 && turn.centreToEnd === 152)).toBe(true);
  });

  it('is deterministic: the same document and params give the same run, data and ids (VC-RTE-17)', () => {
    const again = routedPumpToVessel();
    expect(again.route).toEqual(s.route);
    expect(again.doc.plant).toEqual(s.doc.plant);
    expect(Object.keys(again.doc.entities)).toEqual(Object.keys(s.doc.entities));
  });

  it('saves without the parts and re-derives them on load, identical', () => {
    const loaded = deserializeDocument(serializeDocument(s.doc));
    const ids = s.doc.plant?.piping?.entityIds[s.runId] ?? [];
    expect(loaded.plant?.piping?.entityIds[s.runId]).toEqual(ids);
    for (const id of ids) expect(loaded.entities[id]).toEqual(s.doc.entities[id]);
  });

  it('the first call is a pure function of the document', () => {
    const base = pumpToVessel();
    const withLine = apply(base, 'create_pipeline', { service: 'P', sequence: '1001', spec: 'CS150', dn: 100 });
    const params = {
      lineId: withLine.plant?.piping?.lineOrder[0],
      from: { portId: 'P-101:N2' },
      to: { portId: 'V-101:N1' },
      legs: SC01_LEGS,
    };
    const before = structuredClone(withLine);
    execute(withLine, 'route_pipe', params);
    expect(withLine).toEqual(before);
  });
});

describe('route_pipe: butt-weld ports, open ends, tolerance', () => {
  it('routes between two BW tie-ins: butt welds to the ports, no flanges; the weld joints name the port', () => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
    const b = addTie(a.doc, 'B', [3000, 2000, 0], [0, -1, 0]);
    const result = ok(b.doc, 'route_pipe', {
      lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      legs: [{ direction: '+X', length: 3000 }],
    });
    const route = result.data as RouteData;
    expect(route.counts).toMatchObject({ pipePieces: 2, elbow90LR: 1, buttWelds: 4, flangedJoints: 0, studs: 0 });
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([2848, 1848]);
    const joints = jointsOf(result.document, route.runId);
    expect(joints[0]?.parts[0]).toBe(a.id);
    expect(joints.at(-1)?.parts[1]).toBe(b.id);
    expect(result.affected).toHaveLength(1);
  });

  it('an open end needs no port and no joint at that end; the angle tolerance override is named (source run)', () => {
    const { doc, lineId } = cs150Line();
    const result = ok(doc, 'route_pipe', {
      lineId,
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      legs: [{ direction: '+X', length: 2000 }],
      angleToleranceDeg: 2,
    });
    const route = result.data as RouteData;
    expect(route.angleTolerance).toEqual({ valueDeg: 2, source: 'run' });
    expect(jointsOf(result.document, route.runId)).toEqual([]);
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([2000]);
    expect(result.document.plant?.piping?.runs[route.runId]?.angleToleranceDeg).toBe(2);
  });

  it('a 89.427 degree turn takes the standard 90 elbow with the deviation reported (SC-RTE-04 geometry)', () => {
    const { doc, lineId } = cs150Line();
    const route = data<RouteData>(doc, 'route_pipe', {
      lineId,
      from: { point: [0, 0, 1000], direction: [1, 0, 0] },
      legs: [
        { direction: [1, 0, -0.01], length: 8000 },
        { direction: '-Z', length: 1000 },
      ],
    });
    expect(route.turns[0]?.deviationDeg).toBeCloseTo(0.572939, 5);
    expect(route.turns[0]?.turnDeg).toBeCloseTo(89.427061, 5);
    expect(route.portDeviationDeg.start).toBeCloseTo(0.572939, 5);
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([7848, 848]);
  });

  it('continues a run from its open end: the new run starts where the first ends', () => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
    const first = ok(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] });
    const firstId = first.affected[0] as string;
    const second = ok(first.document, 'route_pipe', {
      lineId,
      from: { portId: `${firstId}:end` },
      legs: [
        { direction: '+X', length: 1000 },
        { direction: '+Y', length: 1000 },
      ],
    });
    const route = second.data as RouteData;
    expect(jointsOf(second.document, route.runId)[0]).toMatchObject({
      kind: 'buttWeld',
      parts: [`${firstId}:end`, `${route.runId}/pipe-1`],
    });
    expect(route.pipePieces[0]?.cutLengthMm).toBe(848);
    expectRefusal(
      second.document,
      'route_pipe',
      { lineId, from: { portId: `${firstId}:end` }, legs: [{ direction: '+X', length: 500 }] },
      'RTE_PORT_IN_USE',
      'from.portId',
    );
  });

  it('warns of fitting-to-fitting (304 mm between NPS 4 elbows, no piece) and of weld spacing (340 mm, 36 mm piece)', () => {
    const { doc, lineId } = cs150Line();
    const legs = (middle: number): unknown[] => [
      { direction: '+X', length: 1000 },
      { direction: '+Y', length: middle },
      { direction: '+X', length: 1000 },
    ];
    const open = { lineId, from: { point: [0, 0, 0], direction: [1, 0, 0] } };
    const touchingResult = ok(doc, 'route_pipe', { ...open, legs: legs(304) });
    const touching = touchingResult.data as RouteData;
    expect(touching.pipePieces.map((piece) => piece.leg)).toEqual([0, 2]);
    expect(touching.warnings.map((warning) => warning.code)).toEqual(['RTE_FITTING_TO_FITTING']);
    expect(touching.counts['fittingToFitting']).toBe(1);
    expect(jointsOf(touchingResult.document, touching.runId).map((joint) => joint.kind)).toContain('fittingToFitting');
    const close = data<RouteData>(doc, 'route_pipe', { ...open, legs: legs(340) });
    expect(close.warnings.map((warning) => warning.code)).toEqual(['RTE_WELD_SPACING']);
    expect(close.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([848, 36, 848]);
  });
});

describe('route_pipe open-end directions', () => {
  const legs = [{ direction: '+Z', length: 1500 }];
  it.each([[[0, 0, 2]], [[0, 0, 0.5]]])('normalises %j before the port-direction rule and stores a unit vector', (direction) => {
    const { doc, lineId } = cs150Line();
    const result = ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0], direction }, legs });
    const run = result.document.plant?.piping?.runs[(result.data as RouteData).runId];
    expect(run?.start.direction).toEqual([0, 0, 1]);
    expect((result.data as RouteData).portDeviationDeg.start).toBe(0);
    const to = ok(doc, 'route_pipe', {
      lineId,
      from: { point: [0, 0, 0] },
      to: { point: [0, 0, 1500], direction: direction.map((v) => 0 - v) },
      legs,
    });
    expect(to.document.plant?.piping?.runs[(to.data as RouteData).runId]?.end.direction).toEqual([0, 0, -1]);
  });

  it('refuses a zero direction at from.direction / to.direction (RTE_INVALID_PORT)', () => {
    const { doc, lineId } = cs150Line();
    expectRefusal(
      doc,
      'route_pipe',
      { lineId, from: { point: [0, 0, 0], direction: [0, 0, 0] }, legs },
      'RTE_INVALID_PORT',
      'from.direction',
    );
    expectRefusal(
      doc,
      'route_pipe',
      { lineId, from: { point: [0, 0, 0] }, to: { point: [0, 0, 1500], direction: [0, 0, 0] }, legs },
      'RTE_INVALID_PORT',
      'to.direction',
    );
  });

  it('bounds the tolerance override at 22.5 degrees (a larger one would accept any turn)', () => {
    const { doc, lineId } = cs150Line();
    const rejected = execute(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs, angleToleranceDeg: 90 });
    expect(rejected.document).toBe(doc);
    expect(rejected.summary).toContain('angleToleranceDeg');
    expect(ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs, angleToleranceDeg: 22.5 }).affected).toHaveLength(1);
  });
});

describe('route_pipe refusals leave the document unchanged and carry a stable code', () => {
  const base = (): { doc: CadDocument; params: Record<string, unknown>; lineId: string } => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
    return { doc: a.doc, lineId, params: { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] } };
  };

  it.each<[string, (b: ReturnType<typeof base>) => [CadDocument, Record<string, unknown>], string, string?]>([
    ['unknown line', (b) => [b.doc, { ...b.params, lineId: 'line-nope' }], 'RTE_UNKNOWN_LINE', 'lineId'],
    ['unknown start port', (b) => [b.doc, { ...b.params, from: { portId: 'tie-nope' } }], 'RTE_UNKNOWN_PORT', 'from.portId'],
    ['unknown end port', (b) => [b.doc, { ...b.params, to: { portId: 'V-9:N1' } }], 'RTE_UNKNOWN_PORT', 'to.portId'],
    [
      'a port of another size',
      (b) => {
        const small = addTie(b.doc, 'S', [0, 5000, 0], [1, 0, 0], { dn: 50 });
        return [small.doc, { ...b.params, from: { portId: small.id } }];
      },
      'RTE_SIZE_MISMATCH',
      'from.portId',
    ],
    ['a port that is already connected', (b) => [apply(b.doc, 'route_pipe', b.params), b.params], 'RTE_PORT_IN_USE', 'from.portId'],
    [
      'a flanged port of another rating',
      (b) => {
        const tie = addTie(b.doc, 'F3', [0, 5000, 0], [1, 0, 0], { endType: 'FL', rating: 'CL300', facing: 'RF' });
        return [tie.doc, { ...b.params, from: { portId: tie.id } }];
      },
      'RTE_RATING_MISMATCH',
      'start',
    ],
    [
      'a flanged port of another facing',
      (b) => {
        const tie = addTie(b.doc, 'F4', [0, 5000, 0], [1, 0, 0], { endType: 'FL', rating: 'CL150', facing: 'FF' });
        return [tie.doc, { ...b.params, from: { portId: tie.id } }];
      },
      'RTE_FACING_MISMATCH',
      'start',
    ],
    [
      'a socket-weld port (no BW-SW rule)',
      (b) => {
        const tie = addTie(b.doc, 'SW', [0, 5000, 0], [1, 0, 0], { endType: 'SW' });
        return [tie.doc, { ...b.params, from: { portId: tie.id } }];
      },
      'RTE_NO_CONNECTION_RULE',
      'start',
    ],
    [
      'a 60 degree turn',
      (b) => [
        b.doc,
        {
          ...b.params,
          legs: [
            { direction: '+X', length: 2000 },
            { direction: [0.5, 0.866025403784, 0], length: 2000 },
          ],
        },
      ],
      'RTE_NO_FITTING_FOR_ANGLE',
      'legs.1',
    ],
    [
      'a leg shorter than its two elbows',
      (b) => [
        b.doc,
        {
          ...b.params,
          legs: [
            { direction: '+X', length: 1000 },
            { direction: '+Y', length: 250 },
            { direction: '+X', length: 1000 },
          ],
        },
      ],
      'RTE_SEGMENT_TOO_SHORT',
      'legs.1',
    ],
    ['a zero-length leg', (b) => [b.doc, { ...b.params, legs: [{ direction: '+X', length: 0 }] }], 'RTE_ZERO_LEG', 'legs.0.length'],
    ['no legs and no target', (b) => [b.doc, { ...b.params, legs: [] }], 'RTE_ZERO_LEG', 'legs'],
    [
      'a first leg off the port direction',
      (b) => [b.doc, { ...b.params, legs: [{ direction: '+Y', length: 2000 }] }],
      'RTE_PORT_DIRECTION',
      'legs.0.direction',
    ],
    [
      'a target port the last point cannot reach with one straight leg',
      (b) => {
        const far = addTie(b.doc, 'B', [5000, 500, 0], [-1, 0, 0]);
        return [far.doc, { ...b.params, to: { portId: far.id } }];
      },
      'RTE_CLOSING_LEG_IMPOSSIBLE',
      'to',
    ],
    ['a document in metres', (b) => [{ ...b.doc, units: 'm' }, b.params], 'RTE_UNITS_UNSUPPORTED'],
    ['a line whose spec is gone', (b) => [withoutSpecs(b.doc), b.params], 'RTE_SPEC_UNKNOWN', 'lineId'],
  ])('%s', (_label, arrange, code, path) => {
    const [doc, params] = arrange(base());
    const result = expectRefusal(doc, 'route_pipe', params, code, path);
    expect(result.summary).toContain(code);
  });

  it('a flanged port whose spec has no gasket row names the missing component (RTE_SPEC_NO_COMPONENT)', () => {
    const { doc: withLine, lineId } = cs150Line();
    const tie = addTie(withLine, 'F', [0, 0, 0], [1, 0, 0], { endType: 'FL', rating: 'CL150', facing: 'RF' });
    const noGasket = apply(tie.doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'removeComponent', id: 'G-SW' }] });
    const result = expectRefusal(
      noGasket,
      'route_pipe',
      { lineId, from: { portId: tie.id }, legs: [{ direction: '+X', length: 2000 }] },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(result.summary).toContain('gasket');
  });

  it('a flange row without a length through hub is a missing dimension, not a guess', () => {
    const { doc: withLine, lineId } = cs150Line();
    const tie = addTie(withLine, 'F', [0, 0, 0], [1, 0, 0], { endType: 'FL', rating: 'CL150', facing: 'RF' });
    const bundledOnly = apply(tie.doc, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setHeader', fields: { catalogs: ['llull-open-piping'] } }],
    });
    const result = expectRefusal(
      bundledOnly,
      'route_pipe',
      { lineId, from: { portId: tie.id }, legs: [{ direction: '+X', length: 2000 }] },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(result.summary).toContain('lengthThroughHub');
  });

  it('puts the remaining offset and the angles in error.detail (CLOSING_LEG_IMPOSSIBLE, NO_FITTING_FOR_ANGLE)', () => {
    const { doc, params } = base();
    const far = addTie(doc, 'B', [5000, 500, 0], [-1, 0, 0]);
    const closing = execute(far.doc, 'route_pipe', { ...params, to: { portId: far.id } });
    expect(closing.error?.detail?.['offset']).toEqual([3000, 500, 0]);
    const angle = execute(doc, 'route_pipe', {
      ...params,
      legs: [
        { direction: '+X', length: 2000 },
        { direction: [1, 1.7320508, 0], length: 2000 },
      ],
    });
    expect(angle.error?.detail).toMatchObject({ anglesDeg: [90, 45], toleranceDeg: 1 });
    expect(angle.error?.detail?.['angleDeg']).toBeCloseTo(60, 3);
  });
});
