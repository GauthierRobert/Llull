/**
 * Plant 02 RTE V2: the obstacles of `route_problem` come from the V1 run model (the clash bodies every registered source reports), not from a
 * second geometry. Hand calculations from the CS150 stub (DN100 OD 114.3, DN150 OD 168.3, DN50 OD 60.3) and the operator stub (globe valve
 * actuator cylinder 250 x 500 topping at 900): the new DN100 line has radius 57.15 + clearance 50 = 107.15 mm.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { aabbs, portOwnership } from '@aec/plant/piping/autoRoute/obstacles';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from './rteFixtures';
import { operatorsDocument } from './smallBoreFixtures';

interface Box {
  id: string;
  min: number[];
  max: number[];
}
interface ProblemData {
  problem: { obstacles: Box[] };
}

/** DN100 reach of the new line: pipe radius 57.15 + clearance 50, mm. */
const REACH = 107.15;

/** A new DN100 line in `doc` and a route across x (default 5000) from y -3000 to y 3000 at z `z` between two open ends. */
function crossing(base: CadDocument, z: number, spec = 'CS150', x = 5000): { doc: CadDocument; params: Record<string, unknown> } {
  const created = ok(base, 'create_pipeline', { service: 'P', sequence: '9001', spec, dn: 100 });
  return {
    doc: created.document,
    params: {
      lineId: created.affected[0],
      from: { point: [x, -3000, z], direction: [0, 1, 0] },
      to: { point: [x, 3000, z], direction: [0, -1, 0] },
      grid: 50,
      bendCost: 1000,
    },
  };
}

/** A DN150 header at z 3000 along x (0 to 10000), optionally hot and insulated (180 C, spec H: 60 mm for DN150). */
function headerDoc(insulated: boolean): { doc: CadDocument; runId: string } {
  const line = apply(cs150Line(100).doc, 'create_pipeline', {
    service: 'HO',
    sequence: '4001',
    spec: 'CS150',
    dn: 150,
    ...(insulated ? { designTempC: 180, insulation: { code: 'H', thickness: 'fromSpec' } } : {}),
  });
  const lineId = line.plant?.piping?.lineOrder.at(-1) as string;
  const a = addTie(line, 'TP-1', [0, 0, 3000], [1, 0, 0], { dn: 150 });
  const b = addTie(a.doc, 'TP-2', [10000, 0, 3000], [-1, 0, 0], { dn: 150 });
  const routed = ok(b.doc, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc: routed.document, runId: (routed.data as { runId: string }).runId };
}

const obstaclesOf = (scene: { doc: CadDocument; params: Record<string, unknown> }): Box[] =>
  data<ProblemData>(scene.doc, 'route_problem', scene.params).problem.obstacles;

describe('obstacles of an existing run are its clash bodies', () => {
  it('a bare header: one box per pipe piece, half section OD / 2 + the new line reach; no leg boxes, no derived entity boxes', () => {
    const { doc, runId } = headerDoc(false);
    const boxes = obstaclesOf(crossing(doc, 3000));
    expect(boxes.some((box) => box.id.includes('#leg'))).toBe(false);
    const pipe = boxes.filter((box) => box.id.startsWith(`${runId}/pipe-`));
    expect(pipe.length).toBeGreaterThan(0);
    const mid = pipe.find((box) => box.min[0] !== undefined && box.min[0] < 5_000_000 && (box.max[0] as number) > 5_000_000) as Box;
    expect(mid.min.slice(1)).toEqual([-Math.round((84.15 + REACH) * 1000), Math.round((3000 - 84.15 - REACH) * 1000)]);
    expect(mid.max.slice(1)).toEqual([Math.round((84.15 + REACH) * 1000), Math.round((3000 + 84.15 + REACH) * 1000)]);
  });

  it('an insulated header widens by the insulation (60 mm): the envelope replaces the solid it contains', () => {
    const { doc, runId } = headerDoc(true);
    const boxes = obstaclesOf(crossing(doc, 3000));
    const mid = boxes.find(
      (box) => box.id.startsWith(`${runId}/pipe-`) && (box.min[0] as number) < 5_000_000 && (box.max[0] as number) > 5_000_000,
    );
    expect(mid?.id).toMatch(/~ins$/);
    expect((mid?.max[1] as number) / 1000).toBeCloseTo(84.15 + 60 + REACH, 6);
    expect(boxes.filter((box) => box.id === mid?.id.replace('~ins', ''))).toEqual([]);
  });

  it('routes around the header and the route commits clash-free of it', () => {
    const { doc, params } = crossing(headerDoc(true).doc, 3000);
    const routed = ok(doc, 'auto_route_pipe', params).data as { bends: number; pis: number[][] };
    expect(routed.bends).toBeGreaterThan(0);
    const tight = ok(doc, 'auto_route_pipe', { ...params, clearance: 0 }).data as { pis: number[][] };
    expect(tight.pis).toBeDefined();
  });

  it('the insulation decides the jog (hand calculation, clearance 150): bare header 291.3 mm -> 350, insulated 351.3 mm -> 400 on the 50 mm lattice', () => {
    const length = (insulated: boolean): number => {
      const { doc, params } = crossing(headerDoc(insulated).doc, 3000);
      return (ok(doc, 'auto_route_pipe', { ...params, clearance: 150 }).data as { centrelineToPiLengthMm: number }).centrelineToPiLengthMm;
    };
    expect(length(false)).toBe(6700);
    expect(length(true)).toBe(6800);
  });

  it('a valve operator is an obstacle: the actuator cylinder (radius 125, up to z 900) blocks a pipe passing at z 600', () => {
    let doc = apply(operatorsDocument(), 'create_pipeline', { service: 'P', sequence: '7001', spec: 'CS150OP', dn: 100 });
    const lineId = doc.plant?.piping?.lineOrder[0] as string;
    const a = addTie(doc, 'A', [0, 0, 0], [1, 0, 0]);
    const b = addTie(a.doc, 'B', [6000, 0, 0], [-1, 0, 0]);
    const run = ok(b.doc, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
    const runId = (run.data as { runId: string }).runId;
    doc = apply(run.document, 'insert_inline_component', { runId, type: 'valveGlobe', at: { leg: 0, centreDistance: 3000 } });
    const scene = crossing(doc, 600, 'CS150OP', 3000);
    const boxes = obstaclesOf(scene);
    const actuator = boxes.find((box) => box.id.endsWith('/valve-1/actuator'));
    expect(actuator).toBeDefined();
    expect((actuator?.max[2] as number) / 1000).toBeCloseTo(900 + REACH, 6);
    expect((actuator?.max[0] as number) / 1000).toBeCloseTo(3000 + 125 + REACH, 6);
    const routed = ok(scene.doc, 'auto_route_pipe', scene.params).data as { bends: number };
    expect(routed.bends).toBeGreaterThan(0);
  });

  it('a sloped run is cut along its axis: its boxes follow the fall instead of one box of the whole drop', () => {
    const line = cs150Line(50, '3001');
    const a = addTie(line.doc, 'D1', [0, 0, 1000], [1, 0, 0], { dn: 50 });
    const b = addTie(a.doc, 'D2', [8000, 0, 0], [0, 0, 1], { dn: 50 });
    const drain = ok(b.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      legs: [{ direction: '+X', planLength: 8000, slope: { value: 1, unit: 'percent', fall: true } }],
    });
    const runId = (drain.data as { runId: string }).runId;
    const boxes = obstaclesOf(crossing(drain.document, 500));
    const pieces = boxes.filter((box) => box.id.startsWith(`${runId}/pipe-`));
    expect(pieces.length).toBeGreaterThan(8);
    for (const box of pieces) expect(((box.max[2] as number) - (box.min[2] as number)) / 1000).toBeLessThan(300);
  });

  it('a run that does not derive still blocks by its legs, inflated by both radii', () => {
    const { doc, runId } = headerDoc(false);
    const run = doc.plant?.piping?.runs[runId] as NonNullable<NonNullable<CadDocument['plant']>['piping']>['runs'][string];
    const broken: CadDocument = {
      ...doc,
      plant: {
        ...doc.plant,
        piping: {
          ...(doc.plant?.piping as NonNullable<NonNullable<CadDocument['plant']>['piping']>),
          runs: { [runId]: { ...run, pis: [[5, 0, 3000]] } },
        },
      },
    };
    const boxes = obstaclesOf(crossing(broken, 3000));
    expect(boxes.some((box) => box.id.startsWith(`${runId}#leg`))).toBe(true);
    expect(boxes.some((box) => box.id.startsWith(`${runId}/pipe-`))).toBe(false);
  });
});

describe('port ownership and cuts', () => {
  const box = (id: string, min: number[], max: number[]): { id: string; min: [number, number, number]; max: [number, number, number] } => ({
    id,
    min: min as [number, number, number],
    max: max as [number, number, number],
  });

  it('a stub must clear a sibling piece that shares the id of the owner piece (two legs of an elbow)', () => {
    const owner = box('run/elbow-1', [0, 0, 0], [10, 10, 10]);
    const sibling = box('run/elbow-1', [20, 0, 0], [30, 10, 10]);
    const other = box('wall', [40, 0, 0], [50, 10, 10]);
    const split = portOwnership([owner, sibling, other], new Set(), [[5, 5, 5]]);
    expect(split.ownerIds).toEqual(['run/elbow-1']);
    expect(split.stubObstacles).toEqual([sibling, other]);
  });

  it('a keep-out never owns a port', () => {
    const keep = box('keepOutBox#0', [0, 0, 0], [10, 10, 10]);
    expect(portOwnership([keep], new Set(['keepOutBox#0']), [[5, 5, 5]])).toEqual({ ownerIds: [], stubObstacles: [keep] });
  });

  it('a tilted body is cut along its longest axis, whichever slot it is in', () => {
    const angle = (10 * Math.PI) / 180;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const body = {
      center: [0, 0, 0] as [number, number, number],
      axes: [
        [cos, sin, 0],
        [-sin, cos, 0],
        [0, 0, 1],
      ] as never,
      half: [1000, 50, 50] as [number, number, number],
    };
    const pieces = aabbs(body);
    expect(pieces.length).toBeGreaterThan(8);
    for (const piece of pieces) expect(piece.max[1] - piece.min[1]).toBeLessThan(100 + (2 * 1000 * sin) / pieces.length + 1e-9);
    expect(
      aabbs({
        ...body,
        axes: [
          [0, 0, 1],
          [-sin, cos, 0],
          [cos, sin, 0],
        ] as never,
        half: [50, 50, 1000],
      }).length,
    ).toBe(pieces.length);
  });
});
