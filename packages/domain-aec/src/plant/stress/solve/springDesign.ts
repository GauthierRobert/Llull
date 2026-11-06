/**
 * Hot loads and travels of spring hangers (07 PST §5.8 steps 1 and 2): the restrained-weight solve gives the hot load of each hanger point, the operating
 * solve with the hangers replaced by their hot load as an upward force gives its vertical travel.
 */

import type { FrameLoadCase } from '@lib/frame3d/types';
import type { CadDocument } from '@core/model/types';
import { buildStressModel, isBuildFailure } from '../model/build';
import type { Contact } from '../model/restraints';
import type { OperatingConditions, SpringSelection, StressModel } from '../model/schema';
import { solveWithContacts, type NonlinearResult } from './nonlinear';
import { caseLoads } from './primitives';
import { frameElements, springSupports, withHangerLoads } from './run';

export interface HangerTarget {
  readonly id: string;
  readonly at: SpringSelection['at'];
}

export interface HangerLoad {
  readonly id: string;
  readonly node: number;
  /** Hot load the hanger carries in the restrained-weight state, N (upward on the pipe). */
  readonly hotLoadN: number;
  /** Vertical travel of the hanger point from cold to hot with the hangers carrying their hot load, mm; positive upward. */
  readonly travelUpMm: number;
}

export interface DesignFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

const DOF_NAMES = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const;

const failure = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): DesignFailure => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

export const sameLocation = (a: SpringSelection['at'], b: SpringSelection['at']): boolean =>
  'supportId' in a
    ? 'supportId' in b && a.supportId === b.supportId
    : 'pipeId' in b && a.pipeId === b.pipeId && Math.abs(a.atMm - b.atMm) < 1;

/**
 * @invariant the restrained-weight state holds each hanger point rigid in Z (two-way) with every other support as modelled; the other selected springs of the model act as they are
 * @failure no OPE case or one without the weight W -> PST_LOADCASE_INVALID; a hanger that carries no downward load -> PST_SPRING_NO_SIZE; build and solve failures with their codes
 */
export function hangerLoads(
  doc: CadDocument,
  model: StressModel,
  conditions: OperatingConditions,
  targets: readonly HangerTarget[],
  operatingCase: string | undefined,
): { readonly ok: true; readonly loads: HangerLoad[]; readonly operatingCase: string } | DesignFailure {
  const ope =
    operatingCase === undefined
      ? model.loadCases.find((entry) => entry.type === 'OPE')
      : model.loadCases.find((entry) => entry.name === operatingCase);
  if (ope === undefined || ope.type !== 'OPE')
    return failure(
      'PST_LOADCASE_INVALID',
      operatingCase === undefined ? 'the model has no OPE load case' : `no OPE load case ${operatingCase}`,
      [model.id],
      ['operatingCase'],
    );
  if (!(ope.basic ?? []).includes('W'))
    return failure(
      'PST_LOADCASE_INVALID',
      `operating case ${ope.name} has no weight W: the hanger travel needs the weight state`,
      [model.id],
      ['operatingCase'],
    );
  const probe: StressModel = {
    ...model,
    springs: [
      ...model.springs.filter((spring) => !targets.some((target) => sameLocation(target.at, spring.at))),
      ...targets.map((target) => ({
        id: target.id,
        at: target.at,
        kind: 'constant' as const,
        rateNPerMm: 0,
        hotLoadN: 1,
        coldLoadN: 1,
        travelUpMm: 0,
        variability: 0,
      })),
    ],
  };
  const built = buildStressModel(doc, probe);
  if (isBuildFailure(built)) return built;
  const nodes = targets.map((target) => (built.springs.find((spring) => spring.id === target.id) as { node: number }).node);
  const anchored = nodes.findIndex((node) => built.restraints.anchors.some((anchor) => anchor.node === node));
  if (anchored >= 0)
    return failure(
      'PST_PARAM_INVALID',
      `hanger ${(targets[anchored] as HangerTarget).id} is at an anchor (node N${(nodes[anchored] as number) + 1}): an anchor holds the point, a spring cannot carry its load`,
      [(targets[anchored] as HangerTarget).id],
      ['hangers'],
    );
  const frame = { nodes: built.layout.nodes, elements: frameElements(built, conditions) };
  const others = springSupports(built, new Set(targets.map((target) => target.id)));
  const rigid: Contact[] = nodes.flatMap((node, index) =>
    ([1, -1] as const).map((normal) => ({ node, dof: 2, normal, gapMm: 0, friction: 0, sources: [(targets[index] as HangerTarget).id] })),
  );
  const solve = (
    name: string,
    basic: readonly string[],
    contacts: readonly Contact[],
    extra: NonNullable<FrameLoadCase['nodal']>,
  ): Extract<NonlinearResult, { ok: true }> | DesignFailure => {
    const loads = caseLoads(doc, built, conditions, name, basic, model);
    if ('ok' in loads) return failure(loads.code, loads.message, [], [loads.path]);
    const anchors = built.restraints.anchors.map((anchor) => ({ node: anchor.node, values: loads.prescribed.get(anchor.node) }));
    const load = withHangerLoads({ ...loads.load, nodal: [...(loads.load.nodal ?? []), ...extra] }, others.constantEffort);
    const solved = solveWithContacts(frame, anchors, contacts, load, undefined, others.variable);
    if (solved.ok) return solved;
    const named = solved.dofs.map((dof) => `N${dof.node + 1} ${DOF_NAMES[dof.dof]}`);
    return failure(solved.code, `${name}: ${solved.message}${named.length > 0 ? ` (${named.join(', ')})` : ''}`, [
      ...solved.nodes.map((node) => `N${node + 1}`),
      ...solved.sources,
    ]);
  };
  const restrained = solve('HOT', ['W'], [...built.restraints.contacts, ...rigid], []);
  if ('code' in restrained) return restrained;
  const hot = nodes.map((node) => restrained.result.reactions[node * 6 + 2] as number);
  const empty = hot.findIndex((load) => !(load > 0));
  if (empty >= 0) {
    const id = (targets[empty] as HangerTarget).id;
    return failure(
      'PST_SPRING_NO_SIZE',
      `hanger ${id} carries no downward load in the restrained-weight state (${(hot[empty] as number).toFixed(1)} N): a hanger cannot help there`,
      [id],
    );
  }
  const operating = solve(
    'TRAVEL',
    ope.basic ?? [],
    built.restraints.contacts,
    nodes.map((node, index) => ({ node, force: [0, 0, hot[index] as number] as const })),
  );
  if ('code' in operating) return operating;
  return {
    ok: true,
    operatingCase: ope.name,
    loads: targets.map((target, index) => ({
      id: target.id,
      node: nodes[index] as number,
      hotLoadN: hot[index] as number,
      travelUpMm: operating.result.displacements[(nodes[index] as number) * 6 + 2] as number,
    })),
  };
}
