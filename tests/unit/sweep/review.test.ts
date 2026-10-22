/** DES-2 review fixes: stale helix intent, screw volumes, closed-path laws, axis crossings, check budget. */
import { describe, it, expect } from 'vitest';
import { type NurbsCurveEntity, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { pathLength } from '@core/geometry/sweepEval/evaluate';
import { sweepAnalyticVolume } from '@core/geometry/sweepEval/volume';
import { helixLength } from '@lib/helix/helix';
import { expectNoOp } from '../../helpers/expectNoOp';
import { volumeOf } from '../../helpers/fixtureDocument';
import { relError } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();

function helix(params: Record<string, unknown>): { doc: ReturnType<typeof execute>['document']; id: string } {
  const result = execute(empty, 'add_helix', params);
  return { doc: result.document, id: result.affected[0] as string };
}

describe('a changed helix curve loses its stale definition', () => {
  it('scale_entity and edit_nurbs drop `analytic`, so a later sweep does not trust the old helix', () => {
    const { doc, id } = helix({ radius: 5, pitch: 2, turns: 3 });
    const scaled = execute(doc, 'scale_entity', { id, factor: 2 }).document;
    expect((scaled.entities[id] as NurbsCurveEntity).analytic).toBeUndefined();
    const swept = execute(scaled, 'sweep_profile', { pathId: id, radius: 0.3 });
    expect(swept.affected, swept.summary).toHaveLength(1);
    expect((swept.document.entities[swept.affected[0] as string] as SweepEntity).helix).toBeUndefined();
    const edited = execute(doc, 'edit_nurbs', { id, operation: 'move_pole', index: 2, to: [9, 0, 0] }).document;
    expect((edited.entities[id] as NurbsCurveEntity).analytic).toBeUndefined();
    expect((doc.entities[id] as NurbsCurveEntity).analytic).toBeDefined();
    const kept = execute(doc, 'sweep_profile', { pathId: id, radius: 0.3 });
    expect((kept.document.entities[kept.affected[0] as string] as SweepEntity).helix).toBeDefined();
  });
});

describe('screw sweeps', () => {
  it('a round section in an axis plane has no closed form; the kernel path / mesh measures the Pappus volume', () => {
    const { doc, id } = helix({ radius: 5, pitch: 4, turns: 2 });
    const swept = execute(doc, 'sweep_profile', { pathId: id, radius: 1, orientation: { mode: 'axis_plane' } });
    expect(swept.affected, swept.summary).toHaveLength(1);
    const entity = swept.document.entities[swept.affected[0] as string] as SweepEntity;
    expect(sweepAnalyticVolume(entity)).toBeNull();
    const pappus = Math.PI * 1 * 2 * Math.PI * 5 * 2;
    expect(relError(volumeOf(entity), pappus)).toBeLessThan(0.015);
  });

  it('a section reaching across the axis is SWG_SELF_INTERSECTION_LOCAL (path frame: reach >= radius; axial frame: radius <= 0)', () => {
    const { doc, id } = helix({ radius: 5, pitch: 20, turns: 1 });
    const wide = [
      [-6, -1],
      [6, -1],
      [6, 1],
      [-6, 1],
    ];
    const crossing = execute(doc, 'sweep_profile', { pathId: id, section: wide, orientation: { mode: 'axis_plane' } });
    expectNoOp(crossing, doc, 'SWG_SELF_INTERSECTION_LOCAL');
    const axial = execute(doc, 'sweep_profile', {
      pathId: id,
      section: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      sectionFrame: 'axial',
      orientation: { mode: 'axis_plane' },
    });
    expectNoOp(axial, doc, 'SWG_SELF_INTERSECTION_LOCAL');
    const fine = execute(doc, 'sweep_profile', {
      pathId: id,
      section: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      orientation: { mode: 'axis_plane' },
    });
    expect(fine.affected).toHaveLength(1);
  });

  it('the axial extent is measured over the twisted loops: a flat strip twisted a quarter turn overlaps its neighbour turn', () => {
    const { doc, id } = helix({ radius: 10, pitch: 3, turns: 2 });
    const strip = [
      [-2, -0.5],
      [2, -0.5],
      [2, 0.5],
      [-2, 0.5],
    ];
    const flat = execute(doc, 'sweep_profile', { pathId: id, section: strip, orientation: { mode: 'axis_plane' } });
    expect(flat.affected, flat.summary).toHaveLength(1);
    const twisted = execute(doc, 'sweep_profile', {
      pathId: id,
      section: strip,
      orientation: { mode: 'axis_plane' },
      twist: { type: 'constant', value: Math.PI / 2 },
    });
    expectNoOp(twisted, doc, 'SWG_SELF_INTERSECTION_GLOBAL');
  });
});

describe('closed paths and laws', () => {
  const ring = xyz(0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0);
  const closed = { path: ring, closed: true, radius: 3, bendRadius: 20 };

  it('scale, area and stretch must return to their start value on a closed path (SWG_LAW_INVALID)', () => {
    for (const extra of [
      { scale: { type: 'linear', start: 1, end: 1.5 } },
      { area: { type: 'linear', start: 20, end: 30 } },
      { stretch: { x: { type: 'linear', start: 1, end: 2 } } },
    ])
      expectNoOp(execute(empty, 'sweep_profile', { ...closed, ...extra }), empty, 'SWG_LAW_INVALID');
    const periodic = execute(empty, 'sweep_profile', { ...closed, scale: { type: 'expression', expression: '1 + 0.1*sin(2*pi*t)' } });
    expect(periodic.affected, periodic.summary).toHaveLength(1);
  });
});

describe('path length source', () => {
  it('uses the exact helix length when the sweep keeps its helix', () => {
    const { doc, id } = helix({ radius: 20, pitch: 10, turns: 3 });
    const swept = execute(doc, 'sweep_profile', { pathId: id, radius: 2 });
    const entity = swept.document.entities[swept.affected[0] as string] as SweepEntity;
    expect(pathLength(entity)).toBe(helixLength(entity.helix as NonNullable<SweepEntity['helix']>));
  });
});

describe('check_sweep_loft budget', () => {
  it('measures at most 8 fits when ids are omitted and says so for the rest', () => {
    let doc = empty;
    for (let k = 0; k < 10; k++) {
      doc = execute(doc, 'sweep_profile', {
        path: xyz(k * 30, 0, 0, k * 30, 0, 20),
        radius: 3,
        scale: { type: 'linear', start: 1, end: 0.5 },
      }).document;
    }
    const data = execute(doc, 'check_sweep_loft', {}).data as { findings: Array<{ value: number | null; message: string }> };
    expect(data.findings).toHaveLength(10);
    expect(data.findings.filter((f) => f.value === null)).toHaveLength(2);
    expect(data.findings.find((f) => f.value === null)?.message).toContain('not measured');
  });
});
