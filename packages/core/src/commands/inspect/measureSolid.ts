import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, z } from '../schema';
import { entityBoundsInDoc, mergeBounds } from '../../geometry/bounds';
import { expandInstance } from '../../geometry/instanceExpansion';
import type { Bounds } from '../../geometry/bounds';
import { formatLength } from '../document/units';
import { childVolume, solidVolume } from './solidVolume';
import { noop, report } from '../noop';

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

interface MassPropertiesData {
  volume: number;
  volumeUnit: string;
  method?: 'exact' | 'mesh';
  density?: number;
  mass?: number;
  unit?: 'g';
}

/**
 * Volume and mass of a baked instance: every solid child uses its own material density, else the
 * instance's material, else `fallbackDensity`. Nested instances recurse; 2D children weigh nothing.
 * `mass` is null when some solid child has no known density.
 */
function instanceMass(
  doc: CadDocument,
  instance: Entity & { kind: 'instance' },
  fallbackDensity: number | undefined,
  ctx: ExecutionContext | undefined,
): { volume: number; mass: number | null } | string {
  const component = doc.components[instance.componentId];
  if (!component) return `instance '${instance.id}' references missing component '${instance.componentId}'.`;
  let volume = 0;
  let mass: number | null = 0;
  for (const baked of expandInstance(instance, component)) {
    const materialId = baked.materialId ?? instance.materialId;
    const material = materialId ? doc.materials[materialId] : undefined;
    const density = material?.density ?? fallbackDensity;
    if (baked.kind === 'instance') {
      const nested = instanceMass(doc, baked, density, ctx);
      if (typeof nested === 'string') return nested;
      volume += nested.volume;
      mass = mass === null || nested.mass === null ? null : mass + nested.mass;
      continue;
    }
    const partVolume = childVolume(doc, baked, ctx);
    volume += partVolume;
    if (partVolume > 0 && density === undefined) mass = null;
    else if (mass !== null) mass += partVolume * (density ?? 0);
  }
  return { volume, mass };
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume, volumeUnit, method? } plus { density, mass, unit: 'g' } when a density is known
 * @failure non-solid entity, missing id, or a given density <= 0 -> no-op, affected:[], no data
 *
 * Density resolution order:
 *   1. If the entity has a `materialId` and that material exists in `doc.materials`,
 *      the material's density is used (ignores the `density` param for that entity).
 *   2. Otherwise the caller-supplied `density` param is used.
 *   3. Otherwise only the volume is returned (no mass).
 * Unit assumption: density is in g/(document-unit)³ so that mass = volume × density in grams.
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
    'own material density, else the instance material, else the density param). 2D shape entities are rejected. ' +
    'Density resolution: if the entity has a material assigned (via assign_material) and that ' +
    "material exists in doc.materials, the material's density is used automatically — the density " +
    'param is ignored for that entity. Otherwise the density param is used (g/(document-unit)³ — for a document in ' +
    'mm: steel ≈ 0.00785, aluminium ≈ 0.0027). With neither, only the volume is returned. ' +
    'Returns data: { volume, volumeUnit (e.g. "mm³"), method? } and, when a density is known, ' +
    '{ density, mass, unit: "g" }. Does not modify the document.',
  params: z.object({
    entityId: z
      .string()
      .describe(
        "Id of the 3D solid entity to measure. Supported kinds: 'box', 'cylinder', 'sphere', " +
          "'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution', 'sweep', 'loft', 'subdivision', 'instance'.",
      ),
    density: z
      .number()
      .describe(
        'Optional fallback material density in g/(document-unit)³. Must be > 0 when given. ' +
          'Used only when the entity has no material assigned via assign_material; omit it to measure the volume alone. ' +
          'Examples for a mm document: steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124.',
      )
      .optional(),
  }),
  run: (doc, { entityId, density }, ctx): CommandResult => {
    if (density !== undefined && density <= 0) return noop(doc, `mass_properties: density must be > 0, got ${String(density)}.`);
    const e = doc.entities[entityId];
    if (!e) return noop(doc, `mass_properties: entity '${entityId}' not found.`);
    const volumeUnit = `${doc.units}³`;
    const materialDensity = e.materialId ? doc.materials[e.materialId]?.density : undefined;
    const effectiveDensity = materialDensity ?? density;
    const densitySource = materialDensity === undefined ? 'param' : `material '${e.materialId}'`;
    if (e.kind === 'instance') {
      const assembly = instanceMass(doc, e, density, ctx);
      if (typeof assembly === 'string') return noop(doc, `mass_properties: ${assembly}`);
      const { volume, mass } = assembly;
      if (mass === null)
        return report(
          doc,
          `Volume of ${entityId} = ${volume.toFixed(doc.displayPrecision)} ${volumeUnit} ` +
            '(no mass: some parts have no material density and no density param was given).',
          { volume, volumeUnit } satisfies MassPropertiesData,
        );
      const averageDensity = volume > 0 ? mass / volume : (density ?? 0);
      const data: MassPropertiesData = { volume, volumeUnit, density: averageDensity, mass, unit: 'g' };
      return report(
        doc,
        `Mass of assembly ${entityId}: volume=${volume.toFixed(doc.displayPrecision)} ${doc.units}³, ` +
          `mean density=${averageDensity} g/${doc.units}³ (per-part materials, else param), mass=${mass.toFixed(doc.displayPrecision)} g.`,
        data,
      );
    }
    const measured = solidVolume(doc, e, ctx);
    if ('error' in measured) return noop(doc, `mass_properties: ${measured.error}`);
    const { volume, method, approximation } = measured;
    const volumeData = { volume, volumeUnit, ...(method === undefined ? {} : { method }) };
    const shown = volume.toFixed(doc.displayPrecision);
    if (effectiveDensity === undefined) {
      const how =
        method === 'exact' ? ' (exact B-rep)' : method === 'mesh' ? ' (display mesh; the OCC kernel gives the exact B-rep volume)' : '';
      const sign = approximation === undefined ? '=' : '≈';
      const note = approximation === undefined ? how : ` (${approximation})`;
      return report(doc, `Volume of ${entityId} ${sign} ${shown} ${volumeUnit}${note}.`, volumeData satisfies MassPropertiesData);
    }
    const mass = volume * effectiveDensity;
    const data: MassPropertiesData = { ...volumeData, density: effectiveDensity, mass, unit: 'g' };
    return report(
      doc,
      `Mass of ${entityId}: volume=${shown} ${doc.units}³${approximation === undefined ? '' : ` (${approximation})`}, ` +
        `density=${effectiveDensity} g/${doc.units}³ (${densitySource}), mass=${mass.toFixed(doc.displayPrecision)} g.`,
      data,
    );
  },
});
