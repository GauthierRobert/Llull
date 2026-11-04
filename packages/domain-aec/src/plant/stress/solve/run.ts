/** Solve every load case of a stress model (07 PST §5.5): primitive sets with non-linear supports, EXP as an algebraic combination. */

import { pipeProperties } from '@lib/frame3d/section';
import type { FrameElement, FrameModel } from '@lib/frame3d/types';
import type { CadDocument } from '@core/model/types';
import type { BuiltModel } from '../model/build';
import type { OperatingConditions, StressModel } from '../model/schema';
import { loadCaseProblems } from './cases';
import { solveWithContacts, type ContactOutcome } from './nonlinear';
import { caseLoads } from './primitives';

export const SOLVER_VERSION = 'frame3d-1 contacts-1';

export interface CaseState {
  readonly name: string;
  readonly type: 'OPE' | 'SUS' | 'EXP' | 'OCC' | 'HYD';
  /** 6 per node, global. */
  readonly displacements: Float64Array;
  readonly reactions: Float64Array;
  /** 12 per element, local axes. */
  readonly elementForces: Float64Array;
  /** 3 per element, global uniform load (N/mm). */
  readonly uniform: Float64Array;
  readonly pressureBar: number;
  readonly maxTempC: number | null;
  readonly residual: number;
  readonly iterations: number;
  readonly contacts: readonly ContactOutcome[];
}

export interface SolveFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

export interface SolveSuccess {
  readonly ok: true;
  readonly states: readonly CaseState[];
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly ids: readonly string[] }[];
}

const DOF_NAMES = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const;

/** Stiffness multiplier of a rigid body (valve, flange): 1e4 times the pipe, so its own deformation is 1e-4 of a pipe piece of the same length. */
const RIGID_FACTOR = 1e4;

/** The frame3d elements of the built model (nominal section at the stated Young's modulus; rigid components stiffened, elastic ones scaled by their stated factor). */
export function frameElements(built: BuiltModel, conditions: OperatingConditions): FrameElement[] {
  return built.layout.elements.map((element) => ({
    a: element.a,
    b: element.b,
    properties: pipeProperties(
      element.odMm,
      element.wallMm,
      conditions.material.youngsModulusMPa *
        (element.component === undefined ? 1 : element.component.rigid ? RIGID_FACTOR : element.component.stiffnessFactor),
      conditions.material.poisson,
    ),
    ...(element.bend === undefined ? {} : { flexibility: element.bend.k }),
  }));
}

const nodeId = (index: number): string => `N${index + 1}`;

/** Number of connected components of the element graph (a model with more than one is analysed as separate sub-models). */
function componentCount(nodes: number, elements: readonly { a: number; b: number }[]): number {
  const parent = Array.from({ length: nodes }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
  for (const element of elements) parent[find(element.a)] = find(element.b);
  return new Set(parent.map((_, i) => find(i))).size;
}

/**
 * @failure invalid load cases -> PST_LOADCASE_INVALID; unreadable thermal strain -> its code; mechanism -> PST_UNSTABLE (ids = nodes, paths = DOF names);
 *   skyline over the cap -> PST_MODEL_TOO_LARGE; supports not settling -> PST_NONLINEAR_NOT_CONVERGED (ids = the restraints that toggled)
 */
export function solveModel(
  doc: Pick<CadDocument, 'materials'>,
  model: StressModel,
  built: BuiltModel,
  conditions: OperatingConditions,
): SolveSuccess | SolveFailure {
  const problems = loadCaseProblems(model.loadCases, model.forces, model.displacements);
  if (model.loadCases.length === 0) problems.push(['loadCases', 'no load cases: set_stress_load_cases']);
  model.loadCases.forEach((loadCase, index) => {
    if (
      conditions.hydro === undefined &&
      (loadCase.type === 'HYD' || (loadCase.basic ?? []).some((name) => name === 'WW' || name === 'HP'))
    )
      problems.push([`cases.${index}`, `case ${loadCase.name} needs the hydrotest conditions (set_pipe_operating_conditions hydrotest)`]);
  });
  if (problems.length > 0)
    return {
      ok: false,
      code: 'PST_LOADCASE_INVALID',
      message: problems.map(([path, message]) => `${path}: ${message}`).join('; '),
      ids: [],
      paths: problems.map(([path]) => path),
    };
  const frame: Pick<FrameModel, 'nodes' | 'elements'> = { nodes: built.layout.nodes, elements: frameElements(built, conditions) };
  const warnings: { code: string; message: string; ids: string[] }[] = [...built.warnings.map((w) => ({ ...w, ids: [...w.ids] }))];
  const parts = componentCount(frame.nodes.length, frame.elements);
  if (parts > 1)
    warnings.push({
      code: 'PST_DISCONNECTED',
      message: `the model is ${parts} separate pipe systems; each needs its own restraints`,
      ids: [],
    });
  const states = new Map<string, CaseState>();
  for (const loadCase of model.loadCases) {
    if (loadCase.type === 'EXP') continue;
    const loads = caseLoads(doc, built, conditions, loadCase.name, loadCase.basic ?? []);
    if ('ok' in loads) return { ok: false, code: loads.code, message: loads.message, ids: [], paths: [loads.path] };
    if (loads.unverified.length > 0)
      warnings.push({
        code: 'PST_MATERIAL_UNVERIFIED',
        message: `case ${loadCase.name}: ${[...new Set(loads.unverified)].join('; ')}`,
        ids: [],
      });
    const anchors = built.restraints.anchors.map((anchor) => ({ node: anchor.node, values: loads.prescribed.get(anchor.node) }));
    const solved = solveWithContacts(frame, anchors, built.restraints.contacts, loads.load);
    if (!solved.ok) {
      const named = solved.dofs.map((dof) => `${nodeId(dof.node)} ${DOF_NAMES[dof.dof]}`);
      return {
        ok: false,
        code: solved.code,
        message: `case ${loadCase.name}: ${solved.message}${named.length > 0 ? ` (${named.join(', ')})` : ''}`,
        ids: [...solved.nodes.map(nodeId), ...solved.sources],
        paths: solved.dofs.map((dof) => DOF_NAMES[dof.dof] as string),
      };
    }
    states.set(loadCase.name, {
      name: loadCase.name,
      type: loadCase.type,
      displacements: solved.result.displacements,
      reactions: solved.result.reactions,
      elementForces: solved.result.elementForces,
      uniform: loads.uniform,
      pressureBar: loads.pressureBar,
      maxTempC: loads.maxTempC,
      residual: solved.result.residual,
      iterations: solved.iterations,
      contacts: solved.contacts,
    });
  }
  for (const loadCase of model.loadCases) {
    if (loadCase.type !== 'EXP') continue;
    const terms = (loadCase.combine ?? []).map((term) => ({ state: states.get(term.case) as CaseState, factor: term.factor }));
    const mix = (pick: (state: CaseState) => Float64Array): Float64Array => {
      const out = new Float64Array(pick(terms[0]?.state as CaseState).length);
      for (const { state, factor } of terms) pick(state).forEach((value, i) => (out[i] = (out[i] as number) + factor * value));
      return out;
    };
    states.set(loadCase.name, {
      name: loadCase.name,
      type: 'EXP',
      displacements: mix((s) => s.displacements),
      reactions: mix((s) => s.reactions),
      elementForces: mix((s) => s.elementForces),
      uniform: mix((s) => s.uniform),
      pressureBar: 0,
      maxTempC: terms.reduce<number | null>(
        (largest, { state }) => (state.maxTempC === null ? largest : Math.max(largest ?? state.maxTempC, state.maxTempC)),
        null,
      ),
      residual: Math.max(0, ...terms.map(({ state }) => state.residual)),
      iterations: Math.max(0, ...terms.map(({ state }) => state.iterations)),
      contacts: [],
    });
  }
  return { ok: true, states: model.loadCases.map((loadCase) => states.get(loadCase.name) as CaseState), warnings };
}
