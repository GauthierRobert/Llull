/** Temperature at which compute_margins reads the allowables of a thermo_static case: the solved nodal temperature field. */

import type { AnalysisCase, FeArtifactPort, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { resolveTemperatureField, thermomechOf } from '../thermomech/field';
import { kelvinOf } from '../thermomech/units';

export interface NodeTemperatures {
  /** [coldest, hottest] temperature in K over `nodes` that have a value, or null when none has. */
  readonly rangeOf: (nodes: readonly number[]) => [number, number] | null;
  readonly description: string;
  /** Why no field could be read (set only when `rangeOf` always gives null). */
  readonly unavailable?: string;
}

/**
 * Nodal temperatures (K) of the case field on its mesh, or an empty provider saying why there are none.
 * @failure no field / unresolvable source -> a provider whose `unavailable` carries the field code and message (the reference temperature is used)
 */
export function solvedNodeTemperatures(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact | null,
  artifacts: FeArtifactPort | null,
): NodeTemperatures {
  const none = (unavailable: string): NodeTemperatures => ({ rangeOf: () => null, description: '', unavailable });
  const setup = thermomechOf(analysis);
  if (mesh === null || setup === undefined) return none('no mesh or thermo_static set-up');
  const field = resolveTemperatureField(doc, analysis.id, mesh, artifacts);
  if (!field.ok) return none(`${field.code}: ${field.message}`);
  const byNode = new Map<number, number>();
  mesh.nodes.forEach(([id], index) => {
    const value = field.values[index];
    if (value !== undefined && Number.isFinite(value)) byNode.set(id, kelvinOf(value, setup.temperatureScale));
  });
  return {
    description: field.description,
    rangeOf: (nodes) => {
      let cold = Number.POSITIVE_INFINITY;
      let hot = Number.NEGATIVE_INFINITY;
      for (const node of nodes) {
        const value = byNode.get(node);
        if (value === undefined) continue;
        if (value < cold) cold = value;
        if (value > hot) hot = value;
      }
      return hot < cold ? null : [cold, hot];
    },
  };
}

interface TemperatureRow {
  readonly [key: string]: unknown;
}

/**
 * Warnings about the temperature of the allowables of a thermo_static result.
 * @invariant FEA_ALLOWABLE_TEMPERATURE_UNKNOWN when rows were read at the reference temperature because no solved field was available;
 *   FEA_ALLOWABLE_NOT_TEMPERATURE_DEPENDENT when a used allowable does not vary with temperature (constant model / explicit value)
 */
export function temperatureWarnings(temperatures: NodeTemperatures | null, referenceK: number, rows: readonly TemperatureRow[]): string[] {
  const warnings: string[] = [];
  const atReference = rows.filter((row) => row['allowableTemperatureRangeK'] === undefined);
  if (atReference.length > 0)
    warnings.push(
      `FEA_ALLOWABLE_TEMPERATURE_UNKNOWN: ${atReference.length} row(s) read the allowable at the reference temperature ${referenceK} K because no solved temperature was available (${temperatures?.unavailable ?? 'no value on the nodes of the region'}); if the part is hotter the allowable may be non-conservative`,
    );
  const constant = rows.filter((row) => row['temperatureDependent'] === false);
  if (constant.length > 0) {
    const kelvin = [
      ...new Set(constant.map((row) => row['allowableTemperatureK']).filter((value): value is number => typeof value === 'number')),
    ];
    warnings.push(
      `FEA_ALLOWABLE_NOT_TEMPERATURE_DEPENDENT: ${constant.length} row(s) use allowables that do not vary with temperature (constant model or explicit value), i.e. room-temperature values applied at T = ${kelvin.map((value) => `${Number(value.toFixed(2))} K`).join(', ')}; define Ftu / Fty as temperature-dependent property models for the hot case`,
    );
  }
  return warnings;
}
