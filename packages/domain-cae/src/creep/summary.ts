/** Bounded summary of a `creep` results artifact (PHY-11 `CreepResultsSummary`, TR-CRP-52). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import type { CreepProbeHistory, CreepResultsSummary } from '@core/model/creep';
import type { Vec3 } from '@core/model/vectors';
import { significantNumber } from '@lib/compactNumber';
import { magnitude, maxOverNodes, nodeCoordinates, nodeEntities, vonMises } from '../results/fields';
import { evaluateProbes } from '../results/probes';
import { holdSets, MAX_HISTORY_PROBES, selectIndices } from './history';

/** The last stored set must reach the duration to within this relative tolerance (rounding of the frd time column). */
const HOLD_REACHED = 1 - 1e-6;

/** `loadCases` (one entry, the end of the hold) and `creep` of a creep case. */
export function creepSummary(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  lengthToAnalysis: number,
): Pick<ResultsSummary, 'loadCases' | 'creep'> {
  const sets = holdSets(analysis, results);
  const last = sets.at(-1);
  const coordinates = nodeCoordinates(mesh);
  const entities = nodeEntities(mesh);
  const at = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  const peak = (
    best: { readonly node: number; readonly value: number } | null,
  ): { value: number; at: Vec3; entityId: string } | undefined =>
    best === null ? undefined : { value: best.value, at: at(best.node), entityId: entities.get(best.node) ?? '' };
  const ceeq = peak(maxOverNodes(last?.step.fields['PE'], (values) => values[0] ?? Number.NaN));
  const stressEnd = peak(maxOverNodes(last?.step.fields['STRESS'], vonMises));
  const displacement = maxOverNodes(last?.step.fields['DISP'], magnitude);
  const overHold = sets.reduce((best, set) => {
    const value = maxOverNodes(set.step.fields['STRESS'], vonMises)?.value;
    return value === undefined ? best : Math.max(best, value);
  }, -Infinity);
  const readings = evaluateProbes(analysis, mesh, results, lengthToAnalysis);
  const probeHistories: Record<string, CreepProbeHistory> = {};
  for (const reading of readings.slice(0, MAX_HISTORY_PROBES)) {
    const points = reading.values.flatMap((entry) => (entry.value === null ? [] : [{ tS: entry.time, value: entry.value }]));
    const kept = selectIndices(points.map((point) => point.tS)).flatMap((index) => points[index] ?? []);
    probeHistories[reading.probeId] = {
      quantity: reading.quantity,
      unit: reading.unit,
      tS: kept.map((point) => point.tS),
      values: kept.map((point) => point.value),
    };
  }
  const finalTimeS = last === undefined ? 0 : last.holdTimeS;
  const durationS = analysis.creep === undefined ? 0 : analysis.creep.durationS;
  const creep: CreepResultsSummary = {
    holdComplete: last !== undefined && finalTimeS >= durationS * HOLD_REACHED,
    finalTimeS,
    outputSets: sets.length,
    ...(ceeq !== undefined ? { maxCeeq: ceeq } : {}),
    ...(stressEnd !== undefined ? { maxVonMisesEndMPa: stressEnd } : {}),
    ...(Number.isFinite(overHold) ? { maxVonMisesOverHoldMPa: overHold } : {}),
    probeHistories,
    ...(readings.length > MAX_HISTORY_PROBES ? { probesOmitted: readings.length - MAX_HISTORY_PROBES } : {}),
  };
  const loadCases: ResultsSummary['loadCases'][number][] =
    stressEnd === undefined || displacement === null
      ? []
      : [
          {
            name: 'creep_hold_end',
            category: 'limit',
            maxVonMises: stressEnd,
            maxDisplacement: { value: displacement.value, at: at(displacement.node) },
          },
        ];
  return { loadCases, creep };
}

/** `; creep: hold reached 1000 s (complete), 50 output set(s), max creep strain 0.32, max von Mises at the end 20 MPa` for the record summary, else ''. */
export function creepSummaryText(summary: ResultsSummary): string {
  const { creep } = summary;
  if (creep === undefined) return '';
  const strain = creep.maxCeeq === undefined ? '' : `, max creep strain ${significantNumber(creep.maxCeeq.value, 4)}`;
  const stress =
    creep.maxVonMisesEndMPa === undefined ? '' : `, max von Mises at the end ${significantNumber(creep.maxVonMisesEndMPa.value, 4)} MPa`;
  return `; creep: hold reached ${significantNumber(creep.finalTimeS, 6)} s (${creep.holdComplete ? 'complete' : 'INCOMPLETE'}), ${creep.outputSets} output set(s)${strain}${stress}`;
}
