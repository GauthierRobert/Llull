// The Analysis set-up as drawable / clickable items: supports, loads, thermal BCs, probes and result extremes, each with the points where
// it sits on the model (document units), its colour (row swatch == glyph on the model) and its value text. Pure: the panel rows and the
// 3D overlay both read this, so the list and the picture never disagree.

import type {
  AnalysisCase,
  FeaConstraint,
  FeaLoad,
  FeaTarget,
  ResultsSummary,
  ThermalBc,
  ThermalResultsSummary,
  UnitSystem,
} from '@core/model/analysis';
import { boundsCenter, boundsExtent, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import { toMetres } from '@core/model/units';
import type { CadDocument, Vec3 } from '@core/model/types';
import { lengthUnitName, stressUnitName } from '@cae/decks/units';
import { formatQuantities, formatSignificant } from './quantityFormat';

type ItemGroup = 'part' | 'constraint' | 'load' | 'thermal' | 'probe' | 'result';
type GlyphKind =
  | 'fixed'
  | 'pinned'
  | 'symmetry'
  | 'displacement'
  | 'force'
  | 'moment'
  | 'gravity'
  | 'pressure'
  | 'thermal'
  | 'probe'
  | 'peak-high'
  | 'peak-low';

export const COLORS = {
  part: '#94a3b8',
  constraint: '#22d3ee',
  load: '#e879f9',
  temperature: '#ef4444',
  flux: '#f97316',
  film: '#14b8a6',
  radiation: '#eab308',
  generation: '#a855f7',
  probe: '#e2e8f0',
  high: '#ef4444',
  low: '#3b82f6',
  error: '#ef4444',
  warning: '#f59e0b',
} as const;

export interface SetupItem {
  /** Id of the set-up record (constraint / load / BC / probe / part id) or of the result pin. */
  readonly id: string;
  /** Focus key: `analysis:<group>:<id>`. */
  readonly key: string;
  readonly group: ItemGroup;
  readonly name: string;
  readonly color: string;
  readonly glyph: GlyphKind;
  /** Where it sits on the model (document units). */
  readonly points: readonly Vec3[];
  /** Unit direction of an arrow / ring axis, null for markers. */
  readonly direction: Vec3 | null;
  /** Value text drawn on the model ("500 N", "T = 120 °C"). */
  readonly label: string;
  readonly entityIds: readonly string[];
}

export interface SetupItems {
  readonly parts: readonly SetupItem[];
  readonly constraints: readonly SetupItem[];
  readonly loads: readonly SetupItem[];
  readonly thermal: readonly SetupItem[];
  readonly probes: readonly SetupItem[];
  /** Max / min pins of the solved results. */
  readonly extremes: readonly SetupItem[];
  /** Extent of the analysed parts (document units): glyphs are sized from it. */
  readonly size: number;
  readonly center: Vec3;
}

const MAX_POINTS = 6;
const METRES_PER_ANALYSIS_LENGTH: Readonly<Record<string, number>> = { mm: 0.001, m: 1, in: 0.0254 };

const unitText = (unit: string): string => (unit === 'degC' ? '°C' : unit === 'degF' ? '°F' : unit);
const quantityText = (q: { readonly value: number; readonly unit: string }): string => `${formatSignificant(q.value)} ${unitText(q.unit)}`;
const norm = (v: readonly number[]): number => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
const unit3 = (v: readonly number[]): Vec3 | null => {
  const length = norm(v);
  return length > 0 ? [(v[0] ?? 0) / length, (v[1] ?? 0) / length, (v[2] ?? 0) / length] : null;
};

const forceUnitName = (unitSystem: UnitSystem): string => (unitSystem === 'lbf-in-slinch-s' ? 'lbf' : 'N');

function partBounds(doc: CadDocument, entityIds: readonly string[]): Bounds | null {
  let merged: Bounds | null = null;
  for (const id of entityIds) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    const next = entityBoundsInDoc(doc, entity);
    merged = merged === null ? next : mergeBounds(merged, next);
  }
  return merged;
}

/** The points of a target in document units; the part's centre when it names no point. */
function targetPoints(doc: CadDocument, target: FeaTarget | undefined, fallback: Vec3): Vec3[] {
  if (target === undefined) return [fallback];
  const listed = [...(target.facesNear ?? []), ...(target.edgesNear ?? []), ...(target.pointsNear ?? [])].slice(0, MAX_POINTS);
  if (listed.length > 0) return listed.map((p): Vec3 => [p[0], p[1], p[2]]);
  const bounds = partBounds(doc, [target.entityId]);
  return [bounds === null ? fallback : boundsCenter(bounds)];
}

const targetEntities = (target: FeaTarget | undefined): string[] => (target === undefined ? [] : [target.entityId]);

function constraintItem(doc: CadDocument, c: FeaConstraint, fallback: Vec3): SetupItem {
  const kindText = { fixed: 'Fixed', pinned: 'Pinned', symmetry: 'Symmetry', displacement: 'Imposed displacement' }[c.kind];
  return {
    id: c.id,
    key: `analysis:constraint:${c.id}`,
    group: 'constraint',
    name: c.name,
    color: COLORS.constraint,
    glyph: c.kind,
    points: targetPoints(doc, c.target, fallback),
    direction: null,
    label: `${c.name}: ${kindText}`,
    entityIds: targetEntities(c.target),
  };
}

/** Value + unit of a load in the case unit system. */
export function loadValueText(load: FeaLoad, unitSystem: UnitSystem): string {
  const magnitude = load.magnitude ?? (load.vector === undefined ? undefined : norm(load.vector));
  if (magnitude === undefined) return '';
  const length = lengthUnitName(unitSystem);
  switch (load.kind) {
    case 'force':
      return `${formatSignificant(magnitude)} ${forceUnitName(unitSystem)}`;
    case 'moment':
      return `${formatSignificant(magnitude)} ${forceUnitName(unitSystem)}·${length}`;
    case 'pressure':
      return `${formatSignificant(magnitude)} ${stressUnitName(unitSystem)}`;
    case 'gravity':
      return unitSystem === 'N-mm-t-s' ? `${formatSignificant(magnitude / 1000)} m/s²` : `${formatSignificant(magnitude)} ${length}/s²`;
  }
}

function loadItem(doc: CadDocument, load: FeaLoad, unitSystem: UnitSystem, fallback: Vec3): SetupItem {
  const value = loadValueText(load, unitSystem);
  return {
    id: load.id,
    key: `analysis:load:${load.id}`,
    group: 'load',
    name: load.name,
    color: COLORS.load,
    glyph: load.kind,
    points: targetPoints(doc, load.target, fallback),
    direction: load.vector === undefined ? (load.kind === 'gravity' ? [0, 0, -1] : null) : unit3(load.vector),
    label: value === '' ? load.name : value,
    entityIds: targetEntities(load.target),
  };
}

function thermalStyle(bc: ThermalBc): { color: string; label: string } {
  switch (bc.kind) {
    case 'temperature':
      return { color: COLORS.temperature, label: `T = ${quantityText(bc.value)}` };
    case 'surface_flux':
      return { color: COLORS.flux, label: `q = ${quantityText(bc.value)}` };
    case 'concentrated_flux':
      return { color: COLORS.flux, label: `P = ${quantityText(bc.value)}` };
    case 'heat_generation':
      return { color: COLORS.generation, label: `Q = ${quantityText(bc.value)}` };
    case 'film':
      return {
        color: COLORS.film,
        label: `h = ${'table' in bc.filmCoefficient ? 'h(T)' : quantityText(bc.filmCoefficient)}, T∞ = ${quantityText(bc.sinkTemperature)}`,
      };
    case 'radiation':
      return {
        color: COLORS.radiation,
        label: `ε = ${typeof bc.emissivity === 'number' ? formatSignificant(bc.emissivity) : 'material'}, T∞ = ${quantityText(bc.sinkTemperature)}`,
      };
  }
}

/** Thermal result temperatures use the case scale. */
const scaleText = (scale: string): string => (scale === 'K' ? 'K' : '°C');

/** Result summaries come from the host as JSON: tolerate a partial one instead of failing the whole panel. */
const loadCasesOf = (results: ResultsSummary): ResultsSummary['loadCases'] => (Array.isArray(results.loadCases) ? results.loadCases : []);
export const completeThermal = (thermal: ThermalResultsSummary | undefined): ThermalResultsSummary | undefined =>
  thermal !== undefined && 'maxT' in thermal && 'minT' in thermal && 'heatBalance' in thermal ? thermal : undefined;

function resultItems(analysisCase: AnalysisCase, toDocument: number): SetupItem[] {
  const { results } = analysisCase;
  if (results === undefined) return [];
  const at = (p: readonly number[]): Vec3 => [(p[0] ?? 0) * toDocument, (p[1] ?? 0) * toDocument, (p[2] ?? 0) * toDocument];
  const items: SetupItem[] = [];
  const stress = stressUnitName(analysisCase.unitSystem);
  const length = lengthUnitName(analysisCase.unitSystem);
  for (const lc of loadCasesOf(results)) {
    const text = formatQuantities([lc.maxVonMises.value], stress);
    items.push({
      id: `vm:${lc.name}`,
      key: `analysis:result:vm:${lc.name}`,
      group: 'result',
      name: `Max von Mises (${lc.name})`,
      color: COLORS.high,
      glyph: 'peak-high',
      points: [at(lc.maxVonMises.at)],
      direction: null,
      label: `σ max ${text.texts[0]} ${text.unit}`,
      entityIds: lc.maxVonMises.entityId === '' ? [] : [lc.maxVonMises.entityId],
    });
    items.push({
      id: `u:${lc.name}`,
      key: `analysis:result:u:${lc.name}`,
      group: 'result',
      name: `Max displacement (${lc.name})`,
      color: COLORS.low,
      glyph: 'peak-low',
      points: [at(lc.maxDisplacement.at)],
      direction: null,
      label: `u max ${formatSignificant(lc.maxDisplacement.value)} ${length}`,
      entityIds: [],
    });
  }
  const thermal = completeThermal(results.thermal);
  if (thermal !== undefined) {
    const unit = scaleText(thermal.temperatureScale);
    items.push(
      {
        id: 'tmax',
        key: 'analysis:result:tmax',
        group: 'result',
        name: 'Hottest point',
        color: COLORS.high,
        glyph: 'peak-high',
        points: [at(thermal.maxT.at)],
        direction: null,
        label: `T max ${formatSignificant(thermal.maxT.value)} ${unit}`,
        entityIds: [thermal.maxT.entityId],
      },
      {
        id: 'tmin',
        key: 'analysis:result:tmin',
        group: 'result',
        name: 'Coldest point',
        color: COLORS.low,
        glyph: 'peak-low',
        points: [at(thermal.minT.at)],
        direction: null,
        label: `T min ${formatSignificant(thermal.minT.value)} ${unit}`,
        entityIds: [thermal.minT.entityId],
      },
    );
  }
  return items;
}

function probeItems(analysisCase: AnalysisCase): SetupItem[] {
  const series = new Map(
    (Array.isArray(analysisCase.results?.thermal?.probes) ? analysisCase.results.thermal.probes : []).map((probe) => [
      probe.probeId,
      probe.series,
    ]),
  );
  const unit = scaleText(analysisCase.results?.thermal?.temperatureScale ?? 'degC');
  return Object.entries(analysisCase.probes).map(([id, probe]) => {
    const last = series.get(id)?.at(-1);
    const value = last === undefined ? '' : ` ${formatSignificant(last[1])} ${unit}`;
    return {
      id,
      key: `analysis:probe:${id}`,
      group: 'probe',
      name: probe.name,
      color: COLORS.probe,
      glyph: 'probe',
      points: [[probe.point[0], probe.point[1], probe.point[2]]],
      direction: null,
      label: `${probe.name}${value}`,
      entityIds: [],
    };
  });
}

/** Metres of one analysis-length unit per document unit (mesh coordinates -> document coordinates). */
export function analysisToDocument(doc: CadDocument, unitSystem: UnitSystem): number {
  return (METRES_PER_ANALYSIS_LENGTH[lengthUnitName(unitSystem)] ?? 0.001) / toMetres(doc, 1);
}

export function buildSetupItems(doc: CadDocument, analysisCase: AnalysisCase): SetupItems {
  const partIds = Object.keys(analysisCase.parts);
  const bounds = partBounds(doc, partIds);
  const center: Vec3 = bounds === null ? [0, 0, 0] : boundsCenter(bounds);
  const extent = bounds === null ? 0 : boundsExtent(bounds);
  const unitSystem = analysisCase.unitSystem;
  const parts = partIds.map(
    (id): SetupItem => ({
      id,
      key: `analysis:part:${id}`,
      group: 'part',
      name: doc.entities[id]?.name ?? id,
      color: COLORS.part,
      glyph: 'probe',
      points: [],
      direction: null,
      label: doc.entities[id]?.name ?? id,
      entityIds: [id],
    }),
  );
  const thermal = (analysisCase.thermal?.bcOrder ?? []).flatMap((id): SetupItem[] => {
    const record = analysisCase.thermal?.bcs[id];
    if (record === undefined) return [];
    const style = thermalStyle(record.bc);
    const target = record.bc.kind === 'heat_generation' ? { entityId: record.bc.entityId } : record.bc.target;
    return [
      {
        id: record.id,
        key: `analysis:thermal:${record.id}`,
        group: 'thermal',
        name: record.name,
        color: style.color,
        glyph: 'thermal',
        points: targetPoints(doc, target, center),
        direction: null,
        label: style.label,
        entityIds: [target.entityId],
      },
    ];
  });
  return {
    parts,
    constraints: analysisCase.constraintOrder.flatMap((id) => {
      const c = analysisCase.constraints[id];
      return c === undefined ? [] : [constraintItem(doc, c, center)];
    }),
    loads: analysisCase.loadOrder.flatMap((id) => {
      const l = analysisCase.loads[id];
      return l === undefined ? [] : [loadItem(doc, l, unitSystem, center)];
    }),
    thermal,
    probes: probeItems(analysisCase),
    extremes: resultItems(analysisCase, analysisToDocument(doc, unitSystem)),
    size: extent > 0 ? extent : 1,
    center,
  };
}
