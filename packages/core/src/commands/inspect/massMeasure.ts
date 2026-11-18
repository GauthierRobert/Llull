/** The measuring half of mass_properties: volume and mass of a solid or a baked instance, the density fallback, and the composite-part delegation. */

import type { CadDocument, Entity } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { expandInstance } from '../../geometry/instanceExpansion';
import { kgPerM3FromDocDensity, resolveDensity, type DensityFallback } from '../../geometry/resolveDensity';
import { convertValue, isUnitFailure } from '../../lib/quantity';
import { currentContext } from '../context';
import { noop } from '../noop';
import { childVolume, limitPatchEntity, solidVolume } from './solidVolume';

export const MASS_UNITS = ['g', 'kg', 'lb'] as const;
export type MassUnit = (typeof MASS_UNITS)[number];

/** Volume and mass (g) of a solid, with the density sources and unverified reasons used; `massG` null when a solid part has no density. */
export interface MassTotal {
  readonly volume: number;
  readonly massG: number | null;
  readonly method?: 'exact' | 'mesh';
  readonly approximation?: string;
  readonly sources: readonly string[];
  readonly defaulted: boolean;
  readonly unverifiedReasons: readonly string[];
  /** The one density used, for a single solid (an assembly reports the mean). */
  readonly gPerDocUnit3?: number;
}

export type MassFailure = {
  readonly error: string;
  readonly code?: string;
  readonly remediation?: string;
  readonly ids?: readonly string[];
};

export const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** Mass of `volume` (document units³) of `materialId`, else `fallback`. */
function partMass(
  doc: CadDocument,
  volume: number,
  materialId: string | undefined,
  fallback: DensityFallback | undefined,
  id: string,
): Omit<MassTotal, 'volume'> | MassFailure {
  const density = resolveDensity(doc, materialId, fallback);
  if (density === null) return { massG: volume > 0 ? null : 0, sources: [], defaulted: false, unverifiedReasons: [] };
  if (!density.available) return { error: density.reason, code: density.code, remediation: density.remediation, ids: [id] };
  return {
    massG: volume * density.gPerDocUnit3,
    gPerDocUnit3: density.gPerDocUnit3,
    sources: [density.source],
    defaulted: density.defaulted,
    unverifiedReasons: density.unverifiedReasons,
  };
}

/**
 * Volume and mass of a baked instance: every solid child uses its own material, else the instance's material, else `fallback`. Nested
 * instances recurse; 2D children weigh nothing.
 */
function instanceMass(
  doc: CadDocument,
  instance: Entity & { kind: 'instance' },
  inheritedMaterialId: string | undefined,
  fallback: DensityFallback | undefined,
  ctx: ExecutionContext | undefined,
  rootId: string = instance.id,
): MassTotal | MassFailure {
  const component = doc.components[instance.componentId];
  if (!component) return { error: `instance '${instance.id}' references missing component '${instance.componentId}'.` };
  let total: MassTotal = { volume: 0, massG: 0, sources: [], defaulted: false, unverifiedReasons: [] };
  for (const baked of expandInstance(instance, component)) {
    const materialId = baked.materialId ?? instance.materialId ?? inheritedMaterialId;
    const part =
      baked.kind === 'instance'
        ? instanceMass(doc, baked, materialId, fallback, ctx, rootId)
        : ((volume): MassTotal | MassFailure => {
            const mass = partMass(doc, volume, materialId, fallback, rootId);
            return 'error' in mass ? mass : { volume, ...mass };
          })(childVolume(doc, baked, ctx));
    if ('error' in part) return part;
    total = {
      volume: total.volume + part.volume,
      massG: total.massG === null || part.massG === null ? null : total.massG + part.massG,
      sources: union(total.sources, part.sources),
      defaulted: total.defaulted || part.defaulted,
      unverifiedReasons: union(total.unverifiedReasons, part.unverifiedReasons),
    };
  }
  return total;
}

/** The `density` param as a fallback: a bare number is g/(document unit)³, `{ value, unit }` any density unit. */
export function densityParam(
  doc: CadDocument,
  density: number | { value: number; unit: string } | undefined,
): DensityFallback | MassFailure | undefined {
  if (density === undefined) return undefined;
  if (typeof density === 'number') {
    if (!(density > 0))
      return { error: `density must be > 0, got ${String(density)}.`, code: 'MAT_DENSITY_INVALID', remediation: 'give a density > 0' };
    return {
      kgPerM3: kgPerM3FromDocDensity(doc, density),
      gPerDocUnit3: density,
      source: `density param ${density} g/${doc.units}³`,
      defaulted: false,
    };
  }
  const converted = convertValue(density.value, density.unit, 'kg/m^3');
  if (isUnitFailure(converted))
    return {
      error: `density: ${converted.message}`,
      code: converted.code,
      remediation: 'give a density unit such as g/cm^3, kg/m^3 or lb/in^3',
    };
  if (!(converted.value > 0))
    return {
      error: `density must be > 0, got ${density.value} ${density.unit}.`,
      code: 'MAT_DENSITY_INVALID',
      remediation: 'give a density > 0',
    };
  return { kgPerM3: converted.value, source: `density param ${density.value} ${density.unit}`, defaulted: false };
}

export interface Measured {
  readonly total: MassTotal;
  readonly target: Entity;
  readonly surfaceModel: 'level_mesh' | 'limit_patches' | undefined;
}

/** A composite part id or name is not an entity: laminate_mass answers it; otherwise the id is unknown. */
export function missingEntityResult(doc: CadDocument, entityId: string, ctx: ExecutionContext | undefined): CommandResult {
  const composites = doc.composites;
  const part = composites?.parts[entityId] ?? Object.values(composites?.parts ?? {}).find((candidate) => candidate.name === entityId);
  const laminateMass = part === undefined ? undefined : (ctx ?? currentContext()).registry('laminate_mass');
  if (part !== undefined && laminateMass !== undefined) {
    const delegated = laminateMass.run(doc, { part: part.id }, ctx);
    return {
      ...delegated,
      summary: `mass_properties: '${entityId}' is a composite part, delegated to laminate_mass. ${delegated.summary}`,
    };
  }
  return noop(doc, `mass_properties: entity '${entityId}' not found.`);
}

/** Volume and mass of `e` (an instance sums its parts; a subdivision may measure its limit patches), or the refusal. */
export function measureTotal(
  doc: CadDocument,
  e: Entity,
  entityId: string,
  requestedModel: 'level_mesh' | 'limit_patches' | undefined,
  fallback: DensityFallback | undefined,
  ctx: ExecutionContext | undefined,
  failed: (failure: MassFailure) => CommandResult,
): Measured | CommandResult {
  let total: MassTotal | MassFailure;
  let surfaceModel: 'level_mesh' | 'limit_patches' | undefined;
  let target: Entity = e;
  if (e.kind === 'instance') total = instanceMass(doc, e, undefined, fallback, ctx);
  else {
    const patches = requestedModel === 'limit_patches' ? limitPatchEntity(e, ctx) : null;
    target = patches ?? e;
    if (e.kind === 'subdivision') surfaceModel = patches === null ? 'level_mesh' : 'limit_patches';
    const measured = solidVolume(doc, target, ctx);
    if ('error' in measured) return noop(doc, `mass_properties: ${measured.error}`);
    const mass = partMass(doc, measured.volume, e.materialId, fallback, entityId);
    total = 'error' in mass ? mass : { ...measured, ...mass };
  }
  if ('error' in total) return failed(total);
  return { total, target, surfaceModel };
}
