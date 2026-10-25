/**
 * Plant 02 RTE V2: the first-move candidates of the reference search (docs/plant/02-spec-driven-routing §13.12). The native router runs the same
 * candidates on a rayon pool; server/tests/routeNativeParity.test.ts compares the two field for field.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { RouteProblem } from '@aec/plant/piping/autoRoute/lattice';
import { searchRoute } from '@aec/plant/piping/autoRoute/search';
import { data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from './rteFixtures';

/** SC-RTE-08 (port AR-1 at the origin facing +X, AR-2 at (3000, 2000, 1000) entered travelling +Z, DN100) with `boxes` ([centre, size]) in the way. */
function problemOf(boxes: readonly [number[], number[]][] = []): RouteProblem {
  let { doc } = cs150Line();
  const lineId = doc.plant?.piping?.lineOrder[0] as string;
  for (const [position, size] of boxes) doc = ok(doc, 'add_box', { position, size }).document;
  const a = addTie(doc, 'AR-1', [0, 0, 0], [1, 0, 0]);
  const b = addTie(a.doc, 'AR-2', [3000, 2000, 1000], [0, 0, -1]);
  const built = data<{ problem: RouteProblem }>(b.doc as CadDocument, 'route_problem', {
    lineId,
    from: { portId: a.id },
    to: { portId: b.id },
    grid: 50,
    bendCost: 1000,
  });
  return built.problem;
}

/** A U-shaped pocket (back wall and two side walls, open toward the port) around the straight path. */
const POCKET: [number[], number[]][] = [
  [
    [2000, 0, 0],
    [100, 3000, 3000],
  ],
  [
    [1250, 1450, 0],
    [1500, 100, 3000],
  ],
  [
    [1250, -1450, 0],
    [1500, 100, 3000],
  ],
];

describe('first-move candidates of the reference search', () => {
  it('free space: the straight first move wins, 110 expansions, optimal', () => {
    const result = searchRoute(problemOf(), 1_000_000);
    expect(result).toMatchObject({ status: 'found', cost: 7_600_000, bends: 2, expansions: 110, candidate: 0, optimal: true });
  });

  it('the budget is per candidate: 3 expansions each over the 5 first moves is a budget stop of 15', () => {
    expect(searchRoute(problemOf(), 3)).toEqual({ status: 'budget', expansions: 15 });
  });

  it('a pocket in front: +X (index 0) ties +Y on cost; with budget +X wins the tie, short of it +Y wins unproven', () => {
    // U-shaped pocket opening toward the port, closed at the far end: the straight first move explores the pocket (984 expansions) before
    // it escapes over the top at the same cost as the +Y first move (104 expansions).
    const problem = problemOf(POCKET);
    expect(searchRoute(problem, 1_000_000)).toMatchObject({ cost: 8_600_000, bends: 3, expansions: 984, candidate: 0, optimal: true });
    expect(searchRoute(problem, 984)).toMatchObject({ cost: 8_600_000, expansions: 984, candidate: 0, optimal: true });
    expect(searchRoute(problem, 500)).toMatchObject({ cost: 8_600_000, expansions: 104, candidate: 2, optimal: false });
  });

  it('is deterministic and independent of obstacles order: the same problem gives the same route', () => {
    const boxes: [number[], number[]][] = [
      [
        [1500, 0, 0],
        [200, 600, 600],
      ],
      [
        [3000, 1000, 400],
        [400, 300, 800],
      ],
    ];
    const problem = problemOf(boxes);
    const first = searchRoute(problem, 1_000_000);
    expect(first).toMatchObject({ status: 'found', optimal: true });
    expect(searchRoute({ ...problem, obstacles: [...problem.obstacles].reverse() }, 1_000_000)).toEqual(first);
  });

  it('closed space: every candidate exhausts its open set (no_path with the summed expansions)', () => {
    const walled: RouteProblem = { ...problemOf(), bounds: { min: [-2, -2, -2], max: [58, 42, 18] } };
    const wall = { id: 'wall', min: [1_500_000, -9_000_000, -9_000_000], max: [1_510_000, 9_000_000, 9_000_000] } as const;
    const result = searchRoute({ ...walled, obstacles: [wall] }, 1_000_000);
    expect(result.status).toBe('no_path');
    expect(result.expansions).toBeGreaterThan(0);
  });

  it('a start state that already is the goal is the straight route', () => {
    const problem = problemOf();
    const result = searchRoute({ ...problem, goal: { cell: [0, 0, 0], axis: problem.from.axis } }, 10);
    expect(result).toEqual({
      status: 'found',
      bendCells: [],
      cost: 0,
      bends: 0,
      expansions: 0,
      candidate: problem.from.axis,
      optimal: true,
    });
  });
});
