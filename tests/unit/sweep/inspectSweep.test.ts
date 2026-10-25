/** SWG M0/M1 queries: inspect_sweep and check_sweep_loft (validation VC-SWG-28). */
import { describe, it, expect } from 'vitest';
import { type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWith } from '../../helpers/fixtureDocument';
import { relError, runSwgPlan, swgPlan, swgValue } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

interface Sample {
  t: number;
  s: number;
  point: number[];
  tangent: number[];
  twistRad: number;
  scale: number;
  curvatureRadius: number | null;
  sectionExtent: number | null;
  margin: number | null;
}
interface InspectData {
  pathLength: number;
  sectionArea: number;
  samples: Sample[];
  totals: { twistVsMinimalRad: number; twistVsFrenetRad: number | null; integralAreaDs: number; analyticVolume: number | null };
  realisation: string;
  provenance: { method: string };
}
interface Finding {
  code: string;
  severity: string;
  entityId: string;
  at?: number;
  value: number | null;
  limit: number | null;
  remediation: string;
}
interface CheckData {
  status: string;
  checked: string[];
  findings: Finding[];
  tolerances: Record<string, { value: number; unit: string; defaulted: boolean; source: string }>;
}

const empty = createEmptyDocument();
const plan = runSwgPlan(swgPlan('target_twist_scale_orientation'));
const idOf = (alias: string): string => {
  const at = swgPlan('target_twist_scale_orientation').findIndex((a) => a.as === alias);
  return plan.steps[at]?.affected[0] as string;
};

function inspect(id: string, extra: Record<string, unknown> = {}): InspectData {
  const result = execute(plan.document, 'inspect_sweep', { id, ...extra });
  expect(result.summary).toContain('inspect_sweep');
  return result.data as InspectData;
}

describe('inspect_sweep', () => {
  it('reports frames, scale and the area integral of the quarter-arc vane (plan step 20)', () => {
    const data = inspect(idOf('vane'), { samples: 21 });
    expect(data.samples).toHaveLength(21);
    expect(data.pathLength).toBeCloseTo((Math.PI / 2) * 50, 6);
    expect(data.sectionArea).toBeCloseTo(100, 9);
    expect(data.samples[0]?.t).toBe(0);
    expect(data.samples[0]?.scale).toBeCloseTo(1, 9);
    expect(data.samples[20]?.scale).toBeCloseTo(0.5, 6);
    expect(data.samples[10]?.curvatureRadius).toBeCloseTo(50, 3);
    expect(data.totals.integralAreaDs).toBeCloseTo(swgValue('VC-SWG-09', 'linear_1_to_0.5_quarter_arc_square'), -1);
    expect(relError(data.totals.integralAreaDs, swgValue('VC-SWG-09', 'linear_1_to_0.5_quarter_arc_square'))).toBeLessThan(1e-4);
    expect(data.totals.analyticVolume).toBeNull();
    expect(data.realisation).toBe('fitted');
    expect(data.provenance.method).toBe('RMF double reflection');
  });
  it('a twisted bar reports its twist law and the matching section area integral; straight runs have no fold risk', () => {
    const data = inspect(idOf('bar90'), { at: [0, 0.5, 1] });
    expect(data.samples.map((s) => s.twistRad)).toEqual([0, expect.closeTo(Math.PI / 4, 6), expect.closeTo(Math.PI / 2, 6)]);
    expect(data.totals.twistVsMinimalRad).toBeCloseTo(Math.PI / 2, 9);
    expect(data.totals.integralAreaDs).toBeCloseTo(10000, 6);
    expect(data.samples.every((s) => s.margin === null && s.curvatureRadius === null)).toBe(true);
  });
  it('a round constant sweep is analytic and gives the Pappus volume', () => {
    const { document } = runSwgPlan([{ command: 'sweep_profile', params: { path: xyz(0, 0, 0, 0, 0, 100), radius: 10 }, as: 'p' }]);
    const id = Object.keys(document.entities)[0] as string;
    const data = execute(document, 'inspect_sweep', { id }).data as InspectData;
    expect(data.realisation).toBe('analytic');
    expect(data.totals.analyticVolume).toBeCloseTo(Math.PI * 100 * 100, 3);
  });
  it('returns the section outline on the frame only when asked', () => {
    const { document } = runSwgPlan([{ command: 'sweep_profile', params: { path: xyz(0, 0, 0, 0, 0, 100), radius: 10 }, as: 'p' }]);
    const id = Object.keys(document.entities)[0] as string;
    const plain = execute(document, 'inspect_sweep', { id, samples: 3 }).data as { samples: Array<{ outline?: number[][] }> };
    expect(plain.samples[0]?.outline).toBeUndefined();
    const data = execute(document, 'inspect_sweep', { id, samples: 3, outline: true }).data as {
      samples: Array<{ point: number[]; outline: number[][] }>;
    };
    expect(data.samples).toHaveLength(3);
    for (const sample of data.samples) {
      expect(sample.outline.length).toBeGreaterThan(8);
      for (const p of sample.outline) {
        expect(p[2]).toBeCloseTo(sample.point[2] as number, 6);
        expect(Math.hypot((p[0] as number) - (sample.point[0] as number), (p[1] as number) - (sample.point[1] as number))).toBeCloseTo(
          10,
          6,
        );
      }
    }
  });
  it('refuses unknown ids and bad sampling with stable codes, leaving the document alone', () => {
    const id = idOf('vane');
    expectNoOp(execute(plan.document, 'inspect_sweep', { id: 'nope' }), plan.document, 'SWG_ENTITY_NOT_FOUND');
    expectNoOp(execute(plan.document, 'inspect_sweep', { id, samples: 1 }), plan.document, 'SWG_PARAM_INVALID');
    expectNoOp(execute(plan.document, 'inspect_sweep', { id, at: [2] }), plan.document, 'SWG_PARAM_INVALID');
    expectNoOp(execute(plan.document, 'inspect_sweep', { id, at: [] }), plan.document, 'SWG_PARAM_INVALID');
  });
  it('is pure and read-only', () => {
    const id = idOf('vane');
    expectPure(plan.document, () => execute(plan.document, 'inspect_sweep', { id }));
    expect(execute(plan.document, 'inspect_sweep', { id }).document).toBe(plan.document);
  });
});

describe('check_sweep_loft', () => {
  it('passes over every sweep of the target plan with named, defaulted tolerances (VC-SWG-28)', () => {
    const result = execute(plan.document, 'check_sweep_loft', {});
    const data = result.data as CheckData;
    expect(data.status).toBe('pass');
    expect(data.checked).toHaveLength(9);
    expect(data.tolerances['selfIntersectionMargin']).toMatchObject({ value: 1, defaulted: true, unit: 'ratio' });
    expect(data.tolerances['selfIntersectionMargin']?.source).toContain('fold');
    expect(data.findings.every((f) => f.severity === 'info' && f.code === 'SWG_CHECK_FIT_APPROXIMATION')).toBe(true);
  });
  it('flags a swept envelope that folds (hand-built sweep: section wider than its bend)', () => {
    const doc = docWith({
      id: 'tight',
      kind: 'sweep',
      path: [
        {
          type: 'arc',
          points: [
            [0, 0, 0],
            [3.5, 3.5, 0],
            [5, 0, 0],
          ],
        },
      ],
      section: { shape: 'circle', radius: 4 },
    });
    const result = execute(doc, 'check_sweep_loft', { selfIntersectionMargin: 1.5 });
    const data = result.data as CheckData;
    expect(data.status).toBe('fail');
    const finding = data.findings.find((f) => f.code === 'SWG_CHECK_SELF_INTERSECTION_LOCAL');
    expect(finding).toMatchObject({ severity: 'fail', entityId: 'tight', limit: 1.5 });
    expect(finding?.value).toBeLessThanOrEqual(1.5);
    expect(finding?.remediation).toContain('smaller section');
    expect(data.tolerances['selfIntersectionMargin']?.defaulted).toBe(false);
  });
  it('reports a frame mode that cannot follow its path and a broken law as failing findings', () => {
    const doc = docWith(
      {
        id: 'straight',
        kind: 'sweep',
        path: [
          {
            type: 'line',
            points: [
              [0, 0, 0],
              [0, 0, 10],
            ],
          },
        ],
        section: { shape: 'circle', radius: 1 },
        orientation: { mode: 'frenet' },
      },
      {
        id: 'badlaw',
        kind: 'sweep',
        path: [
          {
            type: 'line',
            points: [
              [0, 0, 0],
              [0, 0, 10],
            ],
          },
        ],
        section: { shape: 'circle', radius: 1 },
        scale: { type: 'linear', start: 1, end: -1 },
      },
    );
    const data = execute(doc, 'check_sweep_loft', {}).data as CheckData;
    expect(data.findings.map((f) => f.code).sort()).toEqual(['SWG_CHECK_FRAME_DEGENERATE', 'SWG_CHECK_LAW_INVALID']);
    expect(data.status).toBe('fail');
  });
  it('refuses a non-sweep id and a bad tolerance; is pure', () => {
    const solid = execute(empty, 'add_box', { size: [1, 1, 1] });
    expectNoOp(execute(solid.document, 'check_sweep_loft', { ids: [solid.affected[0] as string] }), solid.document, 'SWG_ENTITY_NOT_FOUND');
    expectNoOp(execute(empty, 'check_sweep_loft', { selfIntersectionMargin: 0 }), empty, 'SWG_PARAM_INVALID');
    expectPure(plan.document, () => execute(plan.document, 'check_sweep_loft', {}));
    const sweeps = Object.values(plan.document.entities).filter((e): e is SweepEntity => e.kind === 'sweep');
    expect(execute(plan.document, 'check_sweep_loft', { ids: [sweeps[0]?.id as string] }).data).toMatchObject({ status: 'pass' });
  });
});
