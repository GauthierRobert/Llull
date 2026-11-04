/**
 * Plant 02 RTE CAT-FU: `route_pipe` with `from: { onRun }`, the branch off a header in one transaction. Numbers are those of branches.test.ts (SC-RTE-03):
 * DN150 header 0 -> 10000 at z 3000, the 6x4 reducing tee C 143 / M 130, the 6x2 weldolet outlet face 144 mm from the header centreline.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@aec/plant/types';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { headerScene } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

function scene(dn: number): { doc: CadDocument; headerId: string; tieC: string; lineId: string } {
  const s = headerScene();
  const doc = apply(s.doc, 'create_pipeline', { service: 'P', sequence: '3001', spec: 'CS150', dn });
  return { doc, headerId: s.headerId, tieC: s.tieC, lineId: piping(doc).lineOrder.at(-1) as string };
}

interface RouteData {
  runId: string;
  branchRunId: string;
  branchId: string;
  fitting: string;
  fittingCode: string;
  pipePieces: Array<{ runId: string; cutLengthMm: number }>;
}

describe('route_pipe from a point on an existing run', () => {
  it('creates the reducing tee of the header spec and the branch run to a port in one step: pieces 3857 / 5857 / 1870', () => {
    const s = scene(100);
    const result = ok(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { onRun: { runId: s.headerId, at: { point: [4000, 0, 3000] } } },
      to: { portId: s.tieC },
    });
    const data = result.data as RouteData;
    expect(data).toMatchObject({ fitting: 'reducingTee', fittingCode: 'RT' });
    expect(data.runId).toBe(data.branchRunId);
    expect(result.affected).toEqual([data.branchRunId, data.branchId]);
    expect(data.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([3857, 5857, 1870]);
    expect(result.summary).toContain('route_pipe (branch)');
    const model = piping(result.document);
    expect(model.runs[s.headerId]?.branches).toHaveLength(1);
    expect(model.runs[data.runId]).toMatchObject({ lineId: s.lineId, dn: 100, start: { ref: { kind: 'branch', runId: s.headerId } } });
  });

  it('gives the same result as add_branch with the same arguments (the olet leaves the header whole: 1000 - 144 = 856)', () => {
    const s = scene(50);
    const viaRoute = ok(s.doc, 'route_pipe', {
      lineId: s.lineId,
      from: { onRun: { runId: s.headerId, at: { leg: 0, distance: 7000 } } },
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const viaBranch = ok(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { leg: 0, distance: 7000 },
      dn: 50,
      lineId: s.lineId,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const [a, b] = [viaRoute.data as RouteData, viaBranch.data as RouteData];
    expect(a.fitting).toBe('weldolet');
    expect(a.fitting).toBe(b.fitting);
    expect(a.pipePieces.map((piece) => piece.cutLengthMm)).toEqual(b.pipePieces.map((piece) => piece.cutLengthMm));
    expect(a.pipePieces.at(-1)?.cutLengthMm).toBe(856);
  });

  it('refuses inline components and bendRadius on a branch start, an unknown header and a branch not perpendicular; the document stays', () => {
    const s = scene(100);
    const from = { onRun: { runId: s.headerId, at: { point: [4000, 0, 3000] } } };
    const base = { lineId: s.lineId, from, to: { portId: s.tieC } };
    expectRefusal(
      s.doc,
      'route_pipe',
      { ...base, inline: [{ type: 'valveGate', at: { leg: 0, centreDistance: 500 } }] },
      'RTE_INLINE_DOES_NOT_FIT',
      'inline',
    );
    expectRefusal(s.doc, 'route_pipe', { ...base, bendRadius: 500 }, 'RTE_NO_FITTING_FOR_ANGLE', 'bendRadius');
    expectRefusal(s.doc, 'route_pipe', { ...base, from: { onRun: { runId: 'nope', at: { point: [0, 0, 3000] } } } }, 'RTE_UNKNOWN_RUN');
    const slanted = execute(s.doc, 'route_pipe', { lineId: s.lineId, from, legs: [{ direction: [1, 1, 0], length: 1000 }] });
    expect(slanted.rejected).toBe(true);
    expect(slanted.error?.code).toBe('RTE_NO_FITTING_FOR_ANGLE');
    expect(slanted.summary).toContain('route_pipe');
    expectPure(s.doc, () => execute(s.doc, 'route_pipe', { ...base }));
  });

  it('is atomic: a branch to a port of another size is refused and the header keeps no branch point', () => {
    const s = scene(50);
    const refused = expectRefusal(
      s.doc,
      'route_pipe',
      { lineId: s.lineId, from: { onRun: { runId: s.headerId, at: { point: [4000, 0, 3000] } } }, to: { portId: s.tieC } },
      'RTE_SIZE_MISMATCH',
    );
    expect(piping(refused.document).runs[s.headerId]?.branches).toBeUndefined();
  });
});
