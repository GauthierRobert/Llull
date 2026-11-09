/** Residual (permanent) state after the unloading step of a solved nonlinear_static case, read from the trusted artifacts (PHY-05 FR-NLS-07). */

import type { FeMeshArtifact, FeResultsArtifact, NonlinearSettings } from '@core/model/analysis';
import type { NonlinearThresholds } from '@core/model/nonlinear';
import type { Vec3 } from '@core/model/vectors';
import { magnitude, maxOverNodes, nodeCoordinates, stepOfLoadCase } from '../results/fields';
import { unloadingStep } from './curveRules';

export interface PermanentSet {
  readonly stepId: string;
  /** Largest displacement magnitude / equivalent plastic strain of the last stored increment of that step; null when that step stored none. */
  readonly maxDisplacement: { readonly value: number; readonly at: Vec3 } | null;
  readonly maxPeeq: { readonly value: number; readonly at: Vec3 } | null;
  readonly note: string;
}

/**
 * The residual state after the last step that returns every load to zero, matched to its stored increments by POSITION in the step order (names are
 * presentation and may be renamed or duplicated). Null when the case has no unloading step.
 * @invariant pure; a step without stored increments gives an explicit note, never a bare null
 */
export function permanentSetOf(nonlinear: NonlinearSettings, mesh: FeMeshArtifact, results: FeResultsArtifact): PermanentSet | null {
  const stepId = unloadingStep(nonlinear);
  if (stepId === undefined) return null;
  const position = nonlinear.stepOrder.indexOf(stepId);
  const stored = stepOfLoadCase(results, position);
  if (stored === undefined)
    return {
      stepId,
      maxDisplacement: null,
      maxPeeq: null,
      note: `step '${stepId}' (step ${position + 1}) has no stored increment in the results: set outputIncrements to keep the last increment of each step`,
    };
  const coordinates = nodeCoordinates(mesh);
  const at = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  const displacement = maxOverNodes(stored.fields['DISP'], magnitude);
  const peeq = maxOverNodes(stored.fields['PE'], (values) => values[0] ?? Number.NaN);
  return {
    stepId,
    maxDisplacement: displacement === null ? null : { value: displacement.value, at: at(displacement.node) },
    maxPeeq: peeq === null ? null : { value: peeq.value, at: at(peeq.node) },
    note: `residual state at the last stored increment of step ${position + 1} ('${stepId}'), the step that returns every load to zero`,
  };
}

export interface PermanentSetVerdict {
  /** null: no threshold stated, or no value to compare. */
  readonly displacementExceeded: boolean | null;
  readonly peeqExceeded: boolean | null;
}

/** Comparison with the stated limits; `lengthToAnalysis` converts the DOCUMENT length unit of permanentDisplacement to the analysis unit of the results. */
export function permanentSetVerdict(
  set: PermanentSet,
  thresholds: NonlinearThresholds | undefined,
  lengthToAnalysis: number,
): PermanentSetVerdict {
  const displacementLimit = thresholds?.permanentDisplacement;
  const peeqLimit = thresholds?.permanentPeeq;
  return {
    displacementExceeded:
      displacementLimit === undefined || set.maxDisplacement === null
        ? null
        : set.maxDisplacement.value > displacementLimit.value * lengthToAnalysis,
    peeqExceeded: peeqLimit === undefined || set.maxPeeq === null ? null : set.maxPeeq.value > peeqLimit.value,
  };
}
