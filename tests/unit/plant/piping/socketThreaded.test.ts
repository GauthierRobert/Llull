/**
 * Plant 02 RTE V1: socket-weld and threaded engagement. Every expected number is a hand calculation from the small-bore catalogue stub
 * (docs/plant/02-spec-driven-routing/validation/data/catalog_stub_small_bore.json): NPS 1 SW elbow centre-to-mouth 41, socket depth J 13, socket gap 1.6
 * so the pipe sits J - 1.6 = 11.4 mm inside; threaded elbow 38, engagement 17.3; SW gate valve face-to-face 79; SW flange hub 17.5 + gasket 3.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document, rteJson } from './rteFixtures';
import { smallBoreDocument } from './smallBoreFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const lastLine = (doc: CadDocument): string => piping(doc).lineOrder.at(-1) as string;
const lastTie = (doc: CadDocument): string => piping(doc).tieInOrder.at(-1) as string;

interface RouteData {
  runId: string;
  pipePieces: Array<{ id: string; cutLengthMm: number; leg: number }>;
  counts: Record<string, number>;
  totalPipeMm: number;
  centrelineLengthMm: number;
}

/** A DN25 line on `spec` with a tie-in of end type `endType` at the origin facing +Z. */
function sceneOf(
  specFile: 'spec_sw800.json' | 'spec_thd800.json',
  endType: 'SW' | 'SC',
  dn = 25,
): { doc: CadDocument; line: string; tie: string } {
  const spec = specFile === 'spec_sw800.json' ? 'SW800' : 'THD800';
  let doc = smallBoreDocument(specFile);
  doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '1', spec, dn });
  doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [0, 0, 1], dn, endType });
  return { doc, line: lastLine(doc), tie: lastTie(doc) };
}

const UP_AND_ACROSS = [
  { direction: '+Z', length: 1000 },
  { direction: '+X', length: 1500 },
];

describe('socket-weld cut-back (SW800, NPS 1)', () => {
  const s = sceneOf('spec_sw800.json', 'SW');
  const route = data<RouteData>(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS });

  it('the pipe goes J - gap = 11.4 mm into the port and the elbow socket: cuts 1000 - 41 + 22.8 = 981.8 and 1500 - 41 + 11.4 = 1470.4', () => {
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([981.8, 1470.4]);
    expect(route.totalPipeMm).toBeCloseTo(2452.2, 9);
  });

  it('counts three socket welds and no butt weld; the SW elbow is an elbow90 part', () => {
    expect(route.counts).toMatchObject({ socketWelds: 3, buttWelds: 0, threadedJoints: 0, elbow90: 1, pipePieces: 2 });
  });

  it('centreline: the bend ends at the socket bottom (R = 41 - 13 = 28): 2500 - 2 x 28 + 28 x pi / 2 = 2487.9823', () => {
    expect(route.centrelineLengthMm).toBeCloseTo(2487.982297, 5);
  });

  it('joints carry the engagement (11.4) and the socket gap (1.6); pipe ends are plain (PL), the fittings SW', () => {
    const run = piping(apply(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS })).runs[
      route.runId
    ] as PipeRun;
    const doc = apply(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS });
    const derived = deriveRun(doc, run);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const welds = derived.joints.filter((joint) => joint.kind === 'socketWeld');
    expect(welds).toHaveLength(3);
    for (const weld of welds) {
      expect(weld.gapMm).toBe(1.6);
      expect(weld.engagementMm).toBeCloseTo(11.4, 9);
    }
    const pipe = derived.parts.find((part) => part.kind === 'pipe');
    expect(pipe?.ports.map((port) => port.endType)).toEqual(['PL', 'PL']);
    expect(pipe?.ports[0]?.position[2]).toBeCloseTo(-11.4, 9);
    const elbow = derived.parts.find((part) => part.kind === 'elbow');
    expect(elbow?.ports.map((port) => port.endType)).toEqual(['SW', 'SW']);
    expect(elbow?.ports[0]?.position[2]).toBeCloseTo(959, 9);
  });

  it('a gate valve (SW, face-to-face 79) at 500: faces 460.5 / 539.5, pieces 483.3 / 442.3 / 1470.4, five socket welds', () => {
    const withValve = ok(s.doc, 'route_pipe', {
      lineId: s.line,
      from: { portId: s.tie },
      legs: UP_AND_ACROSS,
      inline: [{ type: 'valveGate', tag: 'XV-1', at: { leg: 0, centreDistance: 500 }, stemDirection: [0, -1, 0] }],
    });
    const result = withValve.data as RouteData;
    expect(result.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([483.3, 442.3, 1470.4]);
    expect(result.counts).toMatchObject({ socketWelds: 5, buttWelds: 0, valveGate: 1 });
  });

  it('a pipe piece shorter than 50 mm between socket joins is not a weld-spacing warning (leg 60: 60 - 41 + 22.8 = 41.8)', () => {
    const short = ok(s.doc, 'route_pipe', {
      lineId: s.line,
      from: { portId: s.tie },
      legs: [
        { direction: '+Z', length: 60 },
        { direction: '+X', length: 500 },
      ],
    });
    expect((short.data as RouteData).pipePieces[0]?.cutLengthMm).toBeCloseTo(41.8, 9);
    const warnings = (short.data as { warnings: Array<{ code: string }> }).warnings;
    expect(warnings.filter((warning) => warning.code === 'RTE_WELD_SPACING')).toEqual([]);
    const check = data<{ issues: Array<{ code: string }> }>(short.document, 'check_piping', {});
    expect(check.issues.filter((issue) => issue.code === 'RTE_WELD_SPACING')).toEqual([]);
  });

  it('two SW elbows closer than their faces overlap even though the pipe piece between them would be positive: refused', () => {
    expectRefusal(
      s.doc,
      'route_pipe',
      {
        lineId: s.line,
        from: { portId: s.tie },
        legs: [
          { direction: '+Z', length: 60 },
          { direction: '+X', length: 30 },
          { direction: '+Z', length: 500 },
        ],
      },
      'RTE_SEGMENT_TOO_SHORT',
    );
  });

  it('check_piping: the SW tie-in is attached, the only open end is the free pipe end', () => {
    const routed = apply(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS });
    const check = data<{ issues: Array<{ code: string; ids: string[] }>; counts: { byCode: Record<string, number> } }>(
      routed,
      'check_piping',
      {},
    );
    expect(check.counts.byCode['RTE_OPEN_END']).toBe(1);
    expect(check.counts.byCode['RTE_DISCONNECTED_PORT']).toBeUndefined();
    expect(check.counts.byCode['RTE_END_TYPE_MISMATCH']).toBeUndefined();
  });

  it('piping_takeoff counts the socket welds and names the engagement on the joint list', () => {
    const routed = apply(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS });
    const takeoff = data<{ counts: Record<string, number>; joints: Array<{ kind: string; engagementMm?: number }> }>(
      routed,
      'piping_takeoff',
      {},
    );
    expect(takeoff.counts['socketWelds']).toBe(3);
    expect(takeoff.joints.map((joint) => joint.engagementMm)).toEqual([11.4, 11.4, 11.4]);
  });
});

describe('socket-weld flange and branches', () => {
  /** A pump with a DN25 CL150 RF nozzle on top at z 1000 (face facing +Z). */
  function nozzleScene(): { doc: CadDocument; line: string } {
    let doc = smallBoreDocument('spec_sw800.json');
    doc = apply(doc, 'add_equipment', { name: 'Dosing pump', mark: 'P-201', location: [0, -300], size: [600, 600, 800], weight: 100 });
    doc = apply(doc, 'add_nozzle', {
      equipment: 'P-201',
      mark: 'N1',
      dn: 25,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 300, 1000], direction: [0, 0, 1] },
      projection: 100,
    });
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '2', spec: 'SW800', dn: 25 });
    return { doc, line: lastLine(doc) };
  }

  it('a flanged nozzle on SW pipe gets a socket-weld flange: set = 3 + 17.5, pipe 11.4 inside the hub, pieces 961.3 / 1470.4', () => {
    const s = nozzleScene();
    const route = data<RouteData>(s.doc, 'route_pipe', { lineId: s.line, from: { portId: 'P-201:N1' }, legs: UP_AND_ACROSS });
    // 1000 - (3 + 17.5 - 11.4) - (41 - 11.4) = 961.3
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([961.3, 1470.4]);
    expect(route.counts).toMatchObject({
      flangeSocketWeld: 1,
      gasketSpiralWound: 1,
      boltSet: 1,
      studs: 4,
      flangedJoints: 1,
      socketWelds: 3,
    });
    expect(route.counts['flangeWeldNeck']).toBeUndefined();
  });

  it('a flange row without socketDepth refuses with RTE_SPEC_NO_COMPONENT naming it', () => {
    const catalog = rteJson<{ families: Array<{ id: string; sizes: Array<Record<string, unknown>> }> }>('catalog_stub_small_bore.json');
    const flange = catalog.families.find((family) => family.id === 'asme-b16.5-so-rte-stub');
    const sizes = (flange?.sizes ?? []).map(({ socketDepth: _depth, ...rest }) => rest);
    const broken = {
      ...catalog,
      id: 'rte-small-bore-no-depth',
      families: catalog.families.map((family) => (family === flange ? { ...family, sizes } : family)),
    };
    const spec = { ...rteJson('spec_sw800.json'), catalogs: ['rte-small-bore-no-depth', 'llull-open-piping'] };
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'import_piping_catalog', { catalog: broken });
    doc = apply(doc, 'import_pipe_spec', { spec });
    doc = apply(doc, 'add_equipment', { name: 'Dosing pump', mark: 'P-201', location: [0, -300], size: [600, 600, 800], weight: 100 });
    doc = apply(doc, 'add_nozzle', {
      equipment: 'P-201',
      mark: 'N1',
      dn: 25,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 300, 1000], direction: [0, 0, 1] },
      projection: 100,
    });
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '2', spec: 'SW800', dn: 25 });
    const refused = expectRefusal(
      doc,
      'route_pipe',
      { lineId: lastLine(doc), from: { portId: 'P-201:N1' }, legs: UP_AND_ACROSS },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(refused.summary).toContain('socketDepth');
  });

  it('a sockolet 2x1 off a DN50 SW header: the branch pipe starts 50 - 11.4 = 38.6 from the header axis, cut 961.4; header whole', () => {
    let doc = smallBoreDocument('spec_sw800.json');
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '3', spec: 'SW800', dn: 50 });
    const header = ok(doc, 'route_pipe', {
      lineId: lastLine(doc),
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      legs: [{ direction: '+X', length: 2000 }],
    });
    const result = ok(header.document, 'add_branch', {
      runId: (header.data as RouteData).runId,
      at: { leg: 0, distance: 1000 },
      dn: 25,
      legs: [{ direction: '+Y', length: 1000 }],
    });
    const branch = result.data as { fitting: string; pipePieces: Array<{ cutLengthMm: number }>; counts: Record<string, number> };
    expect(branch.fitting).toBe('sockolet');
    expect(branch.pipePieces.find((piece) => piece.cutLengthMm !== 2000)?.cutLengthMm).toBeCloseTo(961.4, 9);
    const takeoff = data<{ counts: Record<string, number> }>(result.document, 'piping_takeoff', {});
    expect(takeoff.counts).toMatchObject({ sockolet: 1, branchWelds: 1, socketWelds: 1 });
  });

  it('a SW tee on a DN25 header: C = M = 41, every piece 1000 - 41 + 11.4 = 970.4', () => {
    let doc = smallBoreDocument('spec_sw800.json');
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '4', spec: 'SW800', dn: 25 });
    const header = ok(doc, 'route_pipe', {
      lineId: lastLine(doc),
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      legs: [{ direction: '+X', length: 2000 }],
    });
    const result = ok(header.document, 'add_branch', {
      runId: (header.data as RouteData).runId,
      at: { leg: 0, distance: 1000 },
      dn: 25,
      legs: [{ direction: '+Y', length: 1000 }],
    });
    const takeoff = data<{ pipePieces: Array<{ cutLengthMm: number }>; counts: Record<string, number> }>(
      result.document,
      'piping_takeoff',
      {},
    );
    expect(takeoff.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([970.4, 970.4, 970.4]);
    expect(takeoff.counts).toMatchObject({ tee: 1, socketWelds: 3 });
  });
});

describe('threaded engagement (THD800, NPS 1)', () => {
  const s = sceneOf('spec_thd800.json', 'SC');

  it('the pipe is screwed 17.3 mm into the port and the elbow: cuts 1000 - 38 + 34.6 = 996.6 and 1500 - 38 + 17.3 = 1479.3', () => {
    const route = data<RouteData>(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS });
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([996.6, 1479.3]);
    expect(route.counts).toMatchObject({ threadedJoints: 3, socketWelds: 0, buttWelds: 0 });
  });

  it('threaded valve: end-to-end 79 at 500 gives faces 460.5 / 539.5 and pieces 500 - 39.5 + 34.6 = 495.1 ...', () => {
    const route = data<RouteData>(s.doc, 'route_pipe', {
      lineId: s.line,
      from: { portId: s.tie },
      legs: UP_AND_ACROSS,
      inline: [{ type: 'valveGate', at: { leg: 0, centreDistance: 500 } }],
    });
    // piece 1: from -17.3 to 460.5 + 17.3 = 477.8 -> 495.1; piece 2: from 539.5 - 17.3 = 522.2 to 1000 - 38 + 17.3 = 979.3 -> 457.1
    expect(route.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([495.1, 457.1, 1479.3]);
    expect(route.counts['threadedJoints']).toBe(5);
  });

  it('a threadolet 2x1 on a DN50 threaded header: branch cut 1000 - (50 - 17.3) = 967.3', () => {
    let doc = smallBoreDocument('spec_thd800.json');
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '3', spec: 'THD800', dn: 50 });
    const header = ok(doc, 'route_pipe', {
      lineId: lastLine(doc),
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      legs: [{ direction: '+X', length: 2000 }],
    });
    const result = ok(header.document, 'add_branch', {
      runId: (header.data as RouteData).runId,
      at: { leg: 0, distance: 1000 },
      dn: 25,
      legs: [{ direction: '+Y', length: 1000 }],
    });
    const takeoff = data<{ pipePieces: Array<{ dn: number; cutLengthMm: number }>; counts: Record<string, number> }>(
      result.document,
      'piping_takeoff',
      {},
    );
    expect(takeoff.pipePieces.find((piece) => piece.dn === 25)?.cutLengthMm).toBeCloseTo(967.3, 9);
    expect(takeoff.counts).toMatchObject({ threadolet: 1, threadedJoints: 1 });
  });

  it('a threaded flange takes the pipe 14 mm into the hub', () => {
    let doc = smallBoreDocument('spec_thd800.json');
    doc = apply(doc, 'add_equipment', { name: 'Dosing pump', mark: 'P-201', location: [0, -300], size: [600, 600, 800], weight: 100 });
    doc = apply(doc, 'add_nozzle', {
      equipment: 'P-201',
      mark: 'N1',
      dn: 25,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 300, 1000], direction: [0, 0, 1] },
      projection: 100,
    });
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '2', spec: 'THD800', dn: 25 });
    const route = data<RouteData>(doc, 'route_pipe', { lineId: lastLine(doc), from: { portId: 'P-201:N1' }, legs: UP_AND_ACROSS });
    // 1000 - (3 + 17.5 - 14) - (38 - 17.3) = 972.8
    expect(route.pipePieces[0]?.cutLengthMm).toBeCloseTo(972.8, 9);
    expect(route.counts).toMatchObject({ flangeThreaded: 1, threadedJoints: 3, flangedJoints: 1 });
  });
});

describe('connection rules and refusals', () => {
  it('a SW port on a butt-weld spec (BE pipe) has no rule: RTE_NO_CONNECTION_RULE, document unchanged (SC-RTE-05g)', () => {
    let doc = apply(cs150Document(), 'create_pipeline', { service: 'P', sequence: '1', spec: 'CS150', dn: 100 });
    doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [0, 0, 1], dn: 100, endType: 'SW' });
    expectRefusal(
      doc,
      'route_pipe',
      { lineId: lastLine(doc), from: { portId: lastTie(doc) }, legs: [{ direction: '+Z', length: 1000 }] },
      'RTE_NO_CONNECTION_RULE',
    );
  });

  it('a threaded port on a socket-weld spec (PE pipe) has no rule either', () => {
    const s = sceneOf('spec_sw800.json', 'SC');
    expectRefusal(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS }, 'RTE_NO_CONNECTION_RULE');
  });

  it('a SW port at a size where the spec has no socket fitting (DN50) cannot take its depth: RTE_SPEC_NO_COMPONENT names socketDepth', () => {
    const s = sceneOf('spec_sw800.json', 'SW', 50);
    const refused = expectRefusal(
      s.doc,
      'route_pipe',
      { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(refused.summary).toContain('socketDepth');
  });

  it('is pure: routing on the socket-weld spec leaves its input document untouched', () => {
    const s = sceneOf('spec_sw800.json', 'SW');
    const before = JSON.stringify(s.doc);
    ok(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs: UP_AND_ACROSS });
    expect(JSON.stringify(s.doc)).toBe(before);
  });
});
