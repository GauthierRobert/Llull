/** Rules of a bolt pretension (PHY-06 FR-CNT-03), shared by add_bolt_pretension, the deck writer, the load validator and check_contact. */

import type { AnalysisCase } from '@core/model/analysis';
import type { BoltPretension, PretensionSettings } from '@core/model/contact';
import type { CadDocument } from '@core/model/types';
import { is3D } from '@core/model/types';
import { boundsCorners, entityBoundsInDoc } from '@core/geometry/bounds';
import { dot3, sub3 } from '@lib/vec3';
import { withCase } from '../shared/access';
import type { PairProblem } from './pairRules';

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

const problem = (code: string, message: string, path: string): PairProblem => ({ code, message, path });

/** Value problems of a bolt that need no document: preload numbers and nut factor, section vectors. */
export function pretensionValueProblem(bolt: Omit<BoltPretension, 'id' | 'name'>): PairProblem | null {
  const { preload, section } = bolt;
  if (preload.kind === 'force' && !positive(preload.value))
    return problem('CNT_PRELOAD_INVALID', 'preload.value must be a finite force > 0', 'preload.value');
  if (preload.kind === 'torque') {
    if (!positive(preload.nutFactor) || preload.nutFactorSource.trim() === '')
      return problem(
        'CNT_NUT_FACTOR_MISSING',
        'a torque preload needs the nut factor K (> 0) and the source of it (NASA-STD-5020 A.2-1: P = T / (K D))',
        'preload.nutFactor',
      );
    if (!positive(preload.torque) || !positive(preload.diameter))
      return problem('CNT_PRELOAD_INVALID', 'torque and diameter must be finite and > 0', 'preload.torque');
  }
  if (![...section.point, ...section.normal].every(Number.isFinite) || !(Math.hypot(...section.normal) > 0))
    return problem('CNT_PRETENSION_SECTION_INVALID', 'section.point must be finite and section.normal a non-zero finite vector', 'section');
  return null;
}

/**
 * First problem of `bolt` in `analysis`: values, the part (existing 3D part of the case), the plane against the part's bounds, the preload step
 * (a step of the case, and the first one: before it the section would be an open cut).
 * @failure CNT_PRELOAD_INVALID / CNT_NUT_FACTOR_MISSING / CNT_PRETENSION_SECTION_INVALID / FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS /
 *   CNT_STEP_UNKNOWN / CNT_PRETENSION_STEP_ORDER
 */
export function pretensionProblem(doc: CadDocument, analysis: AnalysisCase, bolt: Omit<BoltPretension, 'id' | 'name'>): PairProblem | null {
  const values = pretensionValueProblem(bolt);
  if (values !== null) return values;
  const entity = Object.hasOwn(doc.entities, bolt.entityId) ? doc.entities[bolt.entityId] : undefined;
  if (entity === undefined || !is3D(entity))
    return problem('FEA_TARGET_UNRESOLVED', `entity '${bolt.entityId}' does not exist or is not a 3D solid`, 'entityId');
  if (!Object.hasOwn(analysis.parts, bolt.entityId))
    return problem('FEA_PART_NOT_IN_ANALYSIS', `entity '${bolt.entityId}' is not a part of analysis '${analysis.id}'`, 'entityId');
  const side = boundsCorners(entityBoundsInDoc(doc, entity)).map((corner) => dot3(sub3(corner, bolt.section.point), bolt.section.normal));
  if (Math.min(...side) > 0 || Math.max(...side) < 0)
    return problem(
      'CNT_PRETENSION_SECTION_INVALID',
      `the section plane does not meet the bounds of part '${bolt.entityId}'`,
      'section.point',
    );
  const steps = analysis.nonlinear?.steps ?? {};
  if (!Object.hasOwn(steps, bolt.preloadStepId))
    return problem('CNT_STEP_UNKNOWN', `preloadStepId '${bolt.preloadStepId}' is not a step of the case`, 'preloadStepId');
  if (analysis.nonlinear?.stepOrder[0] !== bolt.preloadStepId)
    return problem(
      'CNT_PRETENSION_STEP_ORDER',
      `the preload is applied in the first step ('${analysis.nonlinear?.stepOrder[0] ?? '?'}'), not '${bolt.preloadStepId}': before it the section is an open cut`,
      'preloadStepId',
    );
  return null;
}

/** `doc` with the pretension settings of `analysis` replaced (undefined = removed). */
export function withPretension(doc: CadDocument, analysis: AnalysisCase, pretension: PretensionSettings | undefined): CadDocument {
  if (pretension !== undefined) return withCase(doc, { ...analysis, pretension });
  const { pretension: removed, ...rest } = analysis;
  void removed;
  return withCase(doc, rest);
}

/** Bolt of `settings` by id or unique name. */
export function findBolt(settings: PretensionSettings | undefined, key: string): BoltPretension | undefined {
  if (settings === undefined) return undefined;
  if (Object.hasOwn(settings.bolts, key)) return settings.bolts[key];
  const named = Object.values(settings.bolts).filter((bolt) => bolt.name === key);
  return named.length === 1 ? named[0] : undefined;
}

/** Force unit of the analysis unit system. */
export const forceUnitName = (unitSystem: AnalysisCase['unitSystem']): string => (unitSystem === 'lbf-in-slinch-s' ? 'lbf' : 'N');
