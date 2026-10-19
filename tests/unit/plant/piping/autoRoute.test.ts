import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface RouteData {
  runId: string;
  pis: Vec3[];
  centrelineToPiLengthMm: number;
  bends: number;
  cost: number;
  optimal: boolean;
  expansions: number;
  engine: string;
  problemHash: string;
}

interface ProblemData {
  problem: { cellUm: number; minLegCells: number; obstacles: { id: string }[]; goal: { cell: number[]; axis: number } };
  problemHash: string;
  defaults: Record<string, number>;
  portOwners: string[];
}

/** SC-RTE-08: port AR-1 leaving +X at the origin, AR-2 at (3000, 2000, 1000) entered travelling +Z (port direction -Z), DN100 BW. */
function scenario(): { doc: CadDocument; line: string; p1: string; p2: string } {
  let doc = createEmptyDocument();
  const tie = (tag: string, position: Vec3, direction: Vec3): string => {
    const result = ok(doc, 'add_tie_in_point', { tag, position, direction, dn: 100, endType: 'BW' });
    doc = result.document;
    return result.affected[0] as string;
  };
  const p1 = tie('AR-1', [0, 0, 0], [1, 0, 0]);
  const p2 = tie('AR-2', [3000, 2000, 1000], [0, 0, -1]);
  const created = ok(doc, 'create_pipeline', { service: 'P', sequence: '8001', spec: 'CS150', dn: 100 });
  return { doc: created.document, line: created.affected[0] as string, p1, p2 };
}

/** The `solution` param equivalent to a committed route's data. */
const solutionOf = (routed: RouteData): Record<string, unknown> => ({
  problemHash: routed.problemHash,
  pis: routed.pis,
  lengthMm: routed.centrelineToPiLengthMm,
  bends: routed.bends,
  cost: routed.cost,
  optimal: routed.optimal,
  expansions: routed.expansions,
  engine: routed.engine,
});

const params = (s: ReturnType<typeof scenario>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  lineId: s.line,
  from: { portId: s.p1 },
  to: { portId: s.p2 },
  grid: 50,
  bendCost: 1000,
  ...extra,
});

describe('auto_route_pipe in free space (SC-RTE-08, VC-RTE-18)', () => {
  it('routes with Manhattan length 6000, 2 bends, optimal', () => {
    const s = scenario();
    const result = ok(s.doc, 'auto_route_pipe', params(s));
    const routed = result.data as RouteData;
    expect(routed.centrelineToPiLengthMm).toBeCloseTo(6000, 6);
    expect(routed.bends).toBe(2);
    expect(routed.optimal).toBe(true);
    expect(routed.engine).toBe('ts');
    expect(routed.pis).toHaveLength(2);
    // Lattice cost: (6000 - 2 x 200 stub) mm + 2 bends x 1000 mm, in µm.
    expect(routed.cost).toBe(5_600_000 + 2_000_000);
    const run = result.document.plant?.piping?.runs[routed.runId];
    expect(run?.start.ref).toEqual({ kind: 'tieIn', id: s.p1 });
    expect(run?.autoRoute?.engine).toBe('ts');
    const entity = result.document.entities[routed.runId];
    expect(entity?.kind).toBe('mesh');
    expect(entity?.layerId).toBe('layer-P-PIPE');
    expect(result.affected).toEqual([routed.runId]);
  });

  it('is deterministic: the same document and params give the same run, data and problem hash', () => {
    const s = scenario();
    const first = ok(s.doc, 'auto_route_pipe', params(s));
    const second = ok(s.doc, 'auto_route_pipe', params(s));
    expect(second.data).toEqual(first.data);
    expect(second.document.plant).toEqual(first.document.plant);
  });

  it('is pure', () => {
    const s = scenario();
    const before = structuredClone(s.doc);
    execute(s.doc, 'auto_route_pipe', params(s));
    expect(s.doc).toEqual(before);
  });

  it('goes around a box blocking the straight first leg, clash-free, and never shorter', () => {
    const s = scenario();
    const withBox = apply(s.doc, 'add_box', { size: [400, 400, 400], position: [1500, 0, 0] });
    const routed = data<RouteData>(withBox, 'auto_route_pipe', params(s));
    expect(routed.centrelineToPiLengthMm).toBeGreaterThanOrEqual(6000);
    const problem = data<ProblemData>(withBox, 'route_problem', params(s));
    expect(problem.problem.obstacles.length).toBeGreaterThan(0);
    // The validator re-checks the committed route against the inflated box.
    const replay = execute(withBox, 'auto_route_pipe', { ...params(s), solution: solutionOf(routed) });
    expect(replay.rejected, replay.summary).toBeUndefined();
    expect(routed.problemHash).toBe(problem.problemHash);
  });
});

describe('route_problem', () => {
  it('reports the canonical problem, its hash and the named defaults; read-only', () => {
    const s = scenario();
    const result = ok(s.doc, 'route_problem', { lineId: s.line, from: { portId: s.p1 }, to: { portId: s.p2 } });
    const answer = result.data as ProblemData;
    expect(result.document).toBe(s.doc);
    expect(answer.problemHash).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.defaults).toEqual({ grid: 50, bendCost: 1000, clearance: 50, gridMargin: 2000 });
    // stub = ceil(152 / 50) cells = 200 mm; minimum leg ceil(304 / 50) = 7 cells.
    expect(answer.problem.minLegCells).toBe(7);
    expect(answer.problem.goal).toEqual({ cell: [56, 40, 16], axis: 4 });
    expect(data<ProblemData>(s.doc, 'route_problem', { lineId: s.line, from: { portId: s.p1 }, to: { portId: s.p2 } }).problemHash).toBe(
      answer.problemHash,
    );
  });

  it.each([
    ['RTE_UNKNOWN_LINE', { lineId: 'line-nope' }, 'lineId'],
    ['RTE_UNKNOWN_PORT', { from: { portId: 'tie-nope' } }, 'from.portId'],
    ['RTE_PORT_DIRECTION', { from: { point: [0, 0, 0], direction: [1, 1, 0] } }, 'from'],
    ['RTE_UNKNOWN_KEEPOUT', { keepOut: ['box-nope'] }, 'keepOut'],
    ['RTE_AUTOROUTE_NO_PATH', { grid: 70 }, 'grid'],
    ['RTE_SPEC_NO_COMPONENT', { elbowCentreToEnd: undefined, lineId: 'dn65' }, 'elbowCentreToEnd'],
  ])('refuses %s', (code, extra, path) => {
    const s = scenario();
    let doc = s.doc;
    let overrides: Record<string, unknown> = extra;
    if (extra.lineId === 'dn65') {
      const created = ok(doc, 'create_pipeline', { service: 'P', sequence: '8002', spec: 'CS150', dn: 65 });
      doc = created.document;
      overrides = {
        lineId: created.affected[0],
        from: { point: [0, 0, 0], direction: [1, 0, 0] },
        to: { point: [3000, 0, 0], direction: [-1, 0, 0] },
      };
    }
    expectRefusal(doc, 'route_problem', params(s, overrides), code, path);
  });

  it('refuses a port of another size (RTE_SIZE_MISMATCH) and a flanged port without flangeSetLength', () => {
    const s = scenario();
    const small = ok(s.doc, 'add_tie_in_point', { tag: 'S', position: [0, 0, 500], direction: [1, 0, 0], dn: 50, endType: 'BW' });
    expectRefusal(small.document, 'route_problem', params(s, { from: { portId: small.affected[0] } }), 'RTE_SIZE_MISMATCH', 'from.portId');
    const flanged = ok(s.doc, 'add_tie_in_point', { tag: 'F', position: [0, 0, 500], direction: [1, 0, 0], dn: 100, endType: 'FL' });
    const flangedParams = params(s, { from: { portId: flanged.affected[0] } });
    expectRefusal(flanged.document, 'route_problem', flangedParams, 'RTE_SPEC_NO_COMPONENT', 'flangeSetLength');
    const routed = data<RouteData>(flanged.document, 'auto_route_pipe', { ...flangedParams, flangeSetLength: 79 });
    expect(routed.bends).toBeGreaterThanOrEqual(2);
  });

  it('refuses a second run from a connected tie-in (RTE_PORT_IN_USE)', () => {
    const s = scenario();
    const routed = apply(s.doc, 'auto_route_pipe', params(s));
    expectRefusal(routed, 'route_problem', params(s), 'RTE_PORT_IN_USE', 'from.portId');
  });

  it('refuses a stub that runs into an obstacle', () => {
    const s = scenario();
    const blocked = apply(s.doc, 'add_box', { size: [100, 400, 400], position: [250, 0, 0] });
    expectRefusal(blocked, 'route_problem', params(s), 'RTE_AUTOROUTE_NO_PATH', 'from');
  });
});

type Solution = Record<string, unknown>;

describe('auto_route_pipe with a supplied solution (VC-RTE-25 validation half)', () => {
  const routedOnce = (): { s: ReturnType<typeof scenario>; routed: RouteData } => {
    const s = scenario();
    return { s, routed: data<RouteData>(s.doc, 'auto_route_pipe', params(s)) };
  };

  it('commits a valid solution with its engine and numbers', () => {
    const { s, routed } = routedOnce();
    const result = ok(s.doc, 'auto_route_pipe', {
      ...params(s),
      solution: { ...solutionOf(routed), engine: 'llull-route', expansions: 7 },
    });
    const run = result.document.plant?.piping?.runs[result.affected[0] as string];
    expect(run?.autoRoute).toEqual({
      problemHash: routed.problemHash,
      cost: routed.cost,
      bends: 2,
      expansions: 7,
      optimal: true,
      engine: 'llull-route',
    });
    expect(run?.pis).toEqual(routed.pis);
  });

  const shiftFirst = (sol: Solution): Solution => ({
    ...sol,
    pis: (sol['pis'] as Vec3[]).map((p, i) => (i === 0 ? [p[0], p[1] + 10, p[2]] : p)),
  });
  const collinear = (sol: Solution): Solution => {
    const pis = sol['pis'] as Vec3[];
    const first = pis[0] as Vec3;
    return { ...sol, pis: [[first[0] - 100, 0, 0], ...pis], bends: 3 };
  };
  it.each([
    ['a stale problem hash', (sol: Solution): Solution => ({ ...sol, problemHash: '0'.repeat(64) }), 'solution.problemHash'],
    ['a cost that does not match', (sol: Solution): Solution => ({ ...sol, cost: (sol['cost'] as number) + 1 }), 'solution.cost'],
    ['a wrong bend count', (sol: Solution): Solution => ({ ...sol, bends: 3 }), 'solution.bends'],
    ['a wrong length', (sol: Solution): Solution => ({ ...sol, lengthMm: 5999 }), 'solution.lengthMm'],
    ['an off-axis PI', shiftFirst, 'solution.pis.0'],
    ['a missing PI', (sol: Solution): Solution => ({ ...sol, pis: (sol['pis'] as Vec3[]).slice(1), bends: 1 }), 'solution.pis.0'],
    ['an unmerged collinear PI', collinear, 'solution.pis.0'],
  ])('refuses %s with RTE_AUTOROUTE_SOLUTION_INVALID and leaves the document unchanged', (_label, tamper, path) => {
    const { s, routed } = routedOnce();
    expectRefusal(s.doc, 'auto_route_pipe', { ...params(s), solution: tamper(solutionOf(routed)) }, 'RTE_AUTOROUTE_SOLUTION_INVALID', path);
  });

  it('refuses a leg through an obstacle even with a fresh hash', () => {
    const { s, routed } = routedOnce();
    const first = routed.pis[0] as Vec3;
    const blocked = apply(s.doc, 'add_box', { size: [200, 200, 200], position: [first[0] - 1000, 0, 0] });
    const fresh = data<ProblemData>(blocked, 'route_problem', params(s)).problemHash;
    const solution = { ...solutionOf(routed), problemHash: fresh };
    const result = expectRefusal(blocked, 'auto_route_pipe', { ...params(s), solution }, 'RTE_AUTOROUTE_SOLUTION_INVALID');
    expect(result.summary).toContain('enters obstacle');
  });

  it('refuses a solution that leaves a port sideways', () => {
    const { s } = routedOnce();
    const hash = data<ProblemData>(s.doc, 'route_problem', params(s)).problemHash;
    const sideways = {
      problemHash: hash,
      pis: [
        [0, 2000, 0],
        [3000, 2000, 0],
      ],
      lengthMm: 6000,
      bends: 2,
      cost: 0,
      optimal: false,
      expansions: 0,
      engine: 'hand',
    };
    expectRefusal(s.doc, 'auto_route_pipe', { ...params(s), solution: sideways }, 'RTE_AUTOROUTE_SOLUTION_INVALID', 'solution.pis');
  });
});

describe('auto_route_pipe search limits and preferences', () => {
  it('refuses RTE_AUTOROUTE_BUDGET under a tiny cap and above the in-process cap', () => {
    const s = scenario();
    expectRefusal(s.doc, 'auto_route_pipe', params(s, { maxExpansions: 1 }), 'RTE_AUTOROUTE_BUDGET', 'maxExpansions');
    expectRefusal(s.doc, 'auto_route_pipe', params(s, { maxExpansions: 10_000_000 }), 'RTE_AUTOROUTE_BUDGET', 'maxExpansions');
  });

  it('refuses RTE_AUTOROUTE_NO_PATH when a keep-out wall closes the grid box', () => {
    const s = scenario();
    const wall = { min: [1500, -5000, -5000], max: [1510, 5000, 5000] };
    expectRefusal(s.doc, 'auto_route_pipe', params(s, { grid: 100, gridMargin: 100, keepOutBoxes: [wall] }), 'RTE_AUTOROUTE_NO_PATH', 'gridMargin');
  });

  it('runs horizontal pipe on a preferred rack elevation', () => {
    const a = ok(createEmptyDocument(), 'add_tie_in_point', {
      tag: 'A',
      position: [0, 0, 0],
      direction: [1, 0, 0],
      dn: 100,
      endType: 'BW',
    });
    const b = ok(a.document, 'add_tie_in_point', { tag: 'B', position: [6000, 2000, 0], direction: [-1, 0, 0], dn: 100, endType: 'BW' });
    const line = ok(b.document, 'create_pipeline', { service: 'P', sequence: '9', spec: 'CS150', dn: 100 });
    const base = { lineId: line.affected[0], from: { portId: a.affected[0] }, to: { portId: b.affected[0] }, bendCost: 100 };
    const flat = data<RouteData>(line.document, 'auto_route_pipe', base);
    expect(flat.pis.every((p) => p[2] === 0)).toBe(true);
    const rack = data<RouteData>(line.document, 'auto_route_pipe', { ...base, preferElevations: [1000], elevationPenalty: 2 });
    expect(rack.pis.some((p) => p[2] === 1000)).toBe(true);
    expect(rack.centrelineToPiLengthMm).toBeGreaterThan(flat.centrelineToPiLengthMm);
  });

  it('treats the box a port sits on as its owner, unless it is listed in keepOut', () => {
    const s = scenario();
    const boxed = ok(s.doc, 'add_box', { size: [100, 100, 100], position: [0, 0, 0] });
    const boxId = boxed.affected[0] as string;
    expect(data<ProblemData>(boxed.document, 'route_problem', params(s)).portOwners).toEqual([boxId]);
    expect(data<RouteData>(boxed.document, 'auto_route_pipe', params(s)).bends).toBe(2);
    expectRefusal(boxed.document, 'route_problem', params(s, { keepOut: [boxId] }), 'RTE_AUTOROUTE_NO_PATH', 'from');
  });

  it('routes several lines one after the other: each run is an obstacle for the next', () => {
    const s = scenario();
    const first = ok(s.doc, 'auto_route_pipe', params(s));
    const firstRun = first.affected[0] as string;
    const c = ok(first.document, 'add_tie_in_point', {
      tag: 'C',
      position: [1500, -1000, 0],
      direction: [0, 1, 0],
      dn: 100,
      endType: 'BW',
    });
    const d = ok(c.document, 'add_tie_in_point', { tag: 'D', position: [1500, 3000, 0], direction: [0, -1, 0], dn: 100, endType: 'BW' });
    const line = ok(d.document, 'create_pipeline', { service: 'P', sequence: '8003', spec: 'CS150', dn: 100 });
    const second = { lineId: line.affected[0], from: { portId: c.affected[0] }, to: { portId: d.affected[0] }, bendCost: 1000 };
    const problem = data<ProblemData>(line.document, 'route_problem', second);
    expect(problem.problem.obstacles.map((box) => box.id)).toContain(`${firstRun}#leg0`);
    expect(data<RouteData>(line.document, 'auto_route_pipe', second).bends).toBeGreaterThan(0);
  });
});
