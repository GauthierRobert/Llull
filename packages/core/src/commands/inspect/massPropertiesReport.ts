/** The reporting half of mass_properties: the resolved mass properties with their review flags, then the volume-only or the weighted result. */

import type { CadDocument, Entity } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import {
  densityPlausibilityWarning,
  describeDensity,
  kgPerM3FromDocDensity,
  resolveDensity,
  type DensityFallback,
} from '../../geometry/resolveDensity';
import { resolveMassProperties, type ResolvedMass } from '../../geometry/resolveMassProperties';
import { formatLength } from '../../model/units';
import { report } from '../noop';
import { currentContext } from '../context';
import { type MassTotal, type MassUnit, union } from './massMeasure';
import {
  NOT_APPROVED,
  massDetail,
  importedBodyStatus,
  massProvenance,
  methodReasons,
  precisionWarnings,
  reviewRequired,
  type MassDetail,
  type MassProvenance,
  type MassWarning,
  type ReviewRequired,
} from './massReport';

const GRAMS_PER_POUND = 453.59237;

interface MassPropertiesData extends Partial<MassDetail> {
  volume: number;
  volumeUnit: string;
  method?: ResolvedMass['method'];
  /** Subdivision solids: the surface the volume measures (04 DIR §5.8). */
  surfaceModel?: 'level_mesh' | 'limit_patches';
  frame?: 'document' | 'entity';
  provenance?: MassProvenance;
  reviewRequired?: ReviewRequired;
  /** The body came from an imported file whose validation properties disagreed or could not be checked (aerospace 04 TR-XCH-24); its reasons are also in reviewRequired. */
  importUnverified?: { readonly value: boolean; readonly reasons: readonly string[] };
  warnings?: MassWarning[];
  /** Implausible-density warning (probably a wrong density unit); absent when the density is plausible. */
  densityWarnings?: string[];
  /** g/(document unit)³ (the legacy `Material.density` unit); the mean over the parts of an instance. */
  density?: number;
  densityUnit?: string;
  densityKgPerM3?: number;
  /** In `massUnit`. */
  mass?: number;
  massUnit?: MassUnit;
  /** Legacy field, present only when `massUnit` is g. */
  unit?: 'g';
  massG?: number;
  massKg?: number;
  massLb?: number;
  densitySource?: string;
  densitySources?: string[];
  densityDefaulted?: boolean;
  unverified?: boolean;
  unverifiedReasons?: string[];
}

const massIn = (massG: number, unit: MassUnit): number => (unit === 'g' ? massG : unit === 'kg' ? massG / 1000 : massG / GRAMS_PER_POUND);

export interface Analysis {
  readonly volumeData: MassPropertiesData;
  readonly unverifiedReasons: string[];
  readonly densitySource: string;
  readonly centroidNote: string;
  readonly approval: string;
  readonly method: MassPropertiesData['method'];
}

interface AnalysisInput {
  readonly doc: CadDocument;
  readonly e: Entity;
  readonly target: Entity;
  readonly surfaceModel: 'level_mesh' | 'limit_patches' | undefined;
  readonly total: MassTotal;
  readonly weighted: boolean;
  readonly fallback: DensityFallback | undefined;
  readonly ctx: ExecutionContext | undefined;
  readonly frame: 'document' | 'entity';
  readonly about: readonly [number, number, number] | undefined;
  readonly purpose: 'general' | 'weight-and-balance';
}

/** Resolve mass properties and gather the review flags and the data every result carries (volume, method, centroid, inertia, provenance). */
export function analyze(input: AnalysisInput): Analysis {
  const { doc, e, target, surfaceModel, total, weighted, fallback, ctx, frame, about, purpose } = input;
  const { volume } = total;
  const context = ctx ?? currentContext();
  const densityOf = (solid: Entity): number => {
    const resolvedDensity = weighted ? resolveDensity(doc, solid.materialId, fallback) : null;
    return resolvedDensity?.available === true ? resolvedDensity.gPerDocUnit3 : 1;
  };
  const resolved = resolveMassProperties(doc, target, densityOf, context);
  const method = resolved?.method ?? total.method;
  const unverifiedReasons = [...total.unverifiedReasons];
  const warnings = resolved === null ? [] : precisionWarnings(doc, target, resolved);
  const imported = importedBodyStatus(doc, e);
  const review = reviewRequired(
    purpose,
    union(unverifiedReasons, [...(resolved === null ? [] : methodReasons(resolved)), ...(imported?.reasons ?? [])]),
    warnings,
  );
  const detail: MassDetail | null = resolved === null ? null : massDetail(doc, target, resolved, frame, about, weighted);
  const { sources } = total;
  const densitySource = sources.length === 1 ? (sources[0] ?? '') : sources.length === 0 ? 'none' : 'several (see densitySources)';
  const volumeData: MassPropertiesData = {
    volume,
    volumeUnit: `${doc.units}³`,
    ...(method === undefined ? {} : { method }),
    ...(surfaceModel === undefined ? {} : { surfaceModel }),
    ...(detail ?? {}),
    ...(resolved === null ? {} : { frame, provenance: massProvenance(target, resolved, context, densitySource) }),
    reviewRequired: review,
    ...(imported === undefined ? {} : { importUnverified: imported }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const centroidNote =
    detail === null
      ? ''
      : ` Centroid (${frame} frame) = ${detail.centroid.map((v) => formatLength(doc, v)).join(', ')}; principal moments = ` +
        `${detail.inertia.principal.moments.map((m) => m.toPrecision(7)).join(', ')} ${detail.inertia.unit}; method ${method}.`;
  const approval = review.value ? ` ${NOT_APPROVED} (${review.reasons.join('; ')}).` : '';
  return { volumeData, unverifiedReasons, densitySource, centroidNote, approval, method };
}

/** The result when no density is known for every part: the volume (and centroid / inertia) alone. */
export function volumeOnlyResult(doc: CadDocument, entityId: string, total: MassTotal, analysis: Analysis): CommandResult {
  const { volume, massG, approximation } = total;
  const { method, volumeData, centroidNote, approval } = analysis;
  const shown = volume.toFixed(doc.displayPrecision);
  const how =
    method === 'exact' ? ' (exact B-rep)' : method === 'mesh' ? ' (display mesh; the OCC kernel gives the exact B-rep volume)' : '';
  const why = massG === null ? ' (no mass: some parts have no material density and no density param was given)' : '';
  const sign = approximation === undefined ? '=' : '≈';
  const note = approximation === undefined ? '' : ` (${approximation})`;
  return report(
    doc,
    `Volume of ${entityId} ${sign} ${shown} ${doc.units}³${approximation === undefined ? how : note}${why}.${centroidNote}${approval}`,
    volumeData,
  );
}

/** The result with a density: mass in `massUnit`, density, plausibility warning. */
export function weightedResult(
  doc: CadDocument,
  e: Entity,
  entityId: string,
  total: MassTotal,
  massG: number,
  analysis: Analysis,
  fallback: DensityFallback | undefined,
  density: number | { value: number; unit: string } | undefined,
  massUnit: MassUnit,
): CommandResult {
  const { volume, approximation, sources } = total;
  const { volumeData, unverifiedReasons, densitySource, centroidNote, approval } = analysis;
  const volumeUnit = `${doc.units}³`;
  const shown = volume.toFixed(doc.displayPrecision);
  const note = approximation === undefined ? '' : ` (${approximation})`;
  const fallbackDensity = resolveDensity(doc, undefined, fallback);
  const meanDensity =
    total.gPerDocUnit3 ?? (volume > 0 ? massG / volume : fallbackDensity?.available === true ? fallbackDensity.gPerDocUnit3 : 0);
  const mass = massIn(massG, massUnit);
  const data: MassPropertiesData = {
    ...volumeData,
    density: meanDensity,
    densityUnit: `g/${doc.units}³`,
    densityKgPerM3: kgPerM3FromDocDensity(doc, meanDensity),
    mass,
    massUnit,
    ...(massUnit === 'g' ? { unit: 'g' as const } : {}),
    massG,
    massKg: massG / 1000,
    massLb: massG / GRAMS_PER_POUND,
    densitySource,
    ...(sources.length > 1 ? { densitySources: [...sources] } : {}),
    densityDefaulted: total.defaulted,
    unverified: unverifiedReasons.length > 0,
    unverifiedReasons,
  };
  const namedUnit = e.materialId !== undefined && doc.materials[e.materialId]?.densityUnit !== undefined;
  const densityWarning = densityPlausibilityWarning(
    doc,
    meanDensity,
    namedUnit || (typeof density === 'object' && e.materialId === undefined),
  );
  const densityNote = densityWarning === null ? '' : ` WARNING: ${densityWarning}; the mass is probably wrong.`;
  return report(
    doc,
    `Mass of ${e.kind === 'instance' ? 'assembly ' : ''}${entityId}: volume=${shown} ${volumeUnit}${note}, density=${meanDensity} g/${doc.units}³ = ${describeDensity(doc, meanDensity)} (${data.densitySource}), ` +
      `mass=${massUnit === 'g' ? mass.toFixed(doc.displayPrecision) : mass.toPrecision(7)} ${massUnit}.${densityNote}${centroidNote}${approval}`,
    { ...data, ...(densityWarning === null ? {} : { densityWarnings: [densityWarning] }) },
  );
}
