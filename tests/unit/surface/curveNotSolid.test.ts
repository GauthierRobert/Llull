import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { stepTargets } from '@core/commands/brep/stepTargets';
import { collectExportTriangles } from '@core/geometry/entityTriangles';

const poles = [
  [0, 0, 0],
  [1, 2, 0],
  [3, 2, 0],
  [4, 0, 0],
];

describe('3D curves are not solids', () => {
  const withCurve = execute(createEmptyDocument(), 'create_nurbs_curve', { degree: 3, poles }).document;
  const curveId = withCurve.order[0]!;
  const withBox = execute(withCurve, 'add_box', { size: [1, 1, 1] }).document;

  it('stepTargets skips a curve and keeps the solids', () => {
    const { solids, entries } = stepTargets(withBox, undefined);
    expect(solids.map((s) => s.kind)).toEqual(['box']);
    expect(entries).toHaveLength(1);
    expect(stepTargets(withBox, [curveId]).solids).toHaveLength(0);
  });

  it('mesh export parts skip a curve', () => {
    const { tris } = collectExportTriangles(withCurve, undefined);
    expect(tris).toHaveLength(0);
  });

  it('solid-only commands refuse a curve as a no-op', () => {
    const refused = execute(withBox, 'boolean', { op: 'union', a: curveId, b: withBox.order[1]! });
    expect(refused.affected).toEqual([]);
    expect(refused.document).toBe(withBox);
  });
});
