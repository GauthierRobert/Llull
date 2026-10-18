/** PHY-05 fixtures: the 2 x 1 x 1 steel bar of the deck fixtures as a nonlinear_static case with a J2 perfectly plastic set `nl`. */
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { GPa, MPa, NL1_VALIDITY, ONE, T293, addModel, defineSet } from '../../physics/materials/materialFixtures';
import { X0_NODES, X2_NODES, barDocument, barMesh, facesOn, mustRun, type Bar } from '../deckFixtures';

export interface NonlinearBar extends Bar {
  readonly sets: Record<string, number[]>;
}

/** Bar with a nonlinear_static analysis, constitutive sets `nl` (elastic + J2 perfect, default) and `soft` (elastic + J2 perfect 50 MPa). */
export function nonlinearBar(): NonlinearBar {
  const bar = barDocument({ analysisType: 'nonlinear_static' });
  let doc = addModel(
    bar.doc,
    'steel',
    'elasticv',
    { kind: 'elastic_isotropic', E: GPa(210), nu: ONE(0.3) },
    { validity: T293, basis: 'A' },
  );
  for (const [id, yieldStress] of [
    ['j2', 250],
    ['j2soft', 50],
  ] as const)
    doc = addModel(
      doc,
      'steel',
      id,
      { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(yieldStress) }, kinematic: { kind: 'none' } },
      { validity: NL1_VALIDITY, basis: 'A' },
    );
  doc = defineSet(doc, 'steel', { id: 'nl', elastic: 'elasticv', plastic: 'j2' }, true);
  doc = defineSet(doc, 'steel', { id: 'soft', elastic: 'elasticv', plastic: 'j2soft' });
  const sets: Record<string, number[]> = {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
  };
  return { ...bar, doc, sets };
}

/** `command` that must succeed on `doc`: the new document and the first affected id. */
export function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

export interface PulledBar extends NonlinearBar {
  /** Probe id of the reaction/displacement curve. */
  readonly probeId: string;
  readonly stepId: string;
  readonly meshSets: Record<string, number[]>;
}

/** Nonlinear bar pulled by displacement control on the x = 2 face (1 step), with a reaction-x curve probe at node 2. */
export function pulledBar(): PulledBar {
  const bar = nonlinearBar();
  let doc = mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true, outputIncrements: 'all' });
  doc = mustRun(doc, 'set_part_constitutive_set', { analysisId: bar.analysisId, entityId: bar.boxId, constitutiveSetId: 'nl' });
  const pulled = step(doc, 'add_analysis_step', {
    analysisId: bar.analysisId,
    name: 'pull',
    multipliers: {},
    control: {
      kind: 'displacement',
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      dof: 'ux',
      value: 0.01,
      initialIncrement: 0.1,
      minIncrement: 0.001,
      maxIncrement: 0.25,
      maxIncrements: 50,
    },
  });
  const probed = step(pulled.doc, 'add_curve_probe', {
    analysisId: bar.analysisId,
    name: 'pull_curve',
    load: { kind: 'reaction', constraintId: bar.constraints['x0'], component: 'x' },
    displacement: { point: [2, 0, 0], dof: 'ux' },
  });
  return {
    ...bar,
    doc: probed.doc,
    probeId: probed.id,
    stepId: pulled.id,
    meshSets: { ...bar.sets, [`S_${pulled.id}`]: X2_NODES, [`N_${probed.id}`]: [2] },
  };
}

export const meshOf = (bar: PulledBar, doc: CadDocument = bar.doc): ReturnType<typeof barMesh> =>
  barMesh(doc, bar.analysisId, bar.boxId, bar.meshSets);

export interface PressureBar extends NonlinearBar {
  readonly loadId: string;
  readonly stepIds: readonly string[];
  readonly probeId: string;
  readonly mesh: ReturnType<typeof barMesh>;
}

/** Nonlinear bar loaded by a pressure (1 unit) on x = 2: step "up" ramps LC1 to 50, step "down" removes it; load probe on the pressure. */
export function pressureBar(
  options: { readonly amplitude?: 'ramp' | 'step'; readonly controls?: Record<string, unknown> } = {},
): PressureBar {
  const bar = nonlinearBar();
  let doc = mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: false, ...options.controls });
  const load = step(doc, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'p',
    kind: 'pressure',
    loadCase: 'LC1',
    magnitude: 1,
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  const control = { kind: 'load', initialIncrement: 0.1, minIncrement: 0.01, maxIncrement: 0.5, maxIncrements: 20 };
  const up = step(load.doc, 'add_analysis_step', {
    analysisId: bar.analysisId,
    name: 'up',
    multipliers: { LC1: 50 },
    amplitude: options.amplitude ?? 'ramp',
    control,
  });
  const down = step(up.doc, 'add_analysis_step', { analysisId: bar.analysisId, name: 'down', multipliers: { LC1: 0 }, control });
  const probe = step(down.doc, 'add_curve_probe', {
    analysisId: bar.analysisId,
    name: 'bore',
    load: { kind: 'load', loadId: load.id },
    displacement: { point: [2, 0, 0], dof: 'ux' },
  });
  doc = probe.doc;
  const mesh = barMesh(doc, bar.analysisId, bar.boxId, { ...bar.sets, [`N_${probe.id}`]: [2] }, { [`L_${load.id}`]: facesOn(X2_NODES) });
  return { ...bar, doc, loadId: load.id, stepIds: [up.id, down.id], probeId: probe.id, mesh };
}
