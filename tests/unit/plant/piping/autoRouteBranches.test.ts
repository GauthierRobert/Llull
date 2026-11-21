/**
 * Plant 02 RTE CAT-FU2: a branch routed together with its header in `auto_route_lines`. Numbers are those of routeBranchStart.test.ts (SC-RTE-03):
 * DN150 header 0 -> 10000 at z 3000, a DN100 branch to a tie-in at (4000, 2000, 3000) facing -Y: the 6x4 reducing tee, pieces 3857 / 5857 / 1870.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@aec/plant/types';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Line } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

function scene(): { doc: CadDocument; header: string; branch: string; headerLine: Record<string, unknown>; tieC: string } {
  const s = sceneWith(1);
  return { doc: s.doc, header: s.header, branch: s.branches[0] as string, headerLine: s.headerLine, tieC: s.tieC };
}

/** The header scene with `count` DN100 branch lines (3001, 3002 ...). */
function sceneWith(count: number): {
  doc: CadDocument;
  header: string;
  branches: string[];
  headerLine: Record<string, unknown>;
  tieC: string;
} {
  const line = cs150Line(150, '2001');
  const a = addTie(line.doc, 'TP-1', [0, 0, 3000], [1, 0, 0], { dn: 150 });
  const b = addTie(a.doc, 'TP-2', [10000, 0, 3000], [-1, 0, 0], { dn: 150 });
  const c = addTie(b.doc, 'TP-3', [4000, 2000, 3000], [0, -1, 0], { dn: 100 });
  let doc = c.doc;
  const branches: string[] = [];
  for (let k = 0; k < count; k++) {
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: String(3001 + k), spec: 'CS150', dn: 100 });
    branches.push(piping(doc).lineOrder.at(-1) as string);
  }
  return {
    doc,
    header: line.lineId,
    branches,
    headerLine: { lineId: line.lineId, from: { portId: a.id }, to: { portId: b.id } },
    tieC: c.id,
  };
}

interface BranchesData {
  routed: number;
  branches: Array<{
    lineId: string;
    status: string;
    runId?: string;
    headerRunId?: string;
    fitting?: string;
    code?: string;
    message?: string;
  }>;
}

describe('auto_route_lines with branches', () => {
  it('routes the header, then the branch to the nearest header point in one call: reducing tee, pieces 3857 / 5857 / 1870', () => {
    const s = scene();
    const params = {
      lines: [s.headerLine],
      branches: [{ lineId: s.branch, headerLineId: s.header, at: { nearTo: [4000, 2000, 3000] }, to: { portId: s.tieC } }],
    };
    const result = ok(s.doc, 'auto_route_lines', params);
    const data = result.data as BranchesData;
    expect(data.routed).toBe(1);
    expect(data.branches[0]).toMatchObject({ lineId: s.branch, status: 'routed', fitting: 'reducingTee' });
    const model = piping(result.document);
    const [headerRun, branchRun] = [model.runs[result.affected[0] as string], model.runs[result.affected[1] as string]];
    expect(branchRun).toMatchObject({ lineId: s.branch, start: { ref: { kind: 'branch', runId: headerRun?.id } } });
    expect(headerRun?.branches).toHaveLength(1);
    expect(result.summary).toContain('branches:');
    const pieces = ok(result.document, 'piping_takeoff', {}).data as { pipePieces: Array<{ cutLengthMm: number }> };
    expect(pieces.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([3857, 5857, 1870]);
    const again = execute(s.doc, 'auto_route_lines', params);
    expect(again.affected).toEqual(result.affected);
    expectPure(s.doc, () => execute(s.doc, 'auto_route_lines', params));
  });

  it('refuses by name when the branch cannot reach the header (a point beyond the header): RTE_AUTOROUTE_BRANCH_UNREACHABLE, document unchanged', () => {
    const s = scene();
    const refused = expectRefusal(
      s.doc,
      'auto_route_lines',
      {
        lines: [s.headerLine],
        branches: [{ lineId: s.branch, headerLineId: s.header, at: { leg: 7, distance: 100 }, to: { portId: s.tieC } }],
      },
      'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
      'branches.0',
    );
    expect(refused.summary).toContain('RTE_BRANCH_ON_FITTING');
    expect((refused.error?.detail as unknown as BranchesData).branches[0]).toMatchObject({
      status: 'failed',
      code: 'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
    });
  });

  it('partial keeps the header and the branches that placed; an unknown branch line is reported, not thrown', () => {
    const s = scene();
    const result = ok(s.doc, 'auto_route_lines', {
      partial: true,
      lines: [s.headerLine],
      branches: [
        { lineId: 'line-nope', headerLineId: s.header, at: { nearTo: [4000, 2000, 3000] }, legs: [{ direction: '+Y', length: 500 }] },
        { lineId: s.branch, headerLineId: s.header, at: { point: [4000, 0, 3000] }, to: { portId: s.tieC } },
      ],
    });
    const data = result.data as BranchesData;
    expect(data.branches.map((branch) => branch.status)).toEqual(['failed', 'routed']);
    expect(Object.keys(piping(result.document).runs)).toHaveLength(2);
  });

  it('partial keeps the routed header when every branch fails; invalid requests (header not in lines, branch line also routed, twice)', () => {
    const s = scene();
    const bad = { lineId: s.branch, headerLineId: s.header, at: { leg: 7, distance: 100 }, to: { portId: s.tieC } };
    const kept = ok(s.doc, 'auto_route_lines', { partial: true, lines: [s.headerLine], branches: [bad] });
    expect((kept.data as BranchesData).branches[0]?.status).toBe('failed');
    expect(kept.affected).toHaveLength(1);
    const good = { ...bad, at: { nearTo: [4000, 2000, 3000] } };
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { lines: [s.headerLine], branches: [{ ...good, headerLineId: 'other' }] },
      'RTE_AUTOROUTE_LINES_INVALID',
      'branches.0',
    );
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { lines: [s.headerLine], branches: [{ ...good, lineId: s.header }] },
      'RTE_AUTOROUTE_LINES_INVALID',
    );
    expectRefusal(s.doc, 'auto_route_lines', { lines: [s.headerLine], branches: [good, good] }, 'RTE_AUTOROUTE_LINES_INVALID');
  });

  it('a branch whose header line failed is skipped under partial, the other line is kept; without partial the header failure refuses', () => {
    const s = scene();
    const doc = apply(s.doc, 'create_pipeline', { service: 'P', sequence: '3002', spec: 'CS150', dn: 100 });
    const free = piping(doc).lineOrder.at(-1) as string;
    const broken = { ...s.headerLine, to: { portId: 'nope' } };
    const freeLine = {
      lineId: free,
      from: { point: [0, 5000, 0], direction: [1, 0, 0] },
      to: { point: [3000, 5000, 0], direction: [-1, 0, 0] },
    };
    const branches = [{ lineId: s.branch, headerLineId: s.header, at: { nearTo: [4000, 2000, 3000] }, to: { portId: s.tieC } }];
    const result = ok(doc, 'auto_route_lines', { partial: true, lines: [broken, freeLine], branches });
    expect((result.data as BranchesData).branches[0]).toMatchObject({ status: 'skipped', code: 'RTE_AUTOROUTE_BRANCH_UNREACHABLE' });
    expect(result.affected).toHaveLength(1);
    expectRefusal(doc, 'auto_route_lines', { lines: [broken], branches }, 'RTE_AUTOROUTE_LINES_FAILED');
  });

  it('under no partial a header left out of sequence refuses upfront (branches.0.headerLineId), and a skipped branch is never a silent success', () => {
    const s = scene();
    const doc = apply(s.doc, 'create_pipeline', { service: 'P', sequence: '3009', spec: 'CS150', dn: 100 });
    const free = piping(doc).lineOrder.at(-1) as string;
    const freeLine = {
      lineId: free,
      from: { point: [0, 5000, 0], direction: [1, 0, 0] },
      to: { point: [3000, 5000, 0], direction: [-1, 0, 0] },
    };
    const branches = [{ lineId: s.branch, headerLineId: s.header, at: { nearTo: [4000, 2000, 3000] }, to: { portId: s.tieC } }];
    expectRefusal(
      doc,
      'auto_route_lines',
      { order: 'given', sequence: [free], lines: [s.headerLine, freeLine], branches },
      'RTE_AUTOROUTE_LINES_INVALID',
      'branches.0.headerLineId',
    );
    const skippedOnly = execute(doc, 'auto_route_lines', {
      partial: true,
      lines: [{ ...s.headerLine, to: { portId: 'nope' } }, freeLine],
      branches,
    });
    expect(skippedOnly.rejected).toBeUndefined();
    expectRefusal(
      doc,
      'auto_route_lines',
      { lines: [{ ...s.headerLine, to: { portId: 'nope' } }, freeLine], branches },
      'RTE_AUTOROUTE_LINES_FAILED',
    );
  });

  it('two branches on one header both place (ids follow the branch order); a third on the first tee is refused as on a fitting', () => {
    const s = sceneWith(3);
    const [one, two, three] = s.branches as [string, string, string];
    const b1 = { lineId: one, headerLineId: s.header, at: { nearTo: [4000, 2000, 3000] }, to: { portId: s.tieC } };
    const b2 = {
      lineId: two,
      headerLineId: s.header,
      at: { nearTo: [7000, 500, 3000] },
      legs: [{ direction: '+Y', length: 800 }],
      dn: 100,
    };
    const result = ok(s.doc, 'auto_route_lines', { lines: [s.headerLine], branches: [b1, b2] });
    expect((result.data as BranchesData).branches.map((branch) => branch.status)).toEqual(['routed', 'routed']);
    expect(piping(result.document).runs[result.affected[0] as string]?.branches).toHaveLength(2);
    const swapped = ok(s.doc, 'auto_route_lines', { lines: [s.headerLine], branches: [b2, b1] });
    expect((swapped.data as BranchesData).branches.map((branch) => branch.lineId)).toEqual([two, one]);
    expect(swapped.affected).toHaveLength(result.affected.length);
    const colliding = { lineId: three, headerLineId: s.header, at: { point: [4000, 0, 3000] }, legs: [{ direction: '-Y', length: 800 }] };
    const refused = expectRefusal(
      s.doc,
      'auto_route_lines',
      { lines: [s.headerLine], branches: [b1, colliding] },
      'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
      'branches.1',
    );
    expect(refused.summary).toContain('RTE_BRANCH_ON_FITTING');
  });

  it('passes dn, via and angleToleranceDeg through to add_branch; distance 0 is refused by the schema', () => {
    const s = scene();
    const base = { lineId: s.branch, headerLineId: s.header };
    const viaBranch = ok(s.doc, 'auto_route_lines', {
      lines: [s.headerLine],
      branches: [
        {
          ...base,
          at: { point: [4000, 0, 3000] },
          dn: 50,
          via: [[4000, 1500, 3000]],
          to: { point: [4000, 1500, 3000] },
          angleToleranceDeg: 5,
        },
      ],
    });
    const branchRun = piping(viaBranch.document).runs[viaBranch.affected[1] as string];
    expect(branchRun).toMatchObject({ dn: 50, angleToleranceDeg: 5 });
    expect((viaBranch.data as BranchesData).branches[0]?.status).toBe('routed');
    expectRefusal(
      s.doc,
      'auto_route_lines',
      { lines: [s.headerLine], branches: [{ ...base, at: { leg: 0, distance: 0 }, to: { portId: s.tieC } }] },
      'CMD_INVALID_PARAMS',
    );
  });

  it('nearTo works on a multi-leg header: a target on the second leg picks leg 1; off the corner or beyond the end it is clamped to the straight pipe and the refusal says so', () => {
    const line = cs150Line(150, '2001');
    const a = addTie(line.doc, 'TP-1', [0, 0, 3000], [1, 0, 0], { dn: 150 });
    const b = addTie(a.doc, 'TP-2', [6000, 4000, 3000], [0, 1, 0], { dn: 150 });
    let doc = apply(b.doc, 'create_pipeline', { service: 'P', sequence: '3001', spec: 'CS150', dn: 100 });
    const branch = piping(doc).lineOrder.at(-1) as string;
    doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '3002', spec: 'CS150', dn: 100 });
    const other = piping(doc).lineOrder.at(-1) as string;
    const header = { lineId: line.lineId, from: { portId: a.id }, to: { portId: b.id } };
    const onSecond = ok(doc, 'auto_route_lines', {
      lines: [header],
      branches: [
        { lineId: branch, headerLineId: line.lineId, at: { nearTo: [8000, 2000, 3000] }, legs: [{ direction: '+X', length: 500 }] },
      ],
    });
    expect(piping(onSecond.document).runs[onSecond.affected[0] as string]?.branches?.[0]).toMatchObject({ leg: 1 });
    const corner = expectRefusal(
      doc,
      'auto_route_lines',
      {
        lines: [header],
        branches: [
          { lineId: branch, headerLineId: line.lineId, at: { nearTo: [6600, -300, 3000] }, legs: [{ direction: '+Y', length: 500 }] },
        ],
      },
      'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
    );
    expect(corner.summary).toContain('clamped');
    const beyond = expectRefusal(
      doc,
      'auto_route_lines',
      {
        lines: [header],
        branches: [{ lineId: other, headerLineId: line.lineId, at: { nearTo: [-900, 0, 3000] }, legs: [{ direction: '+Y', length: 500 }] }],
      },
      'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
    );
    expect(beyond.summary).toContain('clamped');
  });
});
