/**
 * PST-M3 support and restraint mapping: pipe supports (anchor, shoe, hanger, guide, riser guide) become restraints, extra restraints add or override,
 * the pipe sources (building pipes, 02 RTE runs with valves, branches and reducers) and the build refusals.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { valveScene } from '../piping/rteFixtures';
import {
  analyzed,
  anchorAt,
  baseDoc,
  cases,
  conditioned,
  DN100,
  disp,
  reaction,
  withModel,
  withPipe,
  type AnalysisData,
} from './m3Fixtures';

const LENGTH = 8000;

/** A DN100 pipe along `direction` (a unit step) with supports of the given types at the given arc positions, and the model that reads them. */
function supported(
  supports: Array<{ type: string; at: number[] }>,
  points: number[][] = [
    [0, 0, 3000],
    [LENGTH, 0, 3000],
  ],
  modelExtra: Record<string, unknown> = {},
): { doc: CadDocument; id: string; pipeId: string; supportIds: string[] } {
  const { doc: pipes, id: pipeId } = withPipe(baseDoc(), points, DN100.odMm);
  let d = pipes;
  for (const support of supports) d = apply(d, 'add_pipe_support', { pipeId, at: [support.at], type: support.type });
  const supportIds = Object.values(d.building?.elements ?? {})
    .filter((element) => element.category === 'pipeSupport')
    .map((element) => element.id);
  const { doc, id } = withModel(d, [pipeId], { frictionCoefficient: 0, ...modelExtra });
  return { doc: conditioned(doc, id), id, pipeId, supportIds };
}

const run = (doc: CadDocument, id: string, extra: Record<string, unknown> = {}): AnalysisData =>
  analyzed(doc, id, { include: ['reactions', 'displacements'], ...extra });

describe('pipe supports map to restraints', () => {
  it('an anchor support fixes all six degrees of freedom: it carries force and moment', () => {
    const s = supported([{ type: 'anchor', at: [0, 0, 3000] }]);
    const d = cases(s.doc, s.id, [{ name: 'W', type: 'SUS', basic: ['W'] }]);
    const load = reaction(run(d, s.id), 'W', 'N1');
    expect(load.forceN[2]).toBeGreaterThan(0);
    expect(Math.abs(load.momentNmm[1] as number)).toBeGreaterThan(1e6);
  });

  it('a shoe rests (one-way +Z): weight is carried upward, a heavy upward force lifts the pipe off it', () => {
    const s = supported([
      { type: 'anchor', at: [0, 0, 3000] },
      { type: 'shoe', at: [LENGTH, 0, 3000] },
    ]);
    const down = cases(s.doc, s.id, [{ name: 'W', type: 'SUS', basic: ['W'] }]);
    const result = run(down, s.id);
    expect(reaction(result, 'W', 'N2').forceN[2]).toBeGreaterThan(0);
    expect(result.cases[0]?.contacts[0]?.status).toBe('active');
    expect(result.cases[0]?.contacts[0]?.sources).toEqual([s.supportIds[1]]);
    const up = cases(
      s.doc,
      s.id,
      [{ name: 'U', type: 'SUS', basic: ['F1'] }],
      [{ name: 'F1', pipeId: s.pipeId, atMm: 4000, forceN: [0, 0, 5000] }],
    );
    expect(run(up, s.id).cases[0]?.contacts[0]?.status).toBe('lifted');
  });

  it('a hanger is a rest without friction; a shoe with friction slides when the pipe grows', () => {
    const grow = (type: string): AnalysisData => {
      const s = supported(
        [
          { type: 'anchor', at: [0, 0, 3000] },
          { type, at: [LENGTH, 0, 3000] },
        ],
        undefined,
        { frictionCoefficient: 0.3 },
      );
      return run(cases(s.doc, s.id, [{ name: 'H', type: 'OPE', basic: ['W', 'T1'] }]), s.id);
    };
    const hanger = grow('hanger');
    const shoe = grow('shoe');
    expect(Math.abs(reaction(hanger, 'H', 'N2').forceN[0] as number)).toBeLessThan(1e-6);
    expect(shoe.cases[0]?.contacts[0]?.status).toBe('sliding');
    expect(Math.abs(reaction(shoe, 'H', 'N2').forceN[0] as number)).toBeGreaterThan(10);
  });

  it('a guide on a horizontal pipe rests and restrains the lateral axis (two-way); the axial direction stays free', () => {
    const s = supported([
      { type: 'anchor', at: [0, 0, 3000] },
      { type: 'guide', at: [LENGTH, 0, 3000] },
    ]);
    const d = cases(
      s.doc,
      s.id,
      [{ name: 'S', type: 'SUS', basic: ['F1'] }],
      [{ name: 'F1', pipeId: s.pipeId, atMm: LENGTH, forceN: [700, 900, 0] }],
    );
    const load = reaction(run(d, s.id), 'S', 'N2');
    expect(load.forceN[1]).toBeCloseTo(-900, 4); // lateral y is held, either side
    expect(Math.abs(load.forceN[0] as number)).toBeLessThan(1e-6); // axial x is free of the guide
  });

  it('a guide on a riser restrains both horizontal axes and takes no vertical rest', () => {
    const s = supported(
      [
        { type: 'anchor', at: [0, 0, 1000] },
        { type: 'guide', at: [0, 0, 5000] },
      ],
      [
        [0, 0, 1000],
        [0, 0, 6000],
      ],
    );
    const d = cases(
      s.doc,
      s.id,
      [{ name: 'S', type: 'SUS', basic: ['F1'] }],
      [{ name: 'F1', pipeId: s.pipeId, atMm: 4000, forceN: [500, -300, 0] }],
    );
    const result = run(d, s.id);
    const guide = result.details?.reactions?.find((load) => load.supportIds.includes(s.supportIds[1] as string));
    expect(guide?.forceN[0]).toBeLessThan(0);
    expect(guide?.forceN[1]).toBeGreaterThan(0);
    expect(Math.abs(guide?.forceN[2] as number)).toBeLessThan(1e-6);
  });

  it('a guide on a pipe oblique in plan is an oblique restraint (M5a): it reacts horizontally, perpendicular to the pipe', () => {
    const s = supported(
      [
        { type: 'anchor', at: [0, 0, 3000] },
        { type: 'guide', at: [3000, 3000, 3000] },
      ],
      [
        [0, 0, 3000],
        [6000, 6000, 3000],
      ],
    );
    const d = cases(s.doc, s.id, [{ name: 'W', type: 'SUS', basic: ['W'] }]);
    const guide = run(d, s.id).details?.reactions?.find((load) => load.supportIds.includes(s.supportIds[1] as string));
    // weight only: the lateral guide carries nothing; its (oblique) reaction is zero and the vertical rest takes the load
    expect(Math.hypot(guide?.forceN[0] as number, guide?.forceN[1] as number)).toBeLessThan(1e-6);
    expect(guide?.forceN[2] as number).toBeGreaterThan(0);
  });
});

describe('extra restraints', () => {
  const beam = (extra: Record<string, unknown>, load: number[] = [0, 0, -1000], loadAt = LENGTH): { data: AnalysisData; id: string } => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [LENGTH, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId], { frictionCoefficient: 0 });
    let d = anchorAt(conditioned(doc, id), id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: LENGTH }, ...extra });
    d = cases(d, id, [{ name: 'S', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId, atMm: loadAt, forceN: load }]);
    return { data: run(d, id), id };
  };

  it('a two-way guide with a 5 mm gap lets the pipe move 5 mm and then holds it', () => {
    const { data } = beam({ kind: 'guide', gapMm: 5 }, [0, 4000, 0]);
    expect(Math.abs(disp(data, 'S', 'N2').uMm[1] as number)).toBeCloseTo(5, 6);
    expect(Math.abs(reaction(data, 'S', 'N2').forceN[1] as number)).toBeGreaterThan(0);
    expect(data.cases[0]?.contacts.map((entry) => entry.status).sort()).toEqual(['active', 'gap-open']); // the +y side closes, the -y side stays open
    const light = beam({ kind: 'guide', gapMm: 500 }, [0, 10, 0]);
    expect(light.data.cases[0]?.contacts.map((entry) => entry.status)).toEqual(['gap-open', 'gap-open']);
  });

  it('a translational one-way "-" restraint reacts along -axis only (blocks +axis motion) and a "+" one never reacts to the same load', () => {
    const blocked = beam({ kind: 'translational', axis: 'y', oneWay: '-' }, [0, 800, 0]);
    expect(reaction(blocked.data, 'S', 'N2').forceN[1]).toBeCloseTo(-800, 4);
    const free = beam({ kind: 'translational', axis: 'y', oneWay: '+' }, [0, 800, 0]);
    expect(Math.abs(reaction(free.data, 'S', 'N2').forceN[1] as number)).toBeLessThan(1e-6);
    expect(free.data.cases[0]?.contacts[0]?.status).toBe('lifted');
  });

  it('an anchor restraint at the end holds the moment too; a rest with its own friction overrides the model friction', () => {
    const anchored = beam({ kind: 'anchor' }, [0, 0, -1000], LENGTH / 2);
    expect(Math.abs(reaction(anchored.data, 'S', 'N3').momentNmm[1] as number)).toBeGreaterThan(1e5);
    const rest = beam({ kind: 'rest', frictionCoefficient: 0.5 }, [0, 0, -1000]);
    expect(rest.data.cases[0]?.contacts[0]?.status).toBe('active');
  });

  it('two restraints on the same degree of freedom and side: the later one wins and PST_RESTRAINT_OVERRIDDEN is listed', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [LENGTH, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId], { frictionCoefficient: 0 });
    let d = anchorAt(conditioned(doc, id), id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: LENGTH }, kind: 'rest' });
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: LENGTH }, kind: 'rest', gapMm: 3 });
    d = cases(d, id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    expect(analyzed(d, id).findings.map((finding) => finding.code)).toContain('PST_RESTRAINT_OVERRIDDEN');
  });

  it('a guide restraint on an oblique pipe analyses (oblique contact, two-way) and carries no load under weight alone', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [6000, 6000, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId]);
    let d = anchorAt(conditioned(doc, id), id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 4000 }, kind: 'guide' });
    const result = analyzed(cases(d, id, [{ name: 'W', type: 'SUS', basic: ['W'] }]), id);
    expect(result.status).toBeDefined();
    expect(result.findings.map((finding) => finding.code)).not.toContain('PST_NONLINEAR_NOT_CONVERGED');
  });

  it('stored restraints and forces that no longer fit the model are coded refusals at analysis, not silent', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [LENGTH, 0, 3000],
      ],
      DN100.odMm,
    );
    const other = withPipe(
      pipes,
      [
        [0, 3000, 3000],
        [3000, 3000, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(other.doc, [pipeId, other.id]);
    let d = anchorAt(conditioned(doc, id), id, pipeId, 0);
    d = apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId: other.id, atMm: 0 }, kind: 'anchor' });
    d = cases(d, id, [{ name: 'S', type: 'SUS', basic: ['F1'] }], [{ name: 'F1', pipeId: other.id, atMm: 1000, forceN: [0, 0, -10] }]);
    expect(analyzed(d, id).status).toBeDefined();
    const narrowed = apply(d, 'update_stress_model', { modelId: id, pipeIds: [pipeId] });
    expectRefusal(narrowed, 'analyze_pipe_stress', { modelId: id }, 'PST_POINT_OFF_PIPE');
    const supportless = apply(narrowed, 'set_stress_load_cases', {
      modelId: id,
      cases: [{ name: 'S', type: 'SUS', basic: ['W'] }],
      forces: [],
    });
    expectRefusal(supportless, 'analyze_pipe_stress', { modelId: id }, 'PST_POINT_OFF_PIPE');
  });
});

describe('pipe sources and the build', () => {
  it('a document that left mm is refused at analysis (plant lengths are mm)', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [LENGTH, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId]);
    const d = cases(anchorAt(conditioned(doc, id), id, pipeId, 0), id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    expectRefusal(apply(d, 'set_units', { units: 'm' }), 'analyze_pipe_stress', { modelId: id }, 'PST_PARAM_INVALID', 'units');
  });

  it('a restraint naming a support that was deleted is PST_SUPPORT_NOT_FOUND at analysis', () => {
    const s = supported([{ type: 'shoe', at: [LENGTH / 2, 0, 3000] }]);
    const added = apply(s.doc, 'add_stress_restraint', {
      modelId: s.id,
      at: { supportId: s.supportIds[0] },
      kind: 'translational',
      axis: 'y',
    });
    const gone = apply(added, 'delete_building_element', { elementIds: [s.supportIds[0]] });
    expectRefusal(
      cases(gone, s.id, [{ name: 'W', type: 'SUS', basic: ['W'] }]),
      'analyze_pipe_stress',
      { modelId: s.id },
      'PST_SUPPORT_NOT_FOUND',
    );
  });

  it('a routed run (lineId scope, bends from the RTE derivation): a valve is a rigid body, flagged until its weight is stated', () => {
    const s = valveScene();
    const created = ok(s.doc, 'create_stress_model', { name: 'P-1001', lineId: s.line, rule: 'B31.3-2018' });
    const id = (created.data as { modelId: string }).modelId;
    expect(created.document.plant?.stress?.models[id]?.scope).toEqual({ kind: 'runs', ids: [s.runId] });
    let d = anchorAt(anchorAt(conditioned(created.document, id, { wallMm: undefined }), id, s.runId, 0), id, s.runId, 1e6);
    d = cases(d, id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const result = analyzed(d, id);
    expect(result.findings.map((finding) => finding.code)).toContain('PST_COMPONENT_WEIGHT_MISSING');
    expect(result.model.pipes).toEqual([s.runId]);
    expect(result.model.elements).toBeGreaterThan(20); // the RTE bends are arcs of chords
  });

  it('a run that was deleted is PST_PIPE_NOT_FOUND at analysis', () => {
    const s = valveScene();
    const model = ok(s.doc, 'create_stress_model', { name: 'h', pipeIds: [s.runId], rule: 'B31.3-2018' });
    const id = (model.data as { modelId: string }).modelId;
    const ready = cases(conditioned(model.document, id), id, [{ name: 'S', type: 'SUS', basic: ['W'] }]);
    const broken = apply(ready, 'delete_pipe_run', { runId: s.runId });
    expectRefusal(broken, 'analyze_pipe_stress', { modelId: id }, 'PST_PIPE_NOT_FOUND');
  });
});
