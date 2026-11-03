import { describe, expect, it } from 'vitest';
import {
  approvalStatus,
  elementRatios,
  parseStressView,
  ratioTone,
  TONE_COLOR,
  worstStations,
  type StressRow,
  type StressView,
} from '@ui/viewport/3d/pipeStress/stressView';

const row = (over: Partial<StressRow>): StressRow => ({
  case: 'L1',
  caseType: 'SUS',
  element: 'E1',
  pipeId: 'P1',
  node: 'N1',
  xMm: 0,
  ratio: 0.5,
  stressMPa: 10,
  allowableMPa: 20,
  rule: 'B31.3-2018',
  ...over,
});

describe('TONE_COLOR', () => {
  it('gives every tone its own colour', () => {
    expect(new Set(Object.values(TONE_COLOR)).size).toBe(4);
  });
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
    geometry: {
      nodes: [{ id: 'N1', positionMm: [0, 0, 0] }, { id: 'N2', positionMm: [1000, 0, 0] }, { id: 'N3' }],
      elements: [{ id: 'E1', pipeId: 'P1', kind: 'bend', nodeIds: ['N1', 'N2'], odMm: 100 }, { id: 'E2' }],
      pipes: [{ id: 'P1', kind: 'run' }, { id: 'P2' }, {}],
    },
    details: {
      stresses: [row({}), { case: 'L1' }, 'x'],
      reactions: [{ nodeId: 'N1', case: 'L1', forceN: [1, 2, 3] }, { nodeId: 'N2' }, 4],
      displacements: [{ case: 'L1', node: 'N2', uMm: [1, 0, 0] }, { node: 'N2' }, 4],
    },
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

  it('reads geometry, reactions and displacements, dropping malformed entries', () => {
    const view = parseStressView(data);
    expect([...(view?.geometry?.nodes ?? [])]).toEqual([
      ['N1', [0, 0, 0]],
      ['N2', [1000, 0, 0]],
    ]);
    expect(view?.geometry?.elements).toEqual([{ id: 'E1', pipeId: 'P1', kind: 'bend', nodeIds: ['N1', 'N2'], odMm: 100 }]);
    expect(view?.geometry?.pipes).toEqual([
      { id: 'P1', kind: 'run' },
      { id: 'P2', kind: 'pipe' },
    ]);
    expect(view?.reactions).toEqual([{ nodeId: 'N1', case: 'L1', forceN: [1, 2, 3] }]);
    expect(view?.displacements).toEqual([{ case: 'L1', node: 'N2', uMm: [1, 0, 0] }]);
    expect(parseStressView({ ...data, geometry: undefined })?.geometry).toBeNull();
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

  it('keeps the worst ratio per element, filtered by case, a non-finite one first', () => {
    const byElement = [
      row({ element: 'E1', ratio: 0.5 }),
      row({ element: 'E1', ratio: 1.2, case: 'L3' }),
      row({ element: 'E2', ratio: Number.NaN }),
      row({ element: 'E2', ratio: 0.95 }),
    ];
    expect(elementRatios(byElement, null).get('E1')).toBe(1.2);
    expect(elementRatios(byElement, 'L1').get('E1')).toBe(0.5);
    expect(elementRatios(byElement, null).get('E2')).toBeNaN();
    expect(elementRatios(byElement, 'L9').size).toBe(0);
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
    geometry: null,
    reactions: [],
    displacements: [],
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
