/** Thermal material properties (k, cp, density) read from PHY-01 property models and tabulated for CalculiX (PHY-03 TR-THM-03, §3.3). */

import type { AnalysisCase, TemperatureScale, ThermalSetup, UnitSystem } from '@core/model/analysis';
import type { CadDocument, Material } from '@core/model/types';
import type { PropertyDirection } from '@core/model/propertyModel';
import { baseEvaluatorOf, evaluatePropertyModel, resolvePropertyModel, type PropertyRecord } from '@core/model/propertyModelEval';
import { curveOf, SOLVER_TABLE_REL_TOL, tabulateModel } from '@core/model/propertyTabulate';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { siToSystem, siUnitOf, type ThermalKind } from '@lib/thermalUnits';
import { problem, type Problem, type ThermalCase } from './access';
import { amplitudeRange } from './amplitudeRange';
import { inScale } from './quantities';

export type ThermalProperty = 'k' | 'cp' | 'density';
const KIND: Readonly<Record<ThermalProperty, ThermalKind>> = { k: 'conductivity', cp: 'specificHeat', density: 'density' };
const MISSING: Readonly<Record<ThermalProperty, string>> = {
  k: 'THM_MATERIAL_NO_K',
  cp: 'THM_MATERIAL_NO_CP',
  density: 'THM_MATERIAL_NO_CP',
};

/** Named deck rule: the table spans the temperatures of the case +- this margin (K), clamped to the model equation range. */
const TABLE_MARGIN_K = 50;

/** One property as the solver reads it: a constant or a (temperature on the case scale, value) table, in the unit system. */
export interface PropertyTable {
  readonly property: ThermalProperty;
  readonly origin: string;
  readonly modelId: string | null;
  readonly coefficientsSha256: string | null;
  readonly maxRelError: number;
  readonly constant: number | null;
  readonly points: readonly (readonly [temperature: number, value: number])[];
  /** Tabulated temperature range (case scale); null for a constant. */
  readonly range: readonly [number, number] | null;
  readonly unverifiedReasons: readonly string[];
  /**
   * Orthotropic conductivity only (`property` 'k' with models of direction 1 / 2 / 3): the three directional tables, in order; the fields above
   * then summarise them (`constant` null, no `points`, `range` the span common to all three, `maxRelError` the largest).
   */
  readonly orthotropic?: readonly [PropertyTable, PropertyTable, PropertyTable];
}

/** Material directions of an orthotropic conductivity: the document X, Y, Z axes (no `*ORIENTATION` is written). */
const ORTHO_DIRECTIONS = ['1', '2', '3'] as const satisfies readonly PropertyDirection[];

const withSi = (kind: ThermalKind, value: number, unit: string): number => {
  const converted = convertValue(value, unit, siUnitOf(kind));
  return isUnitFailure(converted) ? Number.NaN : converted.value;
};

/**
 * Temperature span (case scale) the solved field can take from the set-up: initial temperature, prescribed temperatures and film sinks
 * (scaled by their amplitude extremes). Radiation sinks and cavity environments are NOT included: a part radiating to deep space stays far
 * above the sink, and a field that does leave the tables is reported afterwards (THM_PROPERTY_OUT_OF_RANGE). Null when the set-up names none.
 */
export function caseTemperatureRange(thermal: ThermalSetup): readonly [number, number] | null {
  const scale = thermal.temperatureScale;
  const values: number[] = [];
  if (thermal.initialTemperature !== undefined) values.push(inScale(thermal.initialTemperature, scale));
  for (const id of thermal.bcOrder) {
    const record = thermal.bcs[id];
    if (record === undefined) continue;
    const bc = record.bc;
    const amplitude =
      record.amplitude !== undefined && Object.hasOwn(thermal.amplitudes, record.amplitude)
        ? thermal.amplitudes[record.amplitude]
        : undefined;
    const [fLow, fHigh] = amplitude === undefined ? [1, 1] : amplitudeRange(amplitude.points);
    const scaled = (q: { readonly value: number; readonly unit: string }): number[] => {
      const t = inScale(q, scale);
      return [t * fLow, t * fHigh];
    };
    if (bc.kind === 'temperature') values.push(...scaled(bc.value));
    if (bc.kind === 'film') values.push(...scaled(bc.sinkTemperature));
  }
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? null : [Math.min(...finite), Math.max(...finite)];
}

export interface PropertyRequest {
  readonly materialName: string;
  readonly material: Material;
  readonly documentUnit: CadDocument['units'];
  readonly property: ThermalProperty;
  readonly scale: TemperatureScale;
  readonly unitSystem: UnitSystem;
  /** Temperatures the case reaches (case scale), or null when unknown. */
  readonly required: readonly [number, number] | null;
  /** Material direction of a conductivity model ('1' | '2' | '3'); set by the orthotropic path only. */
  readonly direction?: PropertyDirection;
}

/** True when some k model of the material names a material direction 1 / 2 / 3 (the material is orthotropic). */
export const isOrthotropic = (material: Material): boolean =>
  (material.propertyModels ?? []).some(
    (model) => model.property === 'k' && model.direction !== undefined && (ORTHO_DIRECTIONS as readonly string[]).includes(model.direction),
  );

/** Problem text when an orthotropic material sits on a rotated part (its directions are the document axes), else null. */
export const orthotropicRotationProblem = (entityId: string, rotation: readonly number[]): string | null =>
  rotation.some((angle) => angle !== 0)
    ? `part '${entityId}' is rotated but its material k is orthotropic: the directions 1 / 2 / 3 are the document X / Y / Z axes`
    : null;

/** Value of a piecewise-linear table at `temperature` (end values held, as the solver does); a constant table ignores it. */
const valueAt = (table: PropertyTable, temperature: number): number => {
  if (table.constant !== null) return table.constant;
  const points = table.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return Number.NaN;
  if (temperature <= first[0]) return first[1];
  if (temperature >= last[0]) return last[1];
  const upper = points.findIndex((point) => point[0] >= temperature);
  const [t1, v1] = points[upper - 1] ?? first;
  const [t2, v2] = points[upper] ?? last;
  return v1 + ((v2 - v1) * (temperature - t1)) / (t2 - t1);
};

/** Rows `[k1, k2, k3, T]` (T last, absent for constants) of an orthotropic table, on the union of the directional temperature grids. */
export function orthotropicRows(table: PropertyTable): readonly (readonly number[])[] {
  const [a, b, c] = table.orthotropic ?? [];
  if (a === undefined || b === undefined || c === undefined) return [];
  const grid = [...new Set([a, b, c].flatMap((entry) => entry.points.map(([temperature]) => temperature)))].sort((x, y) => x - y);
  if (grid.length === 0) return [[a.constant ?? Number.NaN, b.constant ?? Number.NaN, c.constant ?? Number.NaN]];
  return grid.map((temperature) => [valueAt(a, temperature), valueAt(b, temperature), valueAt(c, temperature), temperature]);
}

/**
 * Orthotropic k: the three directional tables of `request` (direction 1 / 2 / 3) combined.
 * @failure a direction missing -> THM_MATERIAL_K_ORTHO; the refusals of the directional tables pass through
 */
function orthotropicTable(request: PropertyRequest): PropertyTable | Problem {
  const have = new Set((request.material.propertyModels ?? []).filter((model) => model.property === 'k').map((model) => model.direction));
  const missing = ORTHO_DIRECTIONS.filter((direction) => !have.has(direction));
  if (missing.length > 0)
    return problem(
      'THM_MATERIAL_K_ORTHO',
      `material '${request.materialName}' has k models for some of the directions 1 / 2 / 3 but not for ${missing.join(', ')}`,
      [request.materialName],
    );
  const tables: PropertyTable[] = [];
  for (const direction of ORTHO_DIRECTIONS) {
    const table = propertyTable({ ...request, direction });
    if ('code' in table) return table;
    tables.push(table);
  }
  const [a, b, c] = tables;
  if (a === undefined || b === undefined || c === undefined) return problem('THM_MATERIAL_K_ORTHO', 'orthotropic k needs three tables');
  const ranges = tables.flatMap((table) => (table.range === null ? [] : [table.range]));
  return {
    property: 'k',
    origin: tables.map((table, i) => `direction ${ORTHO_DIRECTIONS[i] ?? ''}: ${table.origin}`).join('; '),
    modelId: tables.map((table) => table.modelId ?? '').join(','),
    coefficientsSha256: tables.map((table) => table.coefficientsSha256 ?? '').join(','),
    maxRelError: Math.max(...tables.map((table) => table.maxRelError)),
    constant: null,
    points: [],
    range: ranges.length === 0 ? null : [Math.max(...ranges.map((r) => r[0])), Math.min(...ranges.map((r) => r[1]))],
    unverifiedReasons: [...new Set(tables.flatMap((table) => table.unverifiedReasons))],
    orthotropic: [a, b, c],
  };
}

function constantTable(request: PropertyRequest, siValue: number, origin: string, extra: Partial<PropertyTable> = {}): PropertyTable {
  return {
    property: request.property,
    origin,
    modelId: null,
    coefficientsSha256: null,
    maxRelError: 0,
    constant: siToSystem(KIND[request.property], siValue, request.unitSystem),
    points: [],
    range: null,
    unverifiedReasons: [],
    ...extra,
  };
}

/**
 * k / cp / density of a material for a case: a PHY-01 model (constant, or tabulated with `tabulateModel` to the named relative
 * tolerance over the case temperature range), else `Material.density` for density.
 * @failure no model (and no document density) -> THM_MATERIAL_NO_K / THM_MATERIAL_NO_CP; range outside the model equation range -> PROP_OUT_OF_RANGE
 *   (passed through); several unranked models -> PROP_NO_MODEL_FOR_PROPERTY; a model with variables other than T -> PROP_VARIABLE_MISSING;
 *   more than 500 table points -> THM_TABLE_POINTS; k models for only some of the directions 1 / 2 / 3 -> THM_MATERIAL_K_ORTHO
 * @note k models with direction 1 / 2 / 3 make the material orthotropic: `orthotropic` holds the three directional tables
 */
export function propertyTable(request: PropertyRequest): PropertyTable | Problem {
  const { property, material, scale } = request;
  if (property === 'k' && request.direction === undefined && isOrthotropic(material)) return orthotropicTable(request);
  const kind = KIND[property];
  const record: PropertyRecord = {
    name: request.materialName,
    ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}),
  };
  const declared = (material.propertyModels ?? []).some((model) => model.property === property);
  const resolved = resolvePropertyModel(
    record,
    request.direction === undefined ? { property } : { property, direction: request.direction },
  );
  if ('available' in resolved) {
    if (!declared && property === 'density' && material.density > 0) {
      const kgPerM3 = convertValue(material.density, `g/${request.documentUnit}^3`, 'kg/m^3');
      if (!isUnitFailure(kgPerM3)) return constantTable(request, kgPerM3.value, 'Material.density of the document material');
    }
    if (!declared)
      return problem(
        MISSING[property],
        `material '${request.materialName}' has no ${property}${property === 'density' ? ' (model or density)' : ''}`,
        [request.materialName],
      );
    return problem(resolved.code, resolved.reason, [request.materialName]);
  }
  const model = resolved;
  const origin = `model ${model.id} (${model.provenance.citation ?? model.provenance.sourceId ?? 'no citation'})`;
  const modelInfo = { modelId: model.id, coefficientsSha256: model.coefficientsSha256 };
  if (model.variables.some((spec) => spec.variable !== 'T'))
    return problem(
      'PROP_VARIABLE_MISSING',
      `model '${model.id}' depends on variables other than T; only T-dependent properties are tabulated`,
      [model.id],
    );
  const spec = model.variables.find((entry) => entry.variable === 'T');
  const evaluateAt = (temperature?: number): ReturnType<typeof evaluatePropertyModel> =>
    evaluatePropertyModel(record, model, temperature === undefined ? {} : { T: { value: temperature, unit: scale } }, {
      outputUnit: siUnitOf(kind),
    });
  if (spec === undefined) {
    const value = evaluateAt();
    if (!value.available) return problem(value.code, value.reason, [model.id]);
    return constantTable(request, value.value, origin, { ...modelInfo, unverifiedReasons: value.unverifiedReasons });
  }
  const range = model.validity.find((entry) => entry.variable === 'T');
  const toScale = (x: number): number => {
    const converted = convertValue(x, range?.unit ?? spec.unit, scale);
    return isUnitFailure(converted) ? Number.NaN : converted.value;
  };
  const dataLimits = range === undefined ? null : ([toScale(range.data[0]), toScale(range.data[1])] as const);
  const equation =
    range === undefined ? null : ([toScale((range.equation ?? range.data)[0]), toScale((range.equation ?? range.data)[1])] as const);
  const [lo, hi] = request.required ?? dataLimits ?? [Number.NaN, Number.NaN];
  const reasons = new Set<string>();
  for (const end of [lo, hi]) {
    const value = evaluateAt(end);
    if (!value.available) return problem(value.code, value.reason, [model.id]);
    value.unverifiedReasons.forEach((reason) => reasons.add(reason));
  }
  const from = Math.max(request.required === null ? lo : lo - TABLE_MARGIN_K, equation?.[0] ?? lo);
  const to = Math.min(request.required === null ? hi : hi + TABLE_MARGIN_K, equation?.[1] ?? hi);
  if (!(to - from > 1e-9)) {
    const value = evaluateAt(from);
    return value.available
      ? constantTable(request, value.value, origin, { ...modelInfo, unverifiedReasons: [...reasons] })
      : problem(value.code, value.reason, [model.id]);
  }
  const inModelUnit = (x: number): number => {
    const converted = convertValue(x, scale, spec.unit);
    return isUnitFailure(converted) ? Number.NaN : converted.value;
  };
  const table = tabulateModel(
    model,
    'T',
    inModelUnit(from),
    inModelUnit(to),
    SOLVER_TABLE_REL_TOL,
    curveOf(model, 'T', {}, baseEvaluatorOf(record)),
  );
  if (table === null)
    return problem('THM_TABLE_POINTS', `model '${model.id}' needs more than 500 table points over ${from}..${to} ${scale}`, [model.id]);
  const points = table.points.map(([x, y]) => {
    const t = convertValue(x, spec.unit, scale);
    return [isUnitFailure(t) ? Number.NaN : t.value, siToSystem(kind, withSi(kind, y, model.unit), request.unitSystem)] as const;
  });
  return {
    property,
    origin,
    ...modelInfo,
    maxRelError: table.maxRelError,
    constant: null,
    points,
    range: [from, to],
    unverifiedReasons: [...reasons],
  };
}

export interface PartMaterial {
  readonly entityId: string;
  readonly materialId: string;
  readonly material: Material | null;
}

/** Parts of the case with their document materials, in part-id order. */
export function partMaterials(doc: CadDocument, analysisCase: AnalysisCase): PartMaterial[] {
  return Object.keys(analysisCase.parts)
    .sort()
    .map((entityId) => {
      const materialId = Object.hasOwn(doc.entities, entityId) ? (doc.entities[entityId]?.materialId ?? '') : '';
      const material = materialId !== '' && Object.hasOwn(doc.materials, materialId) ? (doc.materials[materialId] ?? null) : null;
      return { entityId, materialId, material };
    });
}

/** Properties a case needs: k always; cp and density for a transient. */
export const propertiesNeeded = (analysisCase: AnalysisCase): readonly ThermalProperty[] =>
  analysisCase.type === 'heat_transient' ? ['k', 'cp', 'density'] : ['k'];

/** Table of `material` (id `materialId`) for `property` over the temperatures the case `found` reaches. */
export function casePropertyTable(
  doc: CadDocument,
  found: ThermalCase,
  materialId: string,
  material: Material,
  property: ThermalProperty,
): PropertyTable | Problem {
  const { analysisCase, thermal } = found;
  return propertyTable({
    materialName: materialId,
    material,
    documentUnit: doc.units,
    property,
    scale: thermal.temperatureScale,
    unitSystem: analysisCase.unitSystem,
    required: caseTemperatureRange(thermal),
  });
}

/** Each distinct material × property table the case reads, in part order; parts without a material are skipped. */
export function caseTables(
  doc: CadDocument,
  found: ThermalCase,
): { readonly materialId: string; readonly property: ThermalProperty; readonly table: PropertyTable | Problem }[] {
  const tables: { materialId: string; property: ThermalProperty; table: PropertyTable | Problem }[] = [];
  const seen = new Set<string>();
  for (const { materialId, material } of partMaterials(doc, found.analysisCase)) {
    if (material === null) continue;
    for (const property of propertiesNeeded(found.analysisCase)) {
      const key = `${materialId}/${property}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tables.push({ materialId, property, table: casePropertyTable(doc, found, materialId, material, property) });
    }
  }
  return tables;
}
