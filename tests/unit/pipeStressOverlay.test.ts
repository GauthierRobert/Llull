import { describe, expect, it } from 'vitest';
import { groupByTone, nodePositions, paintedElements, stationPosition } from '@ui/viewport/3d/pipeStress/paintedElements';
import { reactionArrows } from '@ui/viewport/3d/pipeStress/reactionArrows';
import { segmentPose } from '@ui/viewport/3d/pipeStress/segmentPose';
import type { StressRow, StressView } from '@ui/viewport/3d/pipeStress/stressView';

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

describe('segmentPose', () => {
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

/** A building pipe P1 and a run R1 on three nodes (E3 is a degenerate element), supports at N1 and N3. */
const model = (rows: StressRow[]): StressView => ({
  modelId: 'M',
  status: 'fail',
  rule: '',
  cases: [],
  rows,
  findings: [],
  inputHash: '',
  resultHash: '',
  geometry: {
    nodes: new Map([
      ['N1', [0, 0, 0]],
      ['N2', [4000, 0, 0]],
      ['N3', [4000, 3000, 0]],
    ]),
    elements: [
      { id: 'E1', pipeId: 'P1', kind: 'straight', nodeIds: ['N1', 'N2'], odMm: 100 },
      { id: 'E2', pipeId: 'R1', kind: 'straight', nodeIds: ['N2', 'N3'], odMm: 100 },
      { id: 'E3', pipeId: 'R1', kind: 'straight', nodeIds: ['N3', 'N3'], odMm: 100 },
    ],
    pipes: [
      { id: 'P1', kind: 'pipe' },
      { id: 'R1', kind: 'run' },
    ],
  },
  reactions: [
    { nodeId: 'N1', case: 'L1', forceN: [0, 0, 1000] },
    { nodeId: 'N3', case: 'L1', forceN: [0, 0, 250] },
    { nodeId: 'N1', case: 'L2', forceN: [0, -2000, 0] },
    { nodeId: 'N2', case: 'L2', forceN: [0, 0, 0] },
  ],
  displacements: [{ case: 'L2', node: 'N3', uMm: [10, 0, 0] }],
  recorded: null,
});

describe('paintedElements', () => {
  const rows = [
    row({ element: 'E1', pipeId: 'P1', ratio: 0.9 }),
    row({ element: 'E1', pipeId: 'P1', ratio: 1.3, case: 'L3' }),
    row({ element: 'E2', pipeId: 'R1', ratio: 0.2 }),
  ];

  it('tones each element (pipes and runs) by its worst station, unknown without one, in document units', () => {
    const painted = paintedElements(model(rows), null, 0, 1000);
    expect(painted.map((p) => [p.id, p.pipeId, p.tone])).toEqual([
      ['E1', 'P1', 'fail'],
      ['E2', 'R1', 'pass'],
    ]);
    expect(painted[0]?.pose).toMatchObject({ center: [2, 0, 0], length: 4 });
    expect(painted[0]?.radius).toBeCloseTo(0.062);
    expect(paintedElements(model(rows), 'L1', 0, 1000).map((p) => p.tone)).toEqual(['warn', 'pass']);
    expect(paintedElements(model(rows), 'L9', 0, 1000).map((p) => p.tone)).toEqual(['unknown', 'unknown']);
    expect(paintedElements({ ...model(rows), geometry: null }, null, 0, 1)).toEqual([]);
  });

  it('groups by tone', () => {
    const groups = groupByTone(paintedElements(model(rows), null, 0, 1));
    expect(groups.fail.map((e) => e.id)).toEqual(['E1']);
    expect(groups.pass.map((e) => e.id)).toEqual(['E2']);
    expect(groups.warn).toEqual([]);
  });

  it('moves nodes by scale x displacement of the chosen case only', () => {
    expect(nodePositions(model(rows), 'L2', 100).get('N3')).toEqual([5000, 3000, 0]);
    expect(nodePositions(model(rows), 'L1', 100).get('N3')).toEqual([4000, 3000, 0]);
    expect(nodePositions(model(rows), null, 100).get('N3')).toEqual([4000, 3000, 0]);
    expect(nodePositions(model(rows), 'L2', 0).get('N3')).toEqual([4000, 3000, 0]);
    const deformed = paintedElements(model(rows), 'L2', 100, 1);
    expect(deformed.find((p) => p.id === 'E2')?.pose.center).toEqual([4500, 1500, 0]);
  });

  it('places a station at its node or along the element by xMm', () => {
    const view = model(rows);
    expect(stationPosition(view, row({ element: 'E1', node: 'N1' }), 1000)).toEqual([0, 0, 0]);
    expect(stationPosition(view, row({ element: 'E1', node: 'N2' }), 1000)).toEqual([4, 0, 0]);
    expect(stationPosition(view, row({ element: 'E1', node: null, xMm: 1000 }), 1000)).toEqual([1, 0, 0]);
    expect(stationPosition(view, row({ element: 'E2', node: null, xMm: 99999 }), 1000)).toEqual([4, 3, 0]);
    expect(stationPosition(view, row({ element: 'E3', node: null, xMm: 5 }), 1000)).toEqual([4, 3, 0]);
    expect(stationPosition(view, row({ element: 'E9' }), 1000)).toBeNull();
    expect(stationPosition({ ...view, geometry: null }, row({}), 1000)).toBeNull();
  });
});

describe('reactionArrows', () => {
  it('draws one arrow per loaded node, tip on the node, longest for the largest force', () => {
    const arrows = reactionArrows(model([]), 'L1', 1000);
    expect(arrows.map((a) => a.nodeId)).toEqual(['N1', 'N3']);
    const [n1, n3] = arrows;
    expect(n1?.head.center[0]).toBeCloseTo(0);
    expect(n1?.head.center[2]).toBeLessThan(0);
    expect((n1?.shaft.length ?? 0) + (n1?.head.length ?? 0)).toBeGreaterThan((n3?.shaft.length ?? 0) + (n3?.head.length ?? 0));
    expect(n3?.head.center[0]).toBeCloseTo(4);
  });

  it('takes the largest force over all cases when no case is chosen, skips zero forces', () => {
    const arrows = reactionArrows(model([]), null, 1);
    expect(arrows.find((a) => a.nodeId === 'N1')?.magnitudeN).toBe(2000);
    expect(arrows.map((a) => a.nodeId)).toEqual(['N1', 'N3']);
  });

  it('draws nothing without geometry, reactions or a matching case', () => {
    expect(reactionArrows({ ...model([]), geometry: null }, null, 1)).toEqual([]);
    expect(reactionArrows({ ...model([]), reactions: [] }, null, 1)).toEqual([]);
    expect(reactionArrows(model([]), 'L9', 1)).toEqual([]);
  });
});
