/**
 * Plant 02 RTE M2: valves and concentric reducers placed in a run (`insert_inline_component`, `move_inline_component`, `remove_inline_component`,
 * `route_pipe.inline`). Expected numbers are hand calculations from the catalogue stub (NPS 4: LR 90 A 152, WN flange hub Y 76, gasket 3.0, gate valve
 * face-to-face 229, NPS 6x4 concentric reducer length 140), never copied from a run of the code.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, RevolutionEntity } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { createEmptyDocument } from '@core/model/types';
import { addTie, cs150Line, rteJson, valveScene } from './rteFixtures';

/** A catalogue with a gate valve that has a stem height (the stub catalogue's bundled valve has none), searched first by the spec. */
const STEM_CATALOG = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'rte-stem-test',
  version: '1.0.0',
  licence: 'open-data',
  families: [
    {
      id: 'asme-b16.10-gate-rf-stem-test',
      type: 'valveGate',
      standard: 'ASME B16.10',
      dimensionalStandard: 'ASME',
      ends: ['FL'],
      sizes: [
        {
          nps: 4,
          class: 150,
          facing: 'RF',
          faceToFace: 229,
          stemHeight: 600,
          provenance: { sourceId: 'test', citation: 'test input: stem height 600 mm' },
        },
      ],
    },
  ],
};

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface Piece {
  id: string;
  dn: number;
  leg: number;
  cutLengthMm: number;
}
interface Takeoff {
  counts: Record<string, number>;
  pipePieces: Piece[];
  parts: Array<{ id: string; kind: string }>;
  joints: Array<{ kind: string; position: [number, number, number]; gapMm: number; parts: string[] }>;
  inline: Array<{ id: string; centre: [number, number, number]; faces: [number, number, number][] }>;
}

const takeoff = (doc: CadDocument, runId: string): Takeoff => data<Takeoff>(doc, 'piping_takeoff', { runId });

/** A DN100 butt-weld run A -> +X 2000 -> +Y 2000 (one elbow, pieces 1848 / 1848), open at the far end. */
function simpleRun(): { doc: CadDocument; runId: string; lineId: string } {
  const { doc: withLine, lineId } = cs150Line();
  const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 2000 },
      { direction: '+Y', length: 2000 },
    ],
  });
  return { doc, runId: piping(doc).runOrder[0] as string, lineId };
}

describe('insert_inline_component: flanged gate valve (SC-RTE-02)', () => {
  const s = valveScene();

  it('splits leg 0 around the valve: faces z 1685.5 / 1914.5, pieces 527.5 / 354.5 (hand calculation in the plan)', () => {
    // valve centre z 1800 (port face z 1000 + 800); faces 1800 -/+ 229 / 2; flange set = gasket 3 + hub 76.
    // piece 1: (1685.5 - 3 - 76) - (1000 + 3 + 76) = 527.5 ; piece 2: (2500 - 152) - (1914.5 + 3 + 76) = 354.5
    expect((s.insert['facePositions'] as number[][]).map((face) => face[2])).toEqual([1685.5, 1914.5]);
    expect(s.insert['legCutLengthsMm']).toEqual([527.5, 354.5]);
    expect((s.insert['pipePieces'] as Piece[]).map((piece) => piece.cutLengthMm)).toEqual([527.5, 354.5, 2696, 2696, 1196, 2769]);
    expect(s.insert['centre']).toEqual([0, 0, 1800]);
    expect(s.insert['lengthMm']).toBe(229);
  });

  it('adds 4 flange sets and 12 butt welds: the SC-RTE-02 counts (4 WN, 4 gaskets, 4 bolt sets, 32 studs, 4 flanged joints)', () => {
    const t = takeoff(s.doc, s.runId);
    expect(t.counts).toMatchObject({
      valveGate: 1,
      flangeWeldNeck: 4,
      gasketSpiralWound: 4,
      boltSet: 4,
      studs: 32,
      pipePieces: 6,
      buttWelds: 12,
      flangedJoints: 4,
      elbow90LR: 4,
    });
    const flanged = t.joints.filter((joint) => joint.kind === 'flanged' && joint.parts.some((part) => part.includes('valve')));
    expect(flanged.map((joint) => joint.position[2])).toEqual([1685.5, 1914.5]);
    expect(flanged.every((joint) => joint.gapMm === 3)).toBe(true);
  });

  it('lists the parts of leg 0 in route order: start set, piece, valve set, valve, set, piece, elbow', () => {
    const kinds = takeoff(s.doc, s.runId).parts.map((part) => part.id.split('/')[1]?.replace(/-\d+$/, ''));
    expect(kinds.slice(0, 15)).toEqual([
      'gasket',
      'boltSet',
      'flange',
      'pipe',
      'flange',
      'boltSet',
      'gasket',
      'valve',
      'gasket',
      'boltSet',
      'flange',
      'pipe',
      'elbow',
      'pipe',
      'elbow',
    ]);
  });

  it('stores only the intent (id, type, tag, leg, distance, stem) and returns the component id first in affected', () => {
    const run = piping(s.doc).runs[s.runId] as PipeRun;
    expect(run.inline).toEqual([
      { id: s.valveId, type: 'valveGate', tag: 'XV-1001', leg: 0, centreDistance: 800, stemDirection: [0, -1, 0] },
    ]);
    expect(
      ok(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 } }).affected[1],
    ).toBe(s.runId);
  });

  it('draws the valve body, stem and handwheel on layer P-VALV with the part ids, and saves nothing of them', () => {
    const ids = piping(s.doc).entityIds[s.runId] as string[];
    const valve = ids.filter((id) => id.includes('/valve-1'));
    expect(valve).toEqual([`${s.runId}/valve-1`, `${s.runId}/valve-1/stem`, `${s.runId}/valve-1/wheel`]);
    for (const id of valve) {
      const entity = s.doc.entities[id] as RevolutionEntity;
      expect(entity.kind).toBe('revolution');
      expect(entity.layerId).toBe('layer-P-VALV');
    }
    // The stem leaves the valve centre toward -Y (default stem length = 0.9 x face-to-face, display only).
    const stem = s.doc.entities[`${s.runId}/valve-1/stem`] as RevolutionEntity;
    expect(stem.position).toEqual([0, 0, 1800]);
    expect(s.doc.layers['layer-P-VALV']).toBeDefined();
  });

  it('reports the handwheel centre with its stem height (none in the row: 0, flagged)', () => {
    expect(s.insert['handwheelCentre']).toEqual({ point: [0, 0, 1800], stemHeightMm: 0, stemHeightFromCatalogue: false });
  });

  it('is pure: the input document is unchanged and a second run gives identical ids', () => {
    const before = structuredClone(s.doc);
    const params = { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 } };
    const first = execute(s.doc, 'insert_inline_component', params);
    const second = execute(s.doc, 'insert_inline_component', params);
    expect(s.doc).toEqual(before);
    expect(first.document).toEqual(second.document);
    expect(first.rejected).toBeUndefined();
  });
});

describe('insert_inline_component: position and defaults', () => {
  it('places a valve on a butt-weld run by point and gives horizontal pipes an upward stem (pieces 806.5 / 654.5)', () => {
    const { doc, runId } = simpleRun();
    // valve centred 1000 along leg 0: reach 229 / 2 + 3 + 76 = 193.5 -> [806.5, 1193.5]; piece 1 = 806.5 (open start), piece 2 = 1848 - 1193.5 = 654.5
    const result = data<Record<string, unknown>>(doc, 'insert_inline_component', { runId, type: 'valveGate', at: { point: [1000, 0, 0] } });
    expect(result['legCutLengthsMm']).toEqual([806.5, 654.5]);
    expect(result['stemDirection']).toEqual([0, 0, 1]);
    expect(result['centreDistance']).toBe(1000);
  });

  it('defaults the stem of a vertical pipe to +X and normalises a given stem', () => {
    const { doc, lineId } = cs150Line();
    const a = addTie(doc, 'V', [0, 0, 0], [0, 0, 1]);
    const routed = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+Z', length: 3000 }] });
    const runId = piping(routed).runOrder[0] as string;
    expect(
      data<Record<string, unknown>>(routed, 'insert_inline_component', { runId, type: 'valveGate', at: { leg: 0, centreDistance: 1500 } })[
        'stemDirection'
      ],
    ).toEqual([1, 0, 0]);
    const tilted = data<Record<string, unknown>>(routed, 'insert_inline_component', {
      runId,
      type: 'valveGate',
      at: { leg: 0, centreDistance: 1500 },
      stemDirection: [0, 3, 0.5],
    });
    expect((tilted['stemDirection'] as number[]).map((v) => +v.toFixed(6))).toEqual([0, 0.986394, 0.164399]);
  });

  it('puts the handwheel at the valve centre when the row has no stem height, flagged as not from the catalogue', () => {
    const { doc, runId } = simpleRun();
    const base = data<Record<string, unknown>>(doc, 'insert_inline_component', {
      runId,
      type: 'valveGate',
      at: { leg: 0, centreDistance: 1000 },
      stemDirection: [0, 0, 1],
    });
    expect(base['handwheelCentre']).toMatchObject({ point: [1000, 0, 0], stemHeightFromCatalogue: false });
  });

  it('uses the stem height of the catalogue row when it has one: handwheel centre = centre + stem x height', () => {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'import_piping_catalog', { catalog: rteJson('catalog_stub_cs150.json') });
    doc = apply(doc, 'import_piping_catalog', { catalog: STEM_CATALOG });
    doc = apply(doc, 'import_pipe_spec', {
      spec: { ...rteJson('spec_cs150.json'), catalogs: ['rte-stem-test', 'rte-validation-stub', 'llull-open-piping'] },
    });
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '1001', spec: 'CS150', dn: 100 });
    const lineId = piping(doc).lineOrder[0] as string;
    const a = addTie(doc, 'A', [0, 0, 0], [1, 0, 0]);
    const routed = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 3000 }] });
    const placed = data<Record<string, unknown>>(routed, 'insert_inline_component', {
      runId: piping(routed).runOrder[0],
      type: 'valveGate',
      at: { leg: 0, centreDistance: 1000 },
      stemDirection: [0, 0, 1],
    });
    expect(placed['handwheelCentre']).toEqual({ point: [1000, 0, 600], stemHeightMm: 600, stemHeightFromCatalogue: true });
  });

  it('numbers the valve and its flange sets in route order: the end set follows the valve sets', () => {
    const { doc, runId } = simpleRun();
    const next = apply(doc, 'insert_inline_component', { runId, type: 'valveGate', at: { leg: 0, centreDistance: 1000 } });
    expect(piping(next).entityIds[runId]).toEqual(
      expect.arrayContaining([`${runId}/flange-1`, `${runId}/flange-2`, `${runId}/gasket-1`, `${runId}/valve-1`]),
    );
  });
});

describe('insert_inline_component: reducers change the run size', () => {
  /** DN150 line from A (DN150) to B (DN100 at x 6000): the run needs a 6x4 reducer. */
  function reducerScene(): { doc: CadDocument; lineId: string; a: string; b: string } {
    const line = cs150Line(150, '2001');
    const a = addTie(line.doc, 'RA', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const b = addTie(a.doc, 'RB', [6000, 0, 0], [-1, 0, 0], { dn: 100 });
    return { doc: b.doc, lineId: line.lineId, a: a.id, b: b.id };
  }

  it('route_pipe refuses a smaller end port without a reducer (RTE_SIZE_MISMATCH, remediation names the reducer), accepts one with inline', () => {
    const s = reducerScene();
    const refused = expectRefusal(
      s.doc,
      'route_pipe',
      { lineId: s.lineId, from: { portId: s.a }, to: { portId: s.b } },
      'RTE_SIZE_MISMATCH',
      'to.portId',
    );
    expect(refused.error?.remediation).toContain('reducer');
    const params = {
      lineId: s.lineId,
      from: { portId: s.a },
      to: { portId: s.b },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    };
    const routed = data<Record<string, unknown>>(s.doc, 'route_pipe', params);
    // reducer 6x4 length 140 centred 3000: pieces 3000 - 70 = 2930 (DN150) and 6000 - 3070 = 2930 (DN100)
    expect((routed['pipePieces'] as Piece[]).map((piece) => piece.cutLengthMm)).toEqual([2930, 2930]);
    expect(routed['dn']).toEqual({ start: 150, end: 100 });
    expect((routed['inlineIds'] as string[]).length).toBe(1);
  });

  it('cuts DN150 and DN100 pieces with their own OD and puts reducer ports at the faces', () => {
    const s = reducerScene();
    const doc = apply(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { portId: s.a },
      to: { portId: s.b },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    const runId = piping(doc).runOrder[0] as string;
    const t = takeoff(doc, runId);
    expect(t.pipePieces.map((piece) => piece.dn)).toEqual([150, 100]);
    expect(t.counts).toMatchObject({ reducerConcentric: 1, buttWelds: 4 });
    const reducer = doc.entities[`${runId}/reducer-1`] as RevolutionEntity;
    expect(reducer.profile[1]?.[0]).toBeCloseTo(84.15, 9);
    expect(reducer.profile[2]?.[0]).toBeCloseTo(57.15, 9);
    expect(reducer.profile[2]?.[1]).toBeCloseTo(140, 9);
  });

  it('inserting a reducer into an open run makes the run end DN100: the next run continues from <runId>:end on a DN100 line', () => {
    const line = cs150Line(150, '2001');
    const a = addTie(line.doc, 'RA', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const routed = apply(a.doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 4000 }] });
    const runId = piping(routed).runOrder[0] as string;
    const reduced = apply(routed, 'insert_inline_component', {
      runId,
      type: 'reducerConcentric',
      dn2: 100,
      at: { leg: 0, centreDistance: 2000 },
    });
    const small = apply(reduced, 'create_pipeline', { service: 'P', sequence: '2002', spec: 'CS150', dn: 100 });
    const smallLine = piping(small).lineOrder.at(-1) as string;
    const next = apply(small, 'route_pipe', {
      lineId: smallLine,
      from: { portId: `${runId}:end` },
      legs: [{ direction: '+X', length: 1000 }],
    });
    expect(piping(next).runOrder).toHaveLength(2);
    // The old size is refused: a DN150 line cannot continue from the DN100 end.
    expectRefusal(
      small,
      'route_pipe',
      { lineId: line.lineId, from: { portId: `${runId}:end` }, legs: [{ direction: '+X', length: 1000 }] },
      'RTE_SIZE_MISMATCH',
    );
  });

  it('refuses a reducer without dn2, dn2 equal to the run size, a valve with dn2 and a size the end port does not have', () => {
    const s = reducerScene();
    const routed = apply(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { portId: s.a },
      to: { portId: s.b },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    const runId = piping(routed).runOrder[0] as string;
    expectRefusal(
      routed,
      'insert_inline_component',
      { runId, type: 'reducerConcentric', at: { leg: 0, centreDistance: 1000 } },
      'RTE_SIZE_MISMATCH',
      'inline.dn2',
    );
    expectRefusal(
      routed,
      'insert_inline_component',
      { runId, type: 'valveGate', dn2: 100, at: { leg: 0, centreDistance: 1000 } },
      'RTE_SIZE_MISMATCH',
      'inline.dn2',
    );
    expectRefusal(
      routed,
      'insert_inline_component',
      { runId, type: 'reducerConcentric', dn2: 150, at: { leg: 0, centreDistance: 1000 } },
      'RTE_SIZE_MISMATCH',
    );
    // A second reducer 100 -> 80 would leave the run at DN80 but the end port is DN100.
    expectRefusal(
      routed,
      'insert_inline_component',
      { runId, type: 'reducerConcentric', dn2: 80, at: { leg: 0, centreDistance: 5000 } },
      'RTE_SIZE_MISMATCH',
    );
  });

  it('removing the reducer is refused while the end port needs the small size, and restores the size on an open run', () => {
    const s = reducerScene();
    const routed = apply(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { portId: s.a },
      to: { portId: s.b },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    const runId = piping(routed).runOrder[0] as string;
    const componentId = (piping(routed).runs[runId] as PipeRun).inline?.[0]?.id as string;
    expectRefusal(routed, 'remove_inline_component', { runId, componentId }, 'RTE_SIZE_MISMATCH');
  });
});

describe('insert_inline_component: refusals leave the document unchanged', () => {
  const s = valveScene();

  it.each([
    ['unknown run', { runId: 'run-nope', type: 'valveGate', at: { leg: 0, centreDistance: 800 } }, 'RTE_UNKNOWN_RUN', 'runId'],
    [
      'a leg the run does not have',
      { runId: s.runId, type: 'valveGate', at: { leg: 9, centreDistance: 800 } },
      'RTE_INLINE_DOES_NOT_FIT',
      undefined,
    ],
    ['a point off the centreline', { runId: s.runId, type: 'valveGate', at: { point: [50, 0, 1800] } }, 'RTE_INLINE_DOES_NOT_FIT', 'at'],
    [
      'a valve overlapping the start flange set (centre 150)',
      { runId: s.runId, type: 'valveGate', at: { leg: 0, centreDistance: 150 } },
      'RTE_INLINE_DOES_NOT_FIT',
      undefined,
    ],
    [
      'a valve overlapping the first valve',
      { runId: s.runId, type: 'valveGate', at: { leg: 0, centreDistance: 900 } },
      'RTE_INLINE_DOES_NOT_FIT',
      undefined,
    ],
    [
      'a valve into the elbow (centre 1500 of 1500)',
      { runId: s.runId, type: 'valveGate', at: { leg: 0, centreDistance: 1500 } },
      'RTE_INLINE_DOES_NOT_FIT',
      undefined,
    ],
    [
      'a centre beyond the leg',
      { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 9000 } },
      'RTE_INLINE_DOES_NOT_FIT',
      undefined,
    ],
    [
      'a type the spec has no row for',
      { runId: s.runId, type: 'valveGlobe', at: { leg: 1, centreDistance: 1500 } },
      'RTE_SPEC_NO_COMPONENT',
      undefined,
    ],
    [
      'a zero stem direction',
      { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 }, stemDirection: [0, 0, 0] },
      'RTE_INVALID_PORT',
      'inline.stemDirection',
    ],
  ])('%s', (_name, params, code, path) => {
    expectRefusal(s.doc, 'insert_inline_component', params, code, path);
  });

  it('reports the cut length and the neighbours when the valve does not fit', () => {
    const result = expectRefusal(
      s.doc,
      'insert_inline_component',
      { runId: s.runId, type: 'valveGate', at: { leg: 0, centreDistance: 1400 } },
      'RTE_INLINE_DOES_NOT_FIT',
    );
    expect(result.error?.detail?.['cutLengthMm']).toBeLessThan(0);
    expect(result.error?.paths).toContain('legs.0');
  });

  it('refuses a document that is not in millimetres', () => {
    const inches = { ...s.doc, units: 'in' as const };
    expectRefusal(
      inches,
      'insert_inline_component',
      { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 } },
      'RTE_UNITS_UNSUPPORTED',
    );
  });
});

describe('move_inline_component and remove_inline_component', () => {
  const s = valveScene();

  it('moves by a new centre distance or a delta and re-cuts the neighbours (527.5 + 100 / 354.5 - 100)', () => {
    const byCentre = data<Record<string, unknown>>(s.doc, 'move_inline_component', {
      runId: s.runId,
      componentId: s.valveId,
      centreDistance: 900,
    });
    const byDelta = data<Record<string, unknown>>(s.doc, 'move_inline_component', { runId: s.runId, componentId: s.valveId, delta: 100 });
    expect(byCentre['legCutLengthsMm']).toEqual([627.5, 254.5]);
    expect(byDelta['legCutLengthsMm']).toEqual([627.5, 254.5]);
    const moved = apply(s.doc, 'move_inline_component', { runId: s.runId, componentId: s.valveId, delta: -100 });
    expect((piping(moved).runs[s.runId] as PipeRun).inline?.[0]?.centreDistance).toBe(700);
    expect(
      takeoff(moved, s.runId)
        .pipePieces.map((piece) => piece.cutLengthMm)
        .slice(0, 2),
    ).toEqual([427.5, 454.5]);
  });

  it('refuses unknown run / component, neither or both of centreDistance and delta, and positions that do not fit', () => {
    expectRefusal(s.doc, 'move_inline_component', { runId: 'run-nope', componentId: s.valveId, delta: 1 }, 'RTE_UNKNOWN_RUN');
    expectRefusal(s.doc, 'move_inline_component', { runId: s.runId, componentId: 'valve-nope', delta: 1 }, 'RTE_UNKNOWN_COMPONENT');
    expectRefusal(s.doc, 'move_inline_component', { runId: s.runId, componentId: s.valveId }, 'RTE_INLINE_DOES_NOT_FIT');
    expectRefusal(
      s.doc,
      'move_inline_component',
      { runId: s.runId, componentId: s.valveId, delta: 1, centreDistance: 5 },
      'RTE_INLINE_DOES_NOT_FIT',
    );
    expectRefusal(s.doc, 'move_inline_component', { runId: s.runId, componentId: s.valveId, delta: -900 }, 'RTE_INLINE_DOES_NOT_FIT');
    expectRefusal(
      s.doc,
      'move_inline_component',
      { runId: s.runId, componentId: s.valveId, centreDistance: 1450 },
      'RTE_INLINE_DOES_NOT_FIT',
    );
  });

  it('removes the valve: the leg is one piece again (1269) and the run equals SC-RTE-01', () => {
    const removed = ok(s.doc, 'remove_inline_component', { runId: s.runId, componentId: s.valveId });
    expect(removed.affected).toEqual([s.runId]);
    expect((piping(removed.document).runs[s.runId] as PipeRun).inline).toBeUndefined();
    expect(takeoff(removed.document, s.runId).pipePieces.map((piece) => piece.cutLengthMm)).toEqual([1269, 2696, 2696, 1196, 2769]);
    expect(piping(removed.document).entityIds[s.runId]?.some((id) => id.includes('valve'))).toBe(false);
    expectRefusal(removed.document, 'remove_inline_component', { runId: s.runId, componentId: s.valveId }, 'RTE_UNKNOWN_COMPONENT');
    expectRefusal(s.doc, 'remove_inline_component', { runId: 'run-nope', componentId: s.valveId }, 'RTE_UNKNOWN_RUN');
  });
});

describe('route_pipe inline refusals', () => {
  const { doc, lineId } = cs150Line();
  const a = addTie(doc, 'A', [0, 0, 0], [1, 0, 0]);
  const base = { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 3000 }] };

  it('refuses a component on a leg the route does not have, naming the path', () => {
    const refused = expectRefusal(
      a.doc,
      'route_pipe',
      { ...base, inline: [{ type: 'valveGate', at: { leg: 4, centreDistance: 100 } }] },
      'RTE_INLINE_DOES_NOT_FIT',
      'inline.0.at.leg',
    );
    expect(refused.summary).toContain('leg 4');
  });

  it('refuses a zero stem direction and a valve with dn2', () => {
    expectRefusal(
      a.doc,
      'route_pipe',
      { ...base, inline: [{ type: 'valveGate', at: { leg: 0, centreDistance: 1500 }, stemDirection: [0, 0, 0] }] },
      'RTE_INVALID_PORT',
      'inline.0.stemDirection',
    );
    expectRefusal(
      a.doc,
      'route_pipe',
      { ...base, inline: [{ type: 'valveGate', dn2: 80, at: { leg: 0, centreDistance: 1500 } }] },
      'RTE_SIZE_MISMATCH',
      'inline.0.dn2',
    );
  });

  it('places a valve while routing: pieces 1500 - 193.5 = 1306.5 on each side', () => {
    // 3000 mm leg, open start and end, valve centred at 1500: reach 193.5 -> pieces 1500 - 193.5 = 1306.5 each side
    const routed = data<Record<string, unknown>>(a.doc, 'route_pipe', {
      ...base,
      inline: [{ type: 'valveGate', tag: 'XV-9', at: { leg: 0, centreDistance: 1500 } }],
    });
    expect((routed['pipePieces'] as Piece[]).map((piece) => piece.cutLengthMm)).toEqual([1306.5, 1306.5]);
    expect(routed['inlineIds']).toHaveLength(1);
  });
});
