/** Temperature-field resolution (PHY-04 TR-TMC-10/12/14): the nodal temperatures of a thermo_static case, in the case temperature scale. */

import type {
  AnalysisCase,
  FeArtifactPort,
  FeMeshArtifact,
  FeResultsArtifact,
  TemperatureFieldSource,
  TemperatureScale,
  ThermoMechSetup,
} from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { evaluateExpression, expressionSyntaxError, extractReferences, isBuiltinConstant } from '@lib/expression';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '../hash/inputHash';
import { caseOf } from '../shared/access';
import { analysisLengthMetres } from '../shared/defaults';
import { affineBetween, metresPer, temperatureIn, type Affine } from './units';

/** Nodal temperatures aligned with `mesh.nodes` (same order), in the case temperature scale. */
export interface ResolvedField {
  readonly ok: true;
  readonly values: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

export interface FieldRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

const refusal = (code: string, message: string, ids: readonly string[]): FieldRefusal => ({ ok: false, code, message, ids });

function resolved(values: readonly number[], description: string): ResolvedField {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { ok: true, values, min, max, description };
}

/** Problem text when `expression` has a syntax error or reads anything but x, y, z (and the built-in constants), else null. */
export function expressionProblem(expression: string): string | null {
  const syntax = expressionSyntaxError(expression);
  if (syntax !== null) return syntax;
  const unknown = [...extractReferences(expression)].filter((name) => !['x', 'y', 'z'].includes(name) && !isBuiltinConstant(name));
  return unknown.length === 0 ? null : `unknown name(s) ${unknown.join(', ')}; only x, y, z (and pi, tau) are available`;
}

/** Table artifact a host stores under the CSV sha256: rows `[x, y, z, T]` in the declared units. */
interface TableArtifact {
  readonly kind: 'fe_table';
  readonly rows: readonly (readonly [number, number, number, number])[];
}

const isTableArtifact = (value: unknown): value is TableArtifact =>
  typeof value === 'object' &&
  value !== null &&
  (value as { kind?: unknown }).kind === 'fe_table' &&
  Array.isArray((value as TableArtifact).rows);

function uniformField(
  field: Extract<TemperatureFieldSource, { kind: 'uniform' }>,
  scale: TemperatureScale,
  nodes: number,
  id: string,
): ResolvedField | FieldRefusal {
  const value = temperatureIn(field.value, scale);
  if (value === null || !Number.isFinite(value))
    return refusal('THM_UNITS_MISMATCH', `uniform temperature '${field.value.value} ${field.value.unit}' is not a finite temperature`, [
      id,
    ]);
  return resolved(new Array<number>(nodes).fill(value), `uniform ${field.value.value} ${field.value.unit}`);
}

function expressionField(
  field: Extract<TemperatureFieldSource, { kind: 'expression' }>,
  mesh: FeMeshArtifact,
  scale: TemperatureScale,
  id: string,
): ResolvedField | FieldRefusal {
  const coordinateMetres = metresPer(field.coordinatesUnit);
  const temperature: Affine | null = affineBetween(field.temperatureUnit, scale);
  if (coordinateMetres === null || temperature === null)
    return refusal(
      'TMC_FIELD_SOURCE_INVALID',
      `coordinatesUnit '${field.coordinatesUnit}' or temperatureUnit '${field.temperatureUnit}' is invalid`,
      [id],
    );
  const factor = analysisLengthMetres(mesh.unitSystem) / coordinateMetres;
  const values: number[] = [];
  let bad = 0;
  let firstError = '';
  for (const [, x, y, z] of mesh.nodes) {
    const result = evaluateExpression(field.expression, { x: x * factor, y: y * factor, z: z * factor });
    if (result.ok) values.push(temperature.offset + temperature.scale * result.value);
    else {
      bad += 1;
      if (firstError === '') firstError = result.error;
      values.push(Number.NaN);
    }
  }
  if (bad > 0)
    return refusal(
      'TMC_FIELD_INVALID',
      `expression '${field.expression}' is not finite at ${bad} of ${mesh.nodes.length} node(s): ${firstError}`,
      [id],
    );
  return resolved(values, `expression ${field.expression} (x, y, z in ${field.coordinatesUnit}, T in ${field.temperatureUnit})`);
}

function modelSize(mesh: FeMeshArtifact): number {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const [, ...p] of mesh.nodes)
    p.forEach((c, k) => {
      low[k] = Math.min(low[k] ?? c, c);
      high[k] = Math.max(high[k] ?? c, c);
    });
  return Math.hypot(...low.map((l, k) => (high[k] ?? l) - l));
}

function tableField(
  field: Extract<TemperatureFieldSource, { kind: 'table' }>,
  mesh: FeMeshArtifact,
  scale: TemperatureScale,
  artifacts: FeArtifactPort | null,
  id: string,
): ResolvedField | FieldRefusal {
  const artifact: unknown = artifacts?.get(field.csvSha256) ?? null;
  if (!isTableArtifact(artifact))
    return refusal('TMC_FIELD_SOURCE_INVALID', `no table artifact ${field.csvSha256} in the artifact store (fea_import_field writes it)`, [
      id,
    ]);
  const coordinateMetres = metresPer(field.coordinatesUnit);
  const temperature = affineBetween(field.temperatureUnit, scale);
  if (coordinateMetres === null || temperature === null)
    return refusal('TMC_FIELD_SOURCE_INVALID', `table units '${field.coordinatesUnit}' / '${field.temperatureUnit}' are invalid`, [id]);
  if (artifact.rows.length !== field.rows)
    return refusal('TMC_FIELD_SOURCE_INVALID', `table artifact has ${artifact.rows.length} row(s), the field declares ${field.rows}`, [id]);
  const factor = coordinateMetres / analysisLengthMetres(mesh.unitSystem);
  const rows = artifact.rows.map(
    ([x, y, z, t]) => [x * factor, y * factor, z * factor, temperature.offset + temperature.scale * t] as const,
  );
  rows.sort((a, b) => a[0] - b[0]);
  const tolerance = 1e-6 * modelSize(mesh);
  const values: number[] = [];
  let unmatched = 0;
  for (const [, x, y, z] of mesh.nodes) {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rows[mid]?.[0] ?? 0) < x - tolerance) lo = mid + 1;
      else hi = mid;
    }
    let best = Number.POSITIVE_INFINITY;
    let value = Number.NaN;
    for (let i = lo; i < rows.length && (rows[i]?.[0] ?? 0) <= x + tolerance; i += 1) {
      const row = rows[i];
      if (row === undefined) break;
      const distance = Math.hypot(row[0] - x, row[1] - y, row[2] - z);
      if (distance < best) {
        best = distance;
        value = row[3];
      }
    }
    if (best <= tolerance) values.push(value);
    else {
      unmatched += 1;
      values.push(Number.NaN);
    }
  }
  if (unmatched > 0)
    return refusal(
      'TMC_FIELD_TABLE_UNMATCHED',
      `${unmatched} of ${mesh.nodes.length} mesh node(s) have no table row within ${tolerance} (1e-6 x model size)`,
      [id],
    );
  return resolved(values, `table ${field.csvSha256.slice(0, 12)} (${field.rows} rows)`);
}

function sourceStep(results: FeResultsArtifact, time: number | 'last'): FeResultsArtifact['steps'][number] | undefined {
  if (time === 'last') return results.steps[results.steps.length - 1];
  return results.steps.find((step) => Math.abs(step.time - time) <= 1e-9 * Math.max(1, Math.abs(time)));
}

/** Status of the thermal case a `thermal_result` field reads, without reading any artifact. */
export function thermalSourceProblem(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  field: Extract<TemperatureFieldSource, { kind: 'thermal_result' }>,
): FieldRefusal | null {
  const source = caseOf(doc, field.analysisId);
  const ids = [analysisCase.id, field.analysisId];
  if (source === undefined || (source.type !== 'heat_steady' && source.type !== 'heat_transient'))
    return refusal('TMC_FIELD_SOURCE_INVALID', `'${field.analysisId}' is not a heat_steady / heat_transient analysis`, ids);
  if (source.results === undefined) return refusal('FEA_RESULTS_MISSING', `thermal analysis '${source.id}' has no recorded results`, ids);
  if (source.results.inputHash !== analysisInputHash(doc, source.id, 'full'))
    return refusal(
      'TMC_THERMAL_RESULT_STALE',
      `the results of thermal analysis '${source.id}' are stale (its inputs changed since the solve)`,
      ids,
    );
  const hash = source.meshSummary?.meshHash;
  const own = analysisCase.meshSummary?.meshHash;
  if (hash !== undefined && own !== undefined && hash !== own)
    return refusal('TMC_MESH_MISMATCH', `thermal mesh ${hash} differs from this analysis' mesh ${own}`, ids);
  return null;
}

function thermalResultField(
  field: Extract<TemperatureFieldSource, { kind: 'thermal_result' }>,
  doc: CadDocument,
  analysisCase: AnalysisCase,
  mesh: FeMeshArtifact,
  scale: TemperatureScale,
  artifacts: FeArtifactPort | null,
): ResolvedField | FieldRefusal {
  const problem = thermalSourceProblem(doc, analysisCase, field);
  if (problem !== null) return problem;
  const source = caseOf(doc, field.analysisId);
  const resultsHash = source?.results?.resultsHash ?? '';
  const ids = [analysisCase.id, field.analysisId];
  const results: unknown = artifacts?.get(resultsHash) ?? null;
  if (typeof results !== 'object' || results === null || (results as { kind?: unknown }).kind !== 'fe_results')
    return refusal(
      'FEA_RESULTS_MISSING',
      `results artifact ${resultsHash} of thermal analysis '${field.analysisId}' is not in the artifact store`,
      ids,
    );
  const artifact = results as FeResultsArtifact;
  const meshHash = sha256Hex(canonicalJson(mesh));
  if (artifact.meshHash !== meshHash)
    return refusal(
      'TMC_MESH_MISMATCH',
      `thermal results were computed on mesh ${artifact.meshHash}, this analysis uses mesh ${meshHash}`,
      ids,
    );
  const step = sourceStep(artifact, field.time);
  if (step === undefined) return refusal('TMC_FIELD_SOURCE_INVALID', `thermal results have no output at time ${String(field.time)}`, ids);
  const nodal = step.fields['NDTEMP'];
  if (nodal === undefined) return refusal('TMC_FIELD_SOURCE_INVALID', `thermal results step ${step.step} has no NDTEMP field`, ids);
  const sourceScale = source?.thermal?.temperatureScale ?? 'degC';
  const affine = affineBetween(sourceScale, scale);
  if (affine === null) return refusal('TMC_FIELD_SOURCE_INVALID', `cannot convert ${sourceScale} to ${scale}`, ids);
  const values: number[] = [];
  let missing = 0;
  for (const [nodeId] of mesh.nodes) {
    const raw = nodal.values[String(nodeId)]?.[0];
    if (raw === undefined || !Number.isFinite(raw)) {
      missing += 1;
      values.push(Number.NaN);
    } else values.push(affine.offset + affine.scale * raw);
  }
  if (missing > 0)
    return refusal('TMC_FIELD_INVALID', `thermal results have no finite NDTEMP at ${missing} of ${mesh.nodes.length} node(s)`, ids);
  return resolved(values, `thermal_result ${field.analysisId} step ${step.step} t=${step.time} s (results ${resultsHash.slice(0, 12)})`);
}

/** The case's thermo-mechanical set-up when it is a thermo_static case. */
export const thermomechOf = (analysisCase: AnalysisCase | undefined): ThermoMechSetup | undefined =>
  analysisCase?.type === 'thermo_static' ? analysisCase.thermomech : undefined;

/**
 * Nodal temperatures of the case field on `mesh`, in the case temperature scale.
 * @failure not a thermo_static case -> THM_CASE_TYPE; no field -> TMC_FIELD_SOURCE_INVALID; expression non-finite / source without NDTEMP ->
 *   TMC_FIELD_INVALID; table without a match -> TMC_FIELD_TABLE_UNMATCHED; thermal source stale / on another mesh / unsolved ->
 *   TMC_THERMAL_RESULT_STALE / TMC_MESH_MISMATCH / FEA_RESULTS_MISSING
 */
export function resolveTemperatureField(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  artifacts: FeArtifactPort | null,
): ResolvedField | FieldRefusal {
  const analysisCase = caseOf(doc, analysisId);
  const setup = thermomechOf(analysisCase);
  if (analysisCase === undefined || setup === undefined)
    return refusal('THM_CASE_TYPE', `analysis '${analysisId}' is not a thermo_static analysis`, [analysisId]);
  const field = setup.field;
  const scale = setup.temperatureScale;
  if (field === undefined)
    return refusal('TMC_FIELD_SOURCE_INVALID', `analysis '${analysisId}' has no temperature field (set_temperature_field)`, [analysisId]);
  switch (field.kind) {
    case 'uniform':
      return uniformField(field, scale, mesh.nodes.length, analysisId);
    case 'expression':
      return expressionField(field, mesh, scale, analysisId);
    case 'table':
      return tableField(field, mesh, scale, artifacts, analysisId);
    case 'thermal_result':
      return thermalResultField(field, doc, analysisCase, mesh, scale, artifacts);
  }
}
