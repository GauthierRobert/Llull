import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { entityBoundsInDoc, mergeBounds } from '../../geometry/bounds';
import { kernelEntityBounds } from '../../geometry/kernelBounds';
import type { BoundsSource } from '../../geometry/kernelBounds';
import { recipeOf } from '../../geometry/shapeRecipe';
import type { Bounds } from '../../geometry/bounds';
import { formatLength } from '../../model/units';
import { commandError, noop, report } from '../noop';
import { currentContext } from '../context';
import { MASS_UNITS, type MassFailure, densityParam, measureTotal, missingEntityResult } from './massMeasure';
import { analyze, volumeOnlyResult, weightedResult } from './massPropertiesReport';

/** Kinds whose closed-form world box is provably tight at any rotation: sphere, cylinder (half-axis·|n| + r·sqrt(1-n²) per axis) and box (its 8 corners). */
const CLOSED_FORM_TIGHT: ReadonlySet<Entity['kind']> = new Set(['box', 'cylinder', 'sphere']);

/** World bounds of e and their source: the kernel's tight box of the placed exact shape (TR-ASC-15), else the analytic estimate. */
function measuredBounds(doc: CadDocument, e: Entity, ctx: ExecutionContext | undefined): { bounds: Bounds; source: BoundsSource } {
  const kernel = (ctx ?? currentContext()).kernel;
  const exact = kernelEntityBounds(e, kernel);
  if (exact !== null) return { bounds: exact, source: 'exact' };
  if (e.kind === 'mesh' && e.brep !== undefined) {
    const shape = kernel?.evaluate(recipeOf(e)) ?? null;
    const mass = shape === null ? null : (kernel?.massProperties?.(shape) ?? null);
    if (mass !== null) return { bounds: { min: mass.bounds.min, max: mass.bounds.max }, source: 'exact' };
  }
  return { bounds: entityBoundsInDoc(doc, e), source: CLOSED_FORM_TIGHT.has(e.kind) ? 'exact' : 'conservative' };
}

interface MeasureBoundingBoxData {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  /** 'exact': every measured entity is the kernel's tight box or a tight closed form (box, cylinder, sphere); 'conservative': at least one is an analytic / mesh / corner estimate (a superset). */
  bounds: BoundsSource;
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { min: Vec3, max: Vec3, size: Vec3, bounds: 'exact' | 'conservative' }
 * @failure missing entity id, empty document -> no-op, affected:[], no data
 * @invariant kernel-optional: a kernel-backed entity (curved or swept solid, kernel result) gets the kernel's tight box of the placed shape (data.bounds 'exact'); without a kernel, or for an entity with no exact shape, the analytic / corner estimate ('conservative', a superset)
 */
export const measureBoundingBox = defineCommand({
  name: 'measure_bounding_box',
  annotations: { kernelOptional: true, readOnly: true },
  description:
    'Compute the world-space axis-aligned bounding box (AABB) only; use mass_properties for mass, centroid and inertia. Three modes: (a) entityId — AABB of one entity; ' +
    '(b) useSelection:true — combined AABB of the current document selection; ' +
    '(c) no params (or useSelection:false) — combined AABB of the entire document. ' +
    "Returns data: { min:[x,y,z], max:[x,y,z], size:[w,h,d], bounds:'exact'|'conservative' }. Does not modify the document. " +
    'Entity rotation and the sweep angle of a partly turned profile are applied (the AABB wraps the actual geometry). ' +
    "Under the exact OCC kernel a kernel result or an extruded, turned, swept or lofted solid, cone, torus, wedge or pyramid is measured on its exact shape as placed (the tight box, data.bounds 'exact'); a box, cylinder or sphere is always exact (its closed-form box is tight at any rotation); otherwise (no kernel, meshes, instances, 2D shapes, cone / torus / kernel kinds without a kernel) the box wraps the rotated geometry and may exceed it: data.bounds 'conservative' (also when any entity of a combined box is).",
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
    let source: BoundsSource = 'exact';
    const take = (e: Entity): void => {
      const measured = measuredBounds(doc, e, ctx);
      bounds = bounds ? mergeBounds(bounds, measured.bounds) : measured.bounds;
      if (measured.source === 'conservative') source = 'conservative';
    };
    if (entityId) {
      const e = doc.entities[entityId];
      if (!e) return noop(doc, `measure_bounding_box: entity '${entityId}' not found.`);
      take(e);
    } else {
      const ids = useSelection && doc.selection.length > 0 ? doc.selection : doc.order;
      for (const id of ids) {
        const e = doc.entities[id];
        if (e) take(e);
      }
    }
    const found: Bounds | null = bounds;
    if (!found) return noop(doc, 'measure_bounding_box: document is empty — no bounds to compute.');
    return boundsReport(doc, found, source);
  },
});

function boundsReport(doc: CadDocument, bounds: Bounds, source: BoundsSource): CommandResult {
  const size: Vec3 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const data: MeasureBoundingBoxData = { min: bounds.min, max: bounds.max, size, bounds: source };
  return report(
    doc,
    `Bounding box (${source}): min=${bounds.min.map((v) => formatLength(doc, v)).join(', ')}; ` +
      `max=${bounds.max.map((v) => formatLength(doc, v)).join(', ')}; ` +
      `size=${size.map((v) => formatLength(doc, v)).join(' × ')}.`,
    data,
  );
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume, volumeUnit, method? } plus, when a density is known, { density (g/unit³), densityKgPerM3, mass in massUnit,
 *            massG, massKg, massLb, densitySource(s), densityDefaulted, unverified, unverifiedReasons } (and legacy unit:'g' when massUnit is g)
 * @invariant kernel-optional: with an exact kernel the B-rep is integrated (method "exact"); without one the closed form or the display triangles answer (method "closed-form" / "mesh")
 * @failure non-solid entity, missing id, a density <= 0 or with a bad unit, an unusable density model -> no-op, affected:[], no data
 *
 * Density resolution (`geometry/resolveDensity`, 08 TR-MAT-10): the material's PHY-01 density model (preferred, at 20 degC), else its
 * legacy density (g/(document unit)³), else the `density` param. Without any, only the volume is returned.
 */
export const massProperties = defineCommand({
  name: 'mass_properties',
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
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
    if (!e) return missingEntityResult(doc, entityId, ctx);
    const measured = measureTotal(doc, e, entityId, requestedModel, fallback, ctx, failed);
    if ('document' in measured) return measured;
    const { total, target, surfaceModel } = measured;
    const { massG, sources } = total;
    const weighted = massG !== null && sources.length > 0;
    const analysis = analyze({ doc, e, target, surfaceModel, total, weighted, fallback, ctx, frame, about, purpose });
    if (!weighted) return volumeOnlyResult(doc, entityId, total, analysis);
    return weightedResult(doc, e, entityId, total, massG, analysis, fallback, density, massUnit);
  },
});
