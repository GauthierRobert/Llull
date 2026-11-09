/** Result phases of an AM case: the stored sets (end of build, each release step), the probe sets and the bounded summary. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { magnitude, maxOverNodes, nodeCoordinates, nodeEntities, vonMises, type ResultStep } from '../results/fields';
import { amLayerPlan } from './layers';
import { amPhases } from './plan';

export interface AmResultSet {
  readonly name: string;
  readonly step: ResultStep;
}

/**
 * The stored result set of each phase that has one: `build` (the last strain step) then every release step, in order.
 * @invariant empty without a build set-up or when the layer plan is refused; a phase CalculiX did not write is omitted
 */
export function amResultSets(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  lengthToAnalysis: number,
): readonly AmResultSet[] {
  const { am } = analysis;
  if (am === undefined) return [];
  const plan = amLayerPlan(analysis, am, mesh, lengthToAnalysis);
  if ('code' in plan) return [];
  return amPhases(am, plan.layers.length).flatMap(({ name, step }) => {
    const found = results.steps.filter((candidate) => candidate.step === step).at(-1);
    return found === undefined ? [] : [{ name, step: found }];
  });
}

/**
 * Per phase the largest von Mises and displacement magnitude (the `loadCases` of the summary; category limit: no safety factor applies to a build).
 * @invariant a phase without stress or displacement fields is omitted
 */
export function amLoadCases(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  lengthToAnalysis: number,
): ResultsSummary['loadCases'] {
  const coordinates = nodeCoordinates(mesh);
  const entities = nodeEntities(mesh);
  const at = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  return amResultSets(analysis, mesh, results, lengthToAnalysis).flatMap(({ name, step }) => {
    const stress = maxOverNodes(step.fields['STRESS'], vonMises);
    const displacement = maxOverNodes(step.fields['DISP'], magnitude);
    return stress === null || displacement === null
      ? []
      : [
          {
            name,
            category: 'limit' as const,
            maxVonMises: { value: stress.value, at: at(stress.node), entityId: entities.get(stress.node) ?? '' },
            maxDisplacement: { value: displacement.value, at: at(displacement.node) },
          },
        ];
  });
}
