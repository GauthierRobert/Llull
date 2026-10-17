import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, z } from '../schema';
import { entityBoundsInDoc, mergeBounds } from '../../geometry/bounds';
import { expandInstance } from '../../geometry/instanceExpansion';
import type { Bounds } from '../../geometry/bounds';
import { formatLength } from '../document/units';
import { childVolume, solidVolume } from './solidVolume';
import { commandError, noop, report } from '../noop';
import { kgPerM3FromDocDensity, resolveDensity, type DensityFallback } from '../../geometry/resolveDensity';
import { convertValue, isUnitFailure } from '../../lib/quantity';

interface MeasureBoundingBoxData {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { min: Vec3, max: Vec3, size: Vec3 }
 * @failure missing entity id, empty document -> no-op, affected:[], no data
 */
export const measureBoundingBox = defineCommand({
  name: 'measure_bounding_box',
  annotations: { readOnly: true },
  description:
    'Compute the world-space axis-aligned bounding box (AABB). Three modes: (a) entityId — AABB of one entity; ' +
    '(b) useSelection:true — combined AABB of the current document selection; ' +
    '(c) no params (or useSelection:false) — combined AABB of the entire document. ' +
    'Returns data: { min:[x,y,z], max:[x,y,z], size:[w,h,d] }. Does not modify the document. ' +
    'Note: entity rotation is NOT applied to bounds (axis-aligned approximation).',
  params: z.object({
    entityId: z.string().optional().describe('Id of the entity whose bounding box to compute. Takes precedence over useSelection.'),
    useSelection: z
      .boolean()
      .optional()
      .describe(
        'When true and entityId is not provided, compute the AABB of the current selection. ' +
          'Falls back to the whole document if the selection is empty.',
      ),
  }),
  run: (doc, { entityId, useSelection }): CommandResult => {
    let bounds: Bounds | null = null;
    if (entityId) {
      const e = doc.entities[entityId];
      if (!e) return noop(doc, `measure_bounding_box: entity '${entityId}' not found.`);
      bounds = entityBoundsInDoc(doc, e);
    } else {
      const ids = useSelection && doc.selection.length > 0 ? doc.selection : doc.order;
      for (const id of ids) {
        const e = doc.entities[id];
        if (!e) continue;
        const b = entityBoundsInDoc(doc, e);
        bounds = bounds ? mergeBounds(bounds, b) : b;
      }
      if (!bounds) return noop(doc, 'measure_bounding_box: document is empty — no bounds to compute.');
    }
    const size: Vec3 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
    const data: MeasureBoundingBoxData = { min: bounds.min, max: bounds.max, size };
    return report(
      doc,
      `Bounding box: min=${bounds.min.map((v) => formatLength(doc, v)).join(', ')}; ` +
        `max=${bounds.max.map((v) => formatLength(doc, v)).join(', ')}; ` +
        `size=${size.map((v) => formatLength(doc, v)).join(' × ')}.`,
      data,
    );
  },
});

const GRAMS_PER_POUND = 453.59237;

const MASS_UNITS = ['g', 'kg', 'lb'] as const;
type MassUnit = (typeof MASS_UNITS)[number];

interface MassPropertiesData {
  volume: number;
  volumeUnit: string;
  method?: 'exact' | 'mesh';
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

/** Volume and mass (g) of a solid, with the density sources and unverified reasons used; `massG` null when a solid part has no density. */
interface MassTotal {
  readonly volume: number;
  readonly massG: number | null;
  readonly method?: 'exact' | 'mesh';
  readonly approximation?: string;
  readonly sources: readonly string[];
  readonly defaulted: boolean;
  readonly unverifiedReasons: readonly string[];
}

type MassFailure = { readonly error: string; readonly code?: string; readonly remediation?: string; readonly ids?: readonly string[] };

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

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
): MassTotal | MassFailure {
  const component = doc.components[instance.componentId];
  if (!component) return { error: `instance '${instance.id}' references missing component '${instance.componentId}'.` };
  let total: MassTotal = { volume: 0, massG: 0, sources: [], defaulted: false, unverifiedReasons: [] };
  for (const baked of expandInstance(instance, component)) {
    const materialId = baked.materialId ?? instance.materialId ?? inheritedMaterialId;
    const part =
      baked.kind === 'instance'
        ? instanceMass(doc, baked, materialId, fallback, ctx)
        : ((volume): MassTotal | MassFailure => {
            const mass = partMass(doc, volume, materialId, fallback, instance.id);
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
function densityParam(
  doc: CadDocument,
  density: number | { value: number; unit: string } | undefined,
): DensityFallback | MassFailure | undefined {
  if (density === undefined) return undefined;
  if (typeof density === 'number') {
    if (!(density > 0))
      return { error: `density must be > 0, got ${String(density)}.`, code: 'MAT_DENSITY_INVALID', remediation: 'give a density > 0' };
    return { kgPerM3: kgPerM3FromDocDensity(doc, density), source: `density param ${density} g/${doc.units}³`, defaulted: false };
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

const massIn = (massG: number, unit: MassUnit): number => (unit === 'g' ? massG : unit === 'kg' ? massG / 1000 : massG / GRAMS_PER_POUND);

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume, volumeUnit, method? } plus, when a density is known, { density (g/unit³), densityKgPerM3, mass in massUnit,
 *            massG, massKg, massLb, densitySource(s), densityDefaulted, unverified, unverifiedReasons } (and legacy unit:'g' when massUnit is g)
 * @failure non-solid entity, missing id, a density <= 0 or with a bad unit, an unusable density model -> no-op, affected:[], no data
 *
 * Density resolution (`geometry/resolveDensity`, 08 TR-MAT-10): the material's PHY-01 density model (preferred, at 20 degC), else its
 * legacy density (g/(document unit)³), else the `density` param. Without any, only the volume is returned.
 */
export const massProperties = defineCommand({
  name: 'mass_properties',
  annotations: { readOnly: true },
  description:
    'Measure the volume of a 3D solid and, when a density is known, its mass. ' +
    "Supported entity kinds: 'box' (w×h×d), 'cylinder' (π r² h), 'sphere' (4/3 π r³), 'extrusion' (profile area × depth), " +
    "'mesh' (a kernel result with the OCC kernel: the exact B-rep volume; otherwise the signed-tetrahedra sum of its " +
    "display triangles — data.method says which), 'cone', 'torus', 'wedge' (half the enclosing box), 'pyramid', " +
    "'revolution' (Pappus's centroid theorem; a profile crossing the axis falls back to the bounding-box volume), " +
    "'sweep' (round section: section area × exact path length; other sections: closed-mesh sum), 'loft', " +
    "'subdivision' (closed-mesh sum), and 'instance' (assembly: the sum over its component solids, each with its " +
    'own material, else the instance material, else the density param). 2D shape entities are rejected. ' +
    'Density resolution, in order: the assigned material\'s density property model (define_property_model property "density"; the ' +
    "preferred one, read at 20 degC), else the material's plain density (create_material, g/(document-unit)³), else the density param. " +
    'A material always wins over the param. With none, only the volume is returned. If a material has density models that cannot be used ' +
    '(several and none preferred, or not valid at 20 degC), the command refuses with that code instead of falling back. ' +
    'Returns data: { volume, volumeUnit (e.g. "mm³"), method? } and, when a density is known, { density (g/(document-unit)³), ' +
    'densityKgPerM3, mass (in massUnit), massUnit, massG, massKg, massLb, densitySource (which value was used), densityDefaulted, ' +
    'unverified, unverifiedReasons } (plus unit: "g" when massUnit is g). A plain material density or a param is always unverified ' +
    '(no basis or source); a density model is unverified when its basis is typical / supplier_unstated / unspecified. Does not modify the document.',
  params: z.object({
    entityId: z
      .string()
      .describe(
        "Id of the 3D solid entity to measure. Supported kinds: 'box', 'cylinder', 'sphere', " +
          "'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution', 'sweep', 'loft', 'subdivision', 'instance'.",
      ),
    density: z
      .union([
        z.number(),
        z.object({
          value: z.number().describe('Density value; must be > 0.'),
          unit: z.string().describe('Density unit, e.g. "g/cm^3", "kg/m^3", "lb/in^3".'),
        }),
      ])
      .describe(
        'Optional fallback density, used only for solids without an assigned material; omit it to measure the volume alone. ' +
          'Either { value, unit } (e.g. { "value": 0.101, "unit": "lb/in^3" }) or a bare number in g/(document-unit)³ ' +
          '(for a mm document: steel ≈ 0.00785, aluminium ≈ 0.0027). Must be > 0.',
      )
      .optional(),
    massUnit: z
      .enum(MASS_UNITS)
      .describe('Unit of data.mass and of the summary: g (default), kg or lb. massG / massKg / massLb are always given.')
      .optional(),
  }),
  run: (doc, { entityId, density, massUnit = 'g' }, ctx): CommandResult => {
    const failed = (failure: MassFailure): CommandResult => ({
      ...noop(doc, `mass_properties: ${failure.error}`),
      ...(failure.code === undefined ? {} : { error: commandError(failure.code, failure.remediation ?? '', failure.ids ?? []) }),
    });
    const fallback = densityParam(doc, density);
    if (fallback !== undefined && 'error' in fallback) return failed(fallback);
    const e = doc.entities[entityId];
    if (!e) return noop(doc, `mass_properties: entity '${entityId}' not found.`);
    const volumeUnit = `${doc.units}³`;
    let total: MassTotal | MassFailure;
    if (e.kind === 'instance') total = instanceMass(doc, e, undefined, fallback, ctx);
    else {
      const measured = solidVolume(doc, e, ctx);
      if ('error' in measured) return noop(doc, `mass_properties: ${measured.error}`);
      const mass = partMass(doc, measured.volume, e.materialId, fallback, entityId);
      total = 'error' in mass ? mass : { ...measured, ...mass };
    }
    if ('error' in total) return failed(total);
    const { volume, massG, method, approximation, sources } = total;
    const volumeData = { volume, volumeUnit, ...(method === undefined ? {} : { method }) };
    const shown = volume.toFixed(doc.displayPrecision);
    const note = approximation === undefined ? '' : ` (${approximation})`;
    if (massG === null || sources.length === 0) {
      const how =
        method === 'exact' ? ' (exact B-rep)' : method === 'mesh' ? ' (display mesh; the OCC kernel gives the exact B-rep volume)' : '';
      const why = massG === null ? ' (no mass: some parts have no material density and no density param was given)' : '';
      const sign = approximation === undefined ? '=' : '≈';
      return report(
        doc,
        `Volume of ${entityId} ${sign} ${shown} ${volumeUnit}${approximation === undefined ? how : note}${why}.`,
        volumeData satisfies MassPropertiesData,
      );
    }
    const meanDensity = volume > 0 ? massG / volume : 0;
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
      densitySource: sources.length === 1 ? (sources[0] ?? '') : 'several (see densitySources)',
      ...(sources.length > 1 ? { densitySources: [...sources] } : {}),
      densityDefaulted: total.defaulted,
      unverified: total.unverifiedReasons.length > 0,
      unverifiedReasons: [...total.unverifiedReasons],
    };
    const flag = data.unverified === true ? ` Unverified density (${total.unverifiedReasons.join('; ')}).` : '';
    return report(
      doc,
      `Mass of ${e.kind === 'instance' ? 'assembly ' : ''}${entityId}: volume=${shown} ${volumeUnit}${note}, density=${meanDensity} g/${doc.units}³ (${data.densitySource}), ` +
        `mass=${massUnit === 'g' ? mass.toFixed(doc.displayPrecision) : mass.toPrecision(7)} ${massUnit}.${flag}`,
      data,
    );
  },
});
