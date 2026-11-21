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
  const line = cs150Line(150, '2001');
  const a = addTie(line.doc, 'TP-1', [0, 0, 3000], [1, 0, 0], { dn: 150 });
  const b = addTie(a.doc, 'TP-2', [10000, 0, 3000], [-1, 0, 0], { dn: 150 });
  const c = addTie(b.doc, 'TP-3', [4000, 2000, 3000], [0, -1, 0], { dn: 100 });
  const doc = apply(c.doc, 'create_pipeline', { service: 'P', sequence: '3001', spec: 'CS150', dn: 100 });
  return {
    doc,
    header: line.lineId,
    branch: piping(doc).lineOrder.at(-1) as string,
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

  it('refuses a partial request where no branch placed, and invalid requests (header not in lines, branch line also routed, twice)', () => {
    const s = scene();
    const bad = { lineId: s.branch, headerLineId: s.header, at: { leg: 7, distance: 100 }, to: { portId: s.tieC } };
    expectRefusal(s.doc, 'auto_route_lines', { partial: true, lines: [s.headerLine], branches: [bad] }, 'RTE_AUTOROUTE_BRANCH_UNREACHABLE');
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
});
