import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { paintedPipes } from '@ui/viewport/3d/pipeStress/paintedPipes';
import { pathMidpoint, pipePath, segmentPose } from '@ui/viewport/3d/pipeStress/pipePaths';
import {
  approvalStatus,
  parseStressView,
  ratioTone,
  worstPerPipe,
  worstStations,
  type StressRow,
  type StressView,
} from '@ui/viewport/3d/pipeStress/stressView';
import { apply } from '../helpers/commandAssertions';

const row = (over: Partial<StressRow>): StressRow => ({
  case: 'L1',
  caseType: 'SUS',
  element: 'E1',
  pipeId: 'P1',
  node: 'N1',
  ratio: 0.5,
  stressMPa: 10,
  allowableMPa: 20,
  rule: 'B31.3-2018',
  ...over,
});

describe('ratioTone', () => {
  it('follows the 0.8 / 1 ramp and never passes a non-finite ratio', () => {
    expect(ratioTone(0.79)).toBe('pass');
    expect(ratioTone(0.8)).toBe('warn');
    expect(ratioTone(1)).toBe('warn');
    expect(ratioTone(1.01)).toBe('fail');
    expect(ratioTone(Number.NaN)).toBe('fail');
    expect(ratioTone(Number.POSITIVE_INFINITY)).toBe('fail');
    expect(ratioTone(null)).toBe('unknown');
  });
});

describe('parseStressView', () => {
  const data = {
    modelId: 'SM-1',
    rule: 'B31.3-2018',
    status: 'fail',
    cases: [
      { name: 'L1', type: 'SUS', maxDisplacement: { node: 'N2', mm: 3.2 } },
      { name: 'L2', type: 'OPE', maxDisplacement: { node: 'N3', mm: 40 } },
    ],
    governing: [
      { case: 'L1', nodeId: 'N2', ratio: 0.4, rule: 'a' },
      { case: 'L1', nodeId: 'N5', ratio: 0.9, rule: 'a' },
    ],
    findings: [{ code: 'PST_SUSTAINED_OVERSTRESS', severity: 'fail', ids: ['N5'], message: 'm' }, { bogus: true }],
    inputHash: 'a',
    resultHash: 'b',
    recorded: { status: 'pass', stale: true },
    details: { stresses: [row({}), { case: 'L1' }, 'x'] },
  };

  it('reads cases with their governing ratio, rows, findings and the recorded flags', () => {
    const view = parseStressView(data);
    expect(view?.cases).toEqual([
      { name: 'L1', type: 'SUS', maxDisplacementMm: 3.2, governingRatio: 0.9, governingNode: 'N5' },
      { name: 'L2', type: 'OPE', maxDisplacementMm: 40, governingRatio: null, governingNode: null },
    ]);
    expect(view?.rows).toHaveLength(1);
    expect(view?.findings.map((f) => f.code)).toEqual(['PST_SUSTAINED_OVERSTRESS']);
    expect(view?.recorded).toEqual({ status: 'pass', stale: true });
  });

  it('returns null for a refused query (no data, or no status)', () => {
    expect(parseStressView(undefined)).toBeNull();
    expect(parseStressView({ modelId: 'SM-1', status: 'weird' })).toBeNull();
  });
});

describe('worst ratios', () => {
  const rows = [
    row({ pipeId: 'P1', ratio: 0.5 }),
    row({ pipeId: 'P1', ratio: 1.2, node: 'N2', case: 'L3', caseType: 'EXP' }),
    row({ pipeId: 'P2', ratio: Number.NaN, node: 'N7' }),
    row({ pipeId: 'P2', ratio: 0.95, node: 'N8' }),
    row({ pipeId: 'P1', ratio: 0.5 }),
  ];

  it('keeps the worst row per pipe, filtered by case, a non-finite one first', () => {
    expect(worstPerPipe(rows, null).get('P1')).toMatchObject({ ratio: 1.2, node: 'N2', case: 'L3' });
    expect(worstPerPipe(rows, 'L1').get('P1')?.ratio).toBe(0.5);
    expect(worstPerPipe(rows, null).get('P2')?.node).toBe('N7');
    expect(worstPerPipe(rows, 'L9').size).toBe(0);
  });

  it('lists the worst stations once each, worst first, within the limit', () => {
    const list = worstStations(rows, null, 3);
    expect(list.map((r) => `${r.pipeId}${r.node}`)).toEqual(['P2N7', 'P1N2', 'P2N8']);
    expect(worstStations(rows, 'L1', 10).filter((r) => r.pipeId === 'P1')).toHaveLength(1);
  });
});

describe('approvalStatus', () => {
  const view = (stale: boolean): StressView => ({
    modelId: 'M',
    status: 'pass',
    rule: '',
    cases: [],
    rows: [],
    findings: [],
    inputHash: '',
    resultHash: '',
    recorded: { status: 'pass', stale },
  });
  const recorded = { resultHash: 'r1' };

  it('is never approved on a stale record, another result hash or a refused analysis', () => {
    expect(approvalStatus({}, { ok: true, view: view(false) })).toBe('not-recorded');
    expect(approvalStatus({ recorded }, { ok: true, view: view(false) })).toBe('not-approved');
    expect(approvalStatus({ recorded, approval: { resultHash: 'r1' } }, { ok: true, view: view(false) })).toBe('approved');
    expect(approvalStatus({ recorded, approval: { resultHash: 'r0' } }, { ok: true, view: view(false) })).toBe('not-approved');
    expect(approvalStatus({ recorded, approval: { resultHash: 'r1' } }, { ok: true, view: view(true) })).toBe('stale');
    expect(approvalStatus({ recorded, approval: { resultHash: 'r1' } }, { ok: false, summary: 'refused' })).toBe('unverifiable');
  });
});

describe('pipe paths', () => {
  it('reads a building pipe centreline with its level elevation, null for anything else', () => {
    let doc = apply(createEmptyDocument(), 'add_level', { name: 'L1', elevation: 3000 });
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 500, 0],
      ],
      diameter: 114.3,
    });
    const id = doc.building?.elementOrder.find((key) => doc.building?.elements[key]?.category === 'pipe') ?? '';
    expect(pipePath(doc, id)).toMatchObject({
      points: [
        [0, 0, 3000],
        [1000, 0, 3000],
        [1000, 500, 3000],
      ],
      odMm: 114.3,
    });
    expect(pipePath(doc, 'nope')).toBeNull();
    expect(pipePath(createEmptyDocument(), id)).toBeNull();
  });

  it('finds the midpoint along the path length', () => {
    expect(
      pathMidpoint([
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ]),
    ).toEqual([10, 0, 0]);
    expect(
      pathMidpoint([
        [0, 0, 0],
        [10, 0, 0],
      ]),
    ).toEqual([5, 0, 0]);
    expect(pathMidpoint([])).toBeNull();
  });

  it('poses a cylinder: +Y keeps identity, -Y flips about X, a zero segment is dropped', () => {
    const up = segmentPose([0, 0, 0], [0, 2, 0]);
    expect(up).toMatchObject({ center: [0, 1, 0], length: 2 });
    expect(up?.quaternion[3]).toBeCloseTo(1);
    expect(segmentPose([0, 2, 0], [0, 0, 0])?.quaternion).toEqual([1, 0, 0, 0]);
    const x = segmentPose([0, 0, 0], [4, 0, 0]);
    expect(x?.length).toBe(4);
    // +Y rotated to +X is -90 degrees about Z
    expect(x?.quaternion[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(segmentPose([1, 1, 1], [1, 1, 1])).toBeNull();
  });
});

describe('paintedPipes', () => {
  const view = (rows: StressRow[]): StressView => ({
    modelId: 'M',
    status: 'fail',
    rule: '',
    cases: [],
    rows,
    findings: [],
    inputHash: '',
    resultHash: '',
    recorded: null,
  });

  it('paints each building pipe by its worst ratio and skips runs and refused analyses', () => {
    let doc = apply(createEmptyDocument(), 'add_level', { name: 'L1', elevation: 0 });
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 500, 0],
      ],
      diameter: 100,
    });
    const id = doc.building?.elementOrder.find((key) => doc.building?.elements[key]?.category === 'pipe') ?? '';
    const rows = [row({ pipeId: id, ratio: 0.9 }), row({ pipeId: id, ratio: 1.3, case: 'L3' }), row({ pipeId: 'RUN-1', ratio: 0.2 })];
    const painted = paintedPipes(doc, { ok: true, view: view(rows) }, null);
    expect(painted.map((p) => [p.pipeId, p.tone, p.segments.length])).toEqual([[id, 'fail', 2]]);
    expect(paintedPipes(doc, { ok: true, view: view(rows) }, 'L1')[0]?.tone).toBe('warn');
    expect(paintedPipes(doc, { ok: false, summary: 'PST_STRESS_NOT_FINITE' }, null)).toEqual([]);
  });
});
