/** Per-increment results of a transient coupled_temperature_displacement step (PHY-04 M4b): the series, its peaks and the load case they stand for. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ResultsSummary, ThermomechTransientSummary } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { significantNumber } from '@lib/compactNumber';
import { preheatPeriodS } from './preheat';
import { isTransientCase } from '../thermal/access';
import { magnitude, nodeCoordinates, nodeEntities, vonMises, type ResultStep } from '../results/fields';

const scalar = (values: readonly number[]): number => values[0] ?? Number.NaN;

/** Largest (`sign` 1) or smallest (`sign` -1) scalar over the nodes of a field; null for a missing / empty field. */
function extreme(
  field: ResultStep['fields'][string] | undefined,
  read: (values: readonly number[]) => number,
  sign: 1 | -1,
): { readonly node: number; readonly value: number } | null {
  let best: { node: number; value: number } | null = null;
  for (const [id, values] of Object.entries(field?.values ?? {})) {
    const value = read(values);
    if (Number.isFinite(value) && (best === null || sign * value > sign * best.value)) best = { node: Number(id), value };
  }
  return best;
}

/**
 * Series of the last CalculiX step of a transient coupled case: every written increment with DISP, STRESS and NDTEMP gives max von Mises,
 * max displacement magnitude and the temperature extremes at its time (seconds from the start of the coupled step: the increments' total
 * time minus the period of the pre-heating step written before it, 0 without one), plus the peaks over time (first one wins ties).
 * `loadCase` is the entry `resultsSummary` records for it: the PEAK over time, which is what margins must use.
 * @failure not a transient coupled case, or no increment with the three fields -> undefined
 */
export function transientResults(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): { readonly summary: ThermomechTransientSummary; readonly loadCases: ResultsSummary['loadCases'] } | undefined {
  const setup = analysis.thermomech;
  if (setup?.thermal === undefined || setup.thermal.step.endTimeS === undefined || !isTransientCase(analysis)) return undefined;
  const last = results.steps.reduce((max, step) => Math.max(max, step.step), 0);
  const steps = results.steps.filter(
    (step) => step.step === last && step.fields['DISP'] !== undefined && step.fields['STRESS'] !== undefined,
  );
  if (steps.length === 0) return undefined;
  const offset = preheatPeriodS({ ...setup, thermal: setup.thermal });
  const coordinates = nodeCoordinates(mesh);
  const entities = nodeEntities(mesh);
  const at = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  const series: ThermomechTransientSummary['series'][number][] = [];
  let peakStress: { value: number; timeS: number; node: number } | null = null;
  let peakDisplacement: { value: number; timeS: number; node: number } | null = null;
  for (const step of steps) {
    const stress = extreme(step.fields['STRESS'], vonMises, 1);
    const displacement = extreme(step.fields['DISP'], magnitude, 1);
    const hot = extreme(step.fields['NDTEMP'], scalar, 1);
    const cold = extreme(step.fields['NDTEMP'], scalar, -1);
    if (stress === null || displacement === null || hot === null || cold === null) continue;
    const timeS = Number(significantNumber(step.time - offset, 12));
    series.push({
      timeS,
      maxVonMises: stress.value,
      maxDisplacement: displacement.value,
      maxTemperature: hot.value,
      minTemperature: cold.value,
    });
    if (peakStress === null || stress.value > peakStress.value) peakStress = { value: stress.value, timeS, node: stress.node };
    if (peakDisplacement === null || displacement.value > peakDisplacement.value)
      peakDisplacement = { value: displacement.value, timeS, node: displacement.node };
  }
  if (peakStress === null || peakDisplacement === null) return undefined;
  const summary: ThermomechTransientSummary = {
    temperatureScale: setup.temperatureScale,
    series,
    peakVonMises: {
      value: peakStress.value,
      timeS: peakStress.timeS,
      at: at(peakStress.node),
      entityId: entities.get(peakStress.node) ?? '',
    },
    peakDisplacement: { value: peakDisplacement.value, timeS: peakDisplacement.timeS, at: at(peakDisplacement.node) },
  };
  return {
    summary,
    loadCases: [
      {
        name: setup.loadCaseName,
        category: 'limit',
        maxVonMises: { value: peakStress.value, at: summary.peakVonMises.at, entityId: summary.peakVonMises.entityId },
        maxDisplacement: { value: peakDisplacement.value, at: summary.peakDisplacement.at },
      },
    ],
  };
}

/** `; transient: N increments to t=<end> s, peak von Mises <v> at t=<t> s, peak displacement <u>` for a transient summary, else ''. */
export function transientSummaryText(summary: ResultsSummary): string {
  const transient = summary.thermomechTransient;
  if (transient === undefined) return '';
  const end = transient.series.at(-1)?.timeS ?? 0;
  return `; transient: ${transient.series.length} increment(s) to t=${significantNumber(end, 6)} s, peak von Mises ${significantNumber(transient.peakVonMises.value, 6)} at t=${significantNumber(transient.peakVonMises.timeS, 6)} s, peak displacement ${significantNumber(transient.peakDisplacement.value, 6)} at t=${significantNumber(transient.peakDisplacement.timeS, 6)} s`;
}
