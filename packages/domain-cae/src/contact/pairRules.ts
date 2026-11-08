/** Rules of a structural contact pair (PHY-06 §4 invariants), shared by the commands, the load validator and check_contact. */

import type { AnalysisCase } from '@core/model/analysis';
import type { ContactFormulation, ContactPair, ContactSettings } from '@core/model/contact';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { withCase } from '../shared/access';
import { targetProblem } from '../shared/target';

export interface PairProblem {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const problem = (code: string, message: string, path: string): PairProblem => ({ code, message, path });

const positive = (value: number | undefined): boolean => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * First value / combination problem of `pair` under `formulation` (no document needed): behaviour values, tied only surface_to_surface,
 * smallSliding only node_to_surface, friction values (none on tied), adjust value, slave and master the same faces.
 */
export function pairValueProblem(pair: Omit<ContactPair, 'id' | 'name'>, formulation: ContactFormulation): PairProblem | null {
  const { behaviour } = pair;
  if (
    behaviour.kind === 'linear' &&
    (!positive(behaviour.slope) ||
      (behaviour.tensionAtLargeClearance !== undefined && !positive(behaviour.tensionAtLargeClearance)) ||
      (behaviour.c0 !== undefined && !positive(behaviour.c0)))
  )
    return problem('CNT_BEHAVIOUR_INVALID', 'linear needs slope > 0 (tensionAtLargeClearance, c0 > 0 when given)', 'behaviour');
  if (behaviour.kind === 'exponential' && (!positive(behaviour.c0) || !positive(behaviour.p0)))
    return problem('CNT_BEHAVIOUR_INVALID', 'exponential needs c0 > 0 and p0 > 0', 'behaviour');
  if (behaviour.kind === 'tied') {
    if (formulation !== 'surface_to_surface')
      return problem(
        'CNT_BEHAVIOUR_FORMULATION_MISMATCH',
        `tied contact is surface_to_surface penalty only, the case uses ${formulation}`,
        'behaviour',
      );
    if (!positive(behaviour.slope) || !positive(behaviour.stickSlope))
      return problem('CNT_BEHAVIOUR_INVALID', 'tied needs slope > 0 and stickSlope > 0', 'behaviour');
    if (pair.friction !== undefined) return problem('CNT_FRICTION_INVALID', 'tied pairs do not slide: give no friction', 'friction');
  }
  if (pair.smallSliding === true && formulation !== 'node_to_surface')
    return problem(
      'CNT_BEHAVIOUR_FORMULATION_MISMATCH',
      `smallSliding is node_to_surface only, the case uses ${formulation}`,
      'smallSliding',
    );
  if (
    pair.friction !== undefined &&
    (!positive(pair.friction.mu) || (pair.friction.stickSlope !== undefined && !positive(pair.friction.stickSlope)))
  )
    return problem('CNT_FRICTION_INVALID', 'friction needs mu > 0 (and stickSlope > 0 when given)', 'friction');
  if (pair.adjust?.kind === 'clearance' && !positive(pair.adjust.value))
    return problem('CNT_ADJUST_INVALID', 'adjust clearance must be > 0', 'adjust');
  if (
    pair.slave.entityId === pair.master.entityId &&
    canonicalJson(pair.slave.facesNear ?? []) === canonicalJson(pair.master.facesNear ?? [])
  )
    return problem('CNT_SELF_PAIR', 'slave and master name the same faces of the same part', 'master');
  return null;
}

/**
 * First problem of `pair` in `analysis`: targets (existing 3D part of the case, facesNear given), values, steps of activeSteps.
 * @failure codes FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS / CNT_* of `pairValueProblem` / CNT_STEP_UNKNOWN
 */
export function pairProblem(
  doc: CadDocument,
  analysis: AnalysisCase,
  pair: Omit<ContactPair, 'id' | 'name'>,
  formulation: ContactFormulation,
): PairProblem | null {
  for (const side of ['slave', 'master'] as const) {
    const target = pair[side];
    const bad = targetProblem(doc, analysis, target);
    if (bad !== null) return problem(bad.code, `${side}: ${bad.message}`, side);
    if ((target.facesNear ?? []).length === 0)
      return problem('FEA_TARGET_UNRESOLVED', `${side} needs facesNear (contact surfaces are element faces)`, side);
  }
  const values = pairValueProblem(pair, formulation);
  if (values !== null) return values;
  const steps = analysis.nonlinear?.steps ?? {};
  const unknown = (pair.activeSteps ?? []).find((stepId) => !Object.hasOwn(steps, stepId));
  if (unknown !== undefined)
    return problem('CNT_STEP_UNKNOWN', `activeSteps names '${unknown}', which is not a step of the case`, 'activeSteps');
  return null;
}

/** `doc` with the contact settings of `analysis` replaced (undefined = removed). */
export function withContact(doc: CadDocument, analysis: AnalysisCase, contact: ContactSettings | undefined): CadDocument {
  if (contact !== undefined) return withCase(doc, { ...analysis, contact });
  const { contact: removed, ...rest } = analysis;
  void removed;
  return withCase(doc, rest);
}

/** Pair of `settings` by id or unique name. */
export function findPair(settings: ContactSettings | undefined, key: string): ContactPair | undefined {
  if (settings === undefined) return undefined;
  if (Object.hasOwn(settings.pairs, key)) return settings.pairs[key];
  const named = Object.values(settings.pairs).filter((pair) => pair.name === key);
  return named.length === 1 ? named[0] : undefined;
}
