/**
 * The "Moves (DOF)" check of check_prototype: the rank mobility of the rigid-body model (inspect_dynamics, TR-FPR-09), which counts loops
 * correctly where a Grubler count cannot; check_mechanism (Grubler) for kinematic joints without a dynamics model.
 * @invariant a model whose mobility cannot be computed is not_run, never a pass
 */

import type { CadDocument } from '../../model/types';
import { findingKey, worstStatus } from '../../model/checkResult';
import { hashText } from '../../lib/hash';
import { canonicalJson } from '../../lib/canonicalJson';
import { isRecord } from '../../lib/isRecord';
import type { ExecutionContext } from '../types';
import { dynamicsOf } from './bodies';
import { isCheck, skippedCheck, type PrototypeCheck, type PrototypeItem } from './prototypeVerdict';

export interface Mobility {
  readonly dof: number;
  readonly gruebler: number;
  readonly rank: number;
  readonly redundantRows: number;
  /** Loop joints open at the start pose (FPR_LOOP_OPEN) with the gap in mm. */
  readonly openLoops: readonly { readonly joint: string; readonly gapMm: number }[];
}

/** Rank mobility of the dynamics model, or null without bodies or when the topology is refused. */
export function mobilityOf(context: ExecutionContext, doc: CadDocument): Mobility | null {
  if (Object.keys(dynamicsOf(doc).bodies).length === 0) return null;
  const data = context.registry('inspect_dynamics')?.run(doc, {}, context).data;
  if (!isRecord(data) || !isRecord(data['mobility'])) return null;
  const mobility = data['mobility'];
  const problems = Array.isArray(data['problems']) ? data['problems'].filter((entry): entry is string => typeof entry === 'string') : [];
  const number = (key: string): number => (typeof mobility[key] === 'number' ? mobility[key] : 0);
  return {
    dof: number('dof'),
    gruebler: number('gruebler'),
    rank: number('rank'),
    redundantRows: Array.isArray(mobility['redundant']) ? mobility['redundant'].length : 0,
    openLoops: problems.flatMap((problem) => {
      const match = /^FPR_LOOP_OPEN: loop joint '([^']+)' is open by ([0-9.eE+-]+) mm/.exec(problem);
      return match?.[1] === undefined ? [] : [{ joint: match[1], gapMm: Number(match[2]) }];
    }),
  };
}

const item = (
  code: string,
  status: PrototypeItem['status'],
  ids: readonly string[],
  remediation: string,
  extra: Partial<PrototypeItem>,
): PrototypeItem => ({
  code,
  status,
  ids: [...ids].sort(),
  findingKey: findingKey('mechanism', code, ids),
  values: {},
  remediation,
  ...extra,
});

export function mechanismCheck(context: ExecutionContext, doc: CadDocument, mobility: Mobility | null): PrototypeCheck {
  const dynamics = dynamicsOf(doc);
  if (mobility === null) {
    if (Object.keys(dynamics.bodies).length === 0) {
      const kinematic = context.registry('check_mechanism')?.run(doc, {}, context).data;
      if (isCheck(kinematic) && kinematic.check === 'mechanism') return kinematic;
    }
    return skippedCheck(
      'mechanism',
      'FPR_MECH_NONE',
      Object.keys(dynamics.bodies).length === 0 ? 'no mechanism is defined' : 'the dynamics topology is refused (see check_dynamics)',
      'Define the mechanism (add_rigid_body, add_body_joint) and fix the topology findings of check_dynamics.',
    );
  }
  const joints = Object.keys(dynamics.joints);
  const values = { dof: mobility.dof, gruebler: mobility.gruebler, rank: mobility.rank, redundantRows: mobility.redundantRows };
  const items =
    mobility.dof <= 0
      ? [item('FPR_MECH_LOCKED', 'fail', joints, 'Nothing can move: remove a redundant joint or make a loop joint spherical.', { values })]
      : [item('FPR_MECH_OK', 'pass', joints, 'The mechanism moves.', { values })];
  // spec 5.7: an open loop is a fail that stops the motion checks; the verdict must not read ready_for_review
  for (const { joint, gapMm } of mobility.openLoops)
    items.push(
      item(
        'FPR_LOOP_OPEN',
        'fail',
        [joint],
        'Fix the anchors or the geometry so the loop pins coincide at the start pose (inspect_dynamics loopGapsM).',
        { values: { gapMm } },
      ),
    );
  return {
    check: 'mechanism',
    status: worstStatus(items.map((entry) => entry.status)),
    items,
    provenance: {
      method: 'inspect_dynamics mobility: numerical rank of the loop-constraint Jacobian at the start pose (Grubler alongside)',
      tolerances: { rankRelative: 1e-6 },
      params: {},
    },
    inputsHash: hashText(canonicalJson({ check: 'mechanism', dynamics: doc.dynamics ?? null, units: doc.units })),
    unverified: false,
    reviewRequired: true,
  };
}
