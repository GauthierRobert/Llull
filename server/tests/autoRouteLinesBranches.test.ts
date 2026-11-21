/**
 * `auto_route` with `lines` and `branches` (plant 02 RTE CAT-FU2 follow-up): the native planner routes the header lines and commits once through
 * `auto_route_lines`, which also takes the branches off the routed headers. The single-line router is stubbed with the TypeScript search, so this
 * runs without the native binary. Scene and numbers: tests/unit/plant/piping/autoRouteBranches.test.ts (pieces 3857 / 5857 / 1870).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@aec/plant/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { buildNativeToolDefinitions } from '@protocol/nativeTools';
import { runAutoRouteLines } from '../src/native/autoRouteLines';
import type { NativeDeps } from '../src/native/fatigueField';
import { addTie, cs150Line } from '../../tests/unit/plant/piping/rteFixtures';

type Json = Record<string, unknown>;
const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

function hostOf(start: CadDocument): FeaHost & { doc: () => CadDocument } {
  let doc = start;
  return {
    doc: () => doc,
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, defaultContext());
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

/** The single-line transport with the TypeScript search in place of llull-compute. */
const routeLine = (params: Json, _options: unknown, host: FeaHost): Promise<FeaToolResult> =>
  Promise.resolve(host.applyCommand('auto_route_pipe', params) as FeaToolResult);

function scene(): { doc: CadDocument; headerLine: Json; branchLineId: string; headerId: string; tieC: string } {
  const line = cs150Line(150, '2001');
  const a = addTie(line.doc, 'TP-1', [0, 0, 3000], [1, 0, 0], { dn: 150 });
  const b = addTie(a.doc, 'TP-2', [10000, 0, 3000], [-1, 0, 0], { dn: 150 });
  const c = addTie(b.doc, 'TP-3', [4000, 2000, 3000], [0, -1, 0], { dn: 100 });
  const made = execute(c.doc, 'create_pipeline', { service: 'P', sequence: '3001', spec: 'CS150', dn: 100 }).document;
  return {
    doc: made,
    headerLine: { lineId: line.lineId, from: { portId: a.id }, to: { portId: b.id } },
    branchLineId: piping(made).lineOrder.at(-1) as string,
    headerId: line.lineId,
    tieC: c.id,
  };
}

const deps = {} as NativeDeps;

describe('auto_route lines + branches through the native planner', () => {
  it('forwards branches to the commit: the header is routed and the branch is placed in the same transaction', async () => {
    const s = scene();
    const host = hostOf(s.doc);
    const branches = [{ lineId: s.branchLineId, headerLineId: s.headerId, at: { nearTo: [4000, 2000, 3000] }, to: { portId: s.tieC } }];
    const result = await runAutoRouteLines({ lines: [s.headerLine], branches }, {}, host, deps, routeLine);
    expect(result.isError, result.summary).toBe(false);
    expect((result.data as Json)['branches']).toEqual([
      expect.objectContaining({ lineId: s.branchLineId, status: 'routed', fitting: 'reducingTee' }),
    ]);
    expect(piping(host.doc()).runOrder).toHaveLength(2);
  });

  it('without branches only the header is routed', async () => {
    const s = scene();
    const host = hostOf(s.doc);
    const result = await runAutoRouteLines({ lines: [s.headerLine] }, {}, host, deps, routeLine);
    expect(result.isError, result.summary).toBe(false);
    expect(piping(host.doc()).runOrder).toHaveLength(1);
  });

  it('a branch whose header is not in lines is refused (RTE_AUTOROUTE_LINES_INVALID) and the document is unchanged', async () => {
    const s = scene();
    const host = hostOf(s.doc);
    const branches = [{ lineId: s.branchLineId, headerLineId: 'nope', at: { nearTo: [4000, 2000, 3000] }, to: { portId: s.tieC } }];
    const result = await runAutoRouteLines({ lines: [s.headerLine], branches }, {}, host, deps, routeLine);
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('RTE_AUTOROUTE_LINES_INVALID');
    expect(host.doc()).toBe(s.doc);
  });

  it('the tool schema takes every auto_route_lines field except the ones the native planner decides', () => {
    const properties = buildNativeToolDefinitions().find((tool) => tool.name === 'auto_route')?.inputSchema.properties ?? {};
    for (const key of ['lines', 'common', 'partial', 'maxAttempts', 'branches', 'maxExpansions'])
      expect(properties[key], key).toBeDefined();
    for (const key of ['order', 'sequence']) expect(properties[key], key).toBeUndefined();
  });
});
