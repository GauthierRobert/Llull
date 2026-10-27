import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { entityBoundsInDoc, mergeBounds } from '../../geometry/bounds';
import { recipeOf } from '../../geometry/shapeRecipe';
import { expandInstance } from '../../geometry/instanceExpansion';
import type { Bounds } from '../../geometry/bounds';
import { formatLength } from '../../model/units';
import { childVolume, limitPatchEntity, solidVolume } from './solidVolume';
import { commandError, noop, report } from '../noop';
import {
  densityPlausibilityWarning,
  describeDensity,
  kgPerM3FromDocDensity,
  resolveDensity,
  type DensityFallback,
} from '../../geometry/resolveDensity';
import { convertValue, isUnitFailure } from '../../lib/quantity';
import { resolveMassProperties, type ResolvedMass } from '../../geometry/resolveMassProperties';
import { currentContext } from '../context';
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

/** World bounds of e: a kernel result that keeps its B-rep recipe uses the kernel's exact bounds when it reports them (OCC). */
function measuredBounds(doc: CadDocument, e: Entity, ctx: ExecutionContext | undefined): Bounds {
  if (e.kind === 'mesh' && e.brep !== undefined) {
    const kernel = (ctx ?? currentContext()).kernel;
    const shape = kernel?.evaluate(recipeOf(e)) ?? null;
    const exact = shape === null ? null : (kernel?.massProperties?.(shape) ?? null);
    if (exact !== null) return { min: exact.bounds.min, max: exact.bounds.max };
  }
  return entityBoundsInDoc(doc, e);
}

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
    'Compute the world-space axis-aligned bounding box (AABB) only; use mass_properties for mass, centroid and inertia. Three modes: (a) entityId — AABB of one entity; ' +
    '(b) useSelection:true — combined AABB of the current document selection; ' +
    '(c) no params (or useSelection:false) — combined AABB of the entire document. ' +
    'Returns data: { min:[x,y,z], max:[x,y,z], size:[w,h,d] }. Does not modify the document. ' +
    'Entity rotation and the sweep angle of a partly turned profile are applied (the AABB wraps the actual geometry). ' +
    'A kernel result (mesh with its B-rep) under the exact OCC kernel uses the B-rep bounds, not the display triangles.',
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
  run: (doc, { entityId, useSelection }, ctx): CommandResult => {
    let bounds: Bounds | null = null;
    if (entityId) {
      const e = doc.entities[entityId];
      if (!e) return noop(doc, `measure_bounding_box: entity '${entityId}' not found.`);
      bounds = measuredBounds(doc, e, ctx);
    } else {
      const ids = useSelection && doc.selection.length > 0 ? doc.selection : doc.order;
      for (const id of ids) {
        const e = doc.entities[id];
        if (!e) continue;
        const b = measuredBounds(doc, e, ctx);
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

/** Volume and mass (g) of a solid, with the density sources and unverified reasons used; `massG` null when a solid part has no density. */
interface MassTotal {
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
function densityParam(
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
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Measure the volume, area, centroid, inertia and (when a density is known) the mass of a 3D solid, in the document unit. ' +
    'Use measure_bounding_box for the bounding box alone and geometric_validation_properties for the unit-density values a STEP file embeds. ' +
    "Supported entity kinds: 'box', 'cylinder', 'sphere' (closed forms), 'extrusion', 'cone', 'torus', 'wedge', 'pyramid', " +
    "'revolution' (Pappus's centroid theorem; a profile crossing the axis falls back to the bounding-box volume), 'sweep' (round section: " +
    "section area × exact path length), 'loft' (the exact skinned B-rep with the OCC kernel, else its display triangles), 'subdivision', 'mesh' (a kernel result with the OCC kernel: the exact B-rep; otherwise its " +
    "display triangles), and 'instance' (assembly: the combined mass, centroid and inertia of its component solids, each with its own " +
    'material, else the instance material, else the density param). 2D shape entities are rejected. ' +
    'Density resolution, in order: the assigned material\'s density property model (define_property_model property "density"; the ' +
    "preferred one, read at 20 degC), else the material's plain density (create_material, g/(document-unit)³), else the density param. " +
    'A material always wins over the param. With none, mass is not given and the inertia is per unit density. If a material has density ' +
    'models that cannot be used (several and none preferred, or not valid at 20 degC), the command refuses with that code instead of falling back. ' +
    'Method order: exact (OCC kernel B-rep integration) > closed-form (primitives; volume of cone, torus, revolution, ... with inertia from the ' +
    'triangles scaled to it) > mesh (display triangles, integrated in a part frame so a part far from the origin keeps its precision). ' +
    'Returns data: { volume, volumeUnit (e.g. "mm³"), method ("exact" | "closed-form" | "mesh"), centroid (document unit, in the chosen frame), ' +
    'area and areaUnit when known, frame, inertia: { atCentroid, atOrigin (about `about`, default the frame origin), about, principal: ' +
    '{ moments (ascending), axes (unit vectors, right-handed) }, radiiOfGyration, unit ("g·mm²" with a density, else "mm⁵ (per unit density)") } ' +
    '(3x3 matrices, row-major, off-diagonals are -∫xy dm), provenance: { method, kernel: { name, ... }, inputs: { entityIds, recipeKey?, ' +
    'densitySource } }, reviewRequired: { value, reasons[] }, warnings? (KRN_PRECISION_ENVELOPE when the part is beyond ±1e5 mm), relErrorEstimate?, note? (set when the adaptive integration guard tripped and the fixed rule was used) } ' +
    'and, when a density is known, { density (g/(document-unit)³), densityKgPerM3, mass (in massUnit), massUnit, massG, massKg, massLb, ' +
    'densitySource (which value was used), densityDefaulted, unverified, unverifiedReasons } (plus unit: "g" when massUnit is g). ' +
    'A plain material density or a param is always unverified (no basis or source); a density model is unverified when its basis is typical / ' +
    'supplier_unstated / unspecified (unverified is about the density only). ' +
    "reviewRequired.value is true for purpose weight-and-balance, any unverified density, a mesh-integrated figure ('method_mesh'), a mesh body " +
    "without a B-rep ('faceted_body'), a body imported from STEP / IGES whose sender validation properties were red or not checkable " +
    '(data.importUnverified = { value, reasons } with import_gvp_red / import_gvp_not_checkable / verify_skipped, also in reviewRequired.reasons), or a part outside the precision envelope; the summary ' +
    'then says the figure is computed by llull, not approved, and needs a qualified engineer. A composite part id (create_composite_part) is not an entity: ' +
    'it is delegated to laminate_mass (ply and core mass of the laminate; its data shape applies). Does not modify the document.',
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
    frame: z
      .enum(['document', 'entity'])
      .describe(
        "Frame of data.centroid and data.inertia: 'document' (default; world axes, origin at the document origin) or 'entity' " +
          "(axes and origin of the entity's own position / rotation).",
      )
      .optional(),
    about: vec3(
      'Optional point [x, y, z] in document length units, expressed in the chosen frame, about which data.inertia.atOrigin is taken ' +
        '(parallel-axis theorem). Default: the frame origin [0, 0, 0].',
    ).optional(),
    surfaceModel: z
      .enum(['level_mesh', 'limit_patches'])
      .describe(
        "subdivision solids only: which surface the volume (and mass) measures. Default 'level_mesh': the refined `levels` mesh (what the viewport shows, identical with and without a kernel). 'limit_patches': the exact limit-surface patch solid when the native kernel is installed (volume, centroid, inertia and method all exact, from that solid); without the kernel it falls back to the level mesh. data.surfaceModel says which model was used.",
      )
      .optional(),
    purpose: z
      .enum(['general', 'weight-and-balance'])
      .describe(
        "'general' (default) or 'weight-and-balance'. weight-and-balance marks the result reviewRequired (data.reviewRequired.value true): " +
          'the figure is computed by llull and not approved; a qualified engineer must review it before it is used for flight or certification.',
      )
      .optional(),
  }),
  run: (
    doc,
    { entityId, density, massUnit = 'g', frame = 'document', about, purpose = 'general', surfaceModel: requestedModel },
    ctx,
  ): CommandResult => {
    const failed = (failure: MassFailure): CommandResult => ({
      ...noop(doc, `mass_properties: ${failure.error}`),
      ...(failure.code === undefined ? {} : { error: commandError(failure.code, failure.remediation ?? '', failure.ids ?? []) }),
    });
    const fallback = densityParam(doc, density);
    if (fallback !== undefined && 'error' in fallback) return failed(fallback);
    const e = doc.entities[entityId];
    if (!e) {
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
    const volumeUnit = `${doc.units}³`;
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
    const { volume, massG, approximation, sources } = total;
    const weighted = massG !== null && sources.length > 0;
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
    const densitySource = sources.length === 1 ? (sources[0] ?? '') : sources.length === 0 ? 'none' : 'several (see densitySources)';
    const volumeData: MassPropertiesData = {
      volume,
      volumeUnit,
      ...(method === undefined ? {} : { method }),
      ...(surfaceModel === undefined ? {} : { surfaceModel }),
      ...(detail ?? {}),
      ...(resolved === null ? {} : { frame, provenance: massProvenance(target, resolved, context, densitySource) }),
      reviewRequired: review,
      ...(imported === undefined ? {} : { importUnverified: imported }),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    const shown = volume.toFixed(doc.displayPrecision);
    const note = approximation === undefined ? '' : ` (${approximation})`;
    const centroidNote =
      detail === null
        ? ''
        : ` Centroid (${frame} frame) = ${detail.centroid.map((v) => formatLength(doc, v)).join(', ')}; principal moments = ` +
          `${detail.inertia.principal.moments.map((m) => m.toPrecision(7)).join(', ')} ${detail.inertia.unit}; method ${method}.`;
    const approval = review.value ? ` ${NOT_APPROVED} (${review.reasons.join('; ')}).` : '';
    if (!weighted) {
      const how =
        method === 'exact' ? ' (exact B-rep)' : method === 'mesh' ? ' (display mesh; the OCC kernel gives the exact B-rep volume)' : '';
      const why = massG === null ? ' (no mass: some parts have no material density and no density param was given)' : '';
      const sign = approximation === undefined ? '=' : '≈';
      return report(
        doc,
        `Volume of ${entityId} ${sign} ${shown} ${volumeUnit}${approximation === undefined ? how : note}${why}.${centroidNote}${approval}`,
        volumeData,
      );
    }
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
  },
});
