import type { Vec3 } from '../model/types';
import { cross3, dot3 } from '../lib/vec3';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { entityBounds, mergeBounds } from './sceneBounds';
import type { Bounds } from './sceneTypes';
import { formatLength } from './units';
import { polygonArea, polygonCentroid } from '../lib/polygon';
import { noop } from './noop';
interface MeasureBoundingBoxData {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/**
 * @command measure_bounding_box
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { min: Vec3, max: Vec3, size: Vec3 }
 * @failure missing entity id, empty document -> no-op, affected:[], no data
 */
export const measureBoundingBox = defineCommand({
  name: 'measure_bounding_box',
  annotations: { readOnly: true },
  description:
    'Compute the world-space axis-aligned bounding box (AABB). Three modes: ' +
    '(a) entityId — AABB of one entity; ' +
    '(b) useSelection:true — combined AABB of the current document selection; ' +
    '(c) no params (or useSelection:false) — combined AABB of the entire document. ' +
    'Returns data: { min:[x,y,z], max:[x,y,z], size:[w,h,d] }. Does not modify the document. ' +
    'Note: entity rotation is NOT applied to bounds (axis-aligned approximation).',
  params: z.object({
    entityId: z
      .string()
      .optional()
      .describe(
        'Id of the entity whose bounding box to compute. Takes precedence over useSelection.',
      ),
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
      if (!e) {
        return noop(doc, `measure_bounding_box: entity '${entityId}' not found.`);
      }
      bounds = entityBounds(e);
    } else {
      const ids = useSelection && doc.selection.length > 0 ? doc.selection : doc.order;

      for (const id of ids) {
        const e = doc.entities[id];
        if (!e) continue;
        const b = entityBounds(e);
        bounds = bounds ? mergeBounds(bounds, b) : b;
      }

      if (!bounds) {
        return noop(doc, 'measure_bounding_box: document is empty — no bounds to compute.');
      }
    }

    const size: Vec3 = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const data: MeasureBoundingBoxData = { min: bounds.min, max: bounds.max, size };
    return {
      document: doc,
      summary:
        `Bounding box: min=${bounds.min.map((v) => formatLength(doc, v)).join(', ')}; ` +
        `max=${bounds.max.map((v) => formatLength(doc, v)).join(', ')}; ` +
        `size=${size.map((v) => formatLength(doc, v)).join(' × ')}.`,
      affected: [],
      data,
    };
  },
});

interface MeasureVolumeData {
  volume: number;
  unit: string;
}

/** Signed-tetrahedra volume of a closed, consistently wound indexed mesh (Σ A·(B×C) / 6). */
function meshVolume(positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number {
  const vertex = (i: number): Vec3 => [
    positions[i * 3] as number,
    positions[i * 3 + 1] as number,
    positions[i * 3 + 2] as number,
  ];
  let sum = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    sum += dot3(
      vertex(indices[t] as number),
      cross3(vertex(indices[t + 1] as number), vertex(indices[t + 2] as number)),
    );
  }
  return Math.abs(sum / 6);
}

/**
 * @command measure_volume
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume: number, unit: string } where unit is derived (e.g. "mm³")
 * @failure non-solid entity or missing id -> no-op, affected:[], no data
 */
export const measureVolume = defineCommand({
  name: 'measure_volume',
  annotations: { readOnly: true },
  description:
    "Compute the volume of a 3D solid entity. Supported kinds: 'box' (w×h×d), " +
    "'cylinder' (π r² h), 'sphere' (4/3 π r³), 'extrusion' (profile area × depth), " +
    "'mesh' (signed-tetrahedra sum — assumes closed, consistently wound mesh), " +
    "'cone' (π r² h / 3), 'torus' (2 π² · ringRadius · tubeRadius²), " +
    "'wedge' (w×h×d / 2 — half the enclosing box), " +
    "'pyramid' (baseWidth × baseDepth × height / 3), " +
    "'revolution' (Pappus's centroid theorem: sweepAngle × |x_centroid| × profileArea; " +
    'falls back to bounding-box approximation if the profile crosses the revolution axis). ' +
    'Returns data: { volume, unit } where unit is the cubed document unit (e.g. "mm³"). ' +
    '2D shape entities are rejected. Does not modify the document.',
  params: z.object({
    entityId: z
      .string()
      .describe(
        "Id of the 3D solid entity to measure. Supported kinds: 'box', 'cylinder', 'sphere', " +
          "'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution'.",
      ),
  }),
  run: (doc, { entityId }): CommandResult => {
    const e = doc.entities[entityId];
    if (!e) {
      return noop(doc, `measure_volume: entity '${entityId}' not found.`);
    }

    const volumeUnit = `${doc.units}³`;
    let volume: number;

    switch (e.kind) {
      case 'box':
        volume = e.size[0] * e.size[1] * e.size[2];
        break;
      case 'cylinder':
        volume = Math.PI * e.radius * e.radius * e.height;
        break;
      case 'sphere':
        volume = (4 / 3) * Math.PI * e.radius * e.radius * e.radius;
        break;
      case 'extrusion':
        volume = polygonArea(e.profile) * e.depth;
        break;
      case 'mesh':
        volume = meshVolume(e.mesh.positions, e.mesh.indices);
        break;
      case 'cone':
        volume = (Math.PI * e.radius * e.radius * e.height) / 3;
        break;
      case 'torus':
        volume = 2 * Math.PI * Math.PI * e.ringRadius * e.tubeRadius * e.tubeRadius;
        break;
      case 'wedge':
        volume = (e.size[0] * e.size[1] * e.size[2]) / 2;
        break;
      case 'pyramid':
        volume = (e.baseWidth * e.baseDepth * e.height) / 3;
        break;
      case 'revolution': {
        // Pappus: V = sweepAngle * |centroid x| * profile area; profile x = distance from the axis.
        // A profile crossing the axis falls back to the bounding-box volume.
        if (e.profile.some(([x]) => x < 0)) {
          const b = entityBounds(e);
          volume = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
          return {
            document: doc,
            summary:
              `Volume of ${entityId} ≈ ${volume.toFixed(doc.displayPrecision)} ${volumeUnit} ` +
              `(bounding-box approximation — profile crosses revolution axis; Pappus requires profile x ≥ 0).`,
            affected: [],
            data: { volume, unit: volumeUnit } satisfies MeasureVolumeData,
          };
        }
        const profileArea = polygonArea(e.profile);
        volume =
          profileArea < 1e-12
            ? 0
            : (e.angle ?? 2 * Math.PI) * Math.abs(polygonCentroid(e.profile)[0]) * profileArea;
        break;
      }
      default:
        return noop(
          doc,
          `measure_volume: entity '${entityId}' is kind '${e.kind}'; ` +
            "supported kinds are 'box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution'.",
        );
    }

    const data: MeasureVolumeData = { volume, unit: volumeUnit };
    return {
      document: doc,
      summary: `Volume of ${entityId} = ${volume.toFixed(doc.displayPrecision)} ${volumeUnit}.`,
      affected: [],
      data,
    };
  },
});

interface MassPropertiesData {
  volume: number;
  density: number;
  mass: number;
  unit: string;
}

/**
 * @command mass_properties
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume, density, mass, unit }
 * @failure non-solid entity, missing id, or effective density <= 0 -> no-op, affected:[], no data
 *
 * Density resolution order:
 *   1. If the entity has a `materialId` and that material exists in `doc.materials`,
 *      the material's density is used (ignores the `density` param for that entity).
 *   2. Otherwise the caller-supplied `density` param is used (back-compat).
 * Unit assumption: density is in g/(document-unit)³ so that mass = volume × density in grams.
 */
export const massProperties = defineCommand({
  name: 'mass_properties',
  annotations: { readOnly: true },
  description:
    'Compute the mass of a 3D solid from its volume and density. ' +
    "Supported entity kinds: 'box', 'cylinder', 'sphere', 'extrusion', 'mesh', " +
    "'cone', 'torus', 'wedge', 'pyramid', 'revolution'. " +
    'Density resolution: if the entity has a material assigned (via assign_material) and that ' +
    "material exists in doc.materials, the material's density is used automatically — the density " +
    'param is ignored for that entity. Otherwise the caller-supplied density param is used (back-compat). ' +
    'The density is in g/(document-unit)³ — e.g. for a document in mm: steel ≈ 0.00785, aluminium ≈ 0.0027. ' +
    'Returns data: { volume, density, mass, unit } where unit describes the mass unit (grams). ' +
    'Does not modify the document.',
  params: z.object({
    entityId: z
      .string()
      .describe(
        "Id of the 3D solid entity to compute mass for. Supported kinds: 'box', 'cylinder', 'sphere', " +
          "'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution'.",
      ),
    density: z
      .number()
      .describe(
        'Fallback material density in g/(document-unit)³. Must be > 0. ' +
          'Used only when the entity has no material assigned via assign_material. ' +
          'Examples for a mm document: steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124.',
      ),
  }),
  run: (doc, { entityId, density }): CommandResult => {
    if (density <= 0) {
      return noop(doc, `mass_properties: density must be > 0, got ${String(density)}.`);
    }

    const e = doc.entities[entityId];
    if (!e) {
      return noop(doc, `mass_properties: entity '${entityId}' not found.`);
    }

    let effectiveDensity = density;
    let densitySource = 'param';
    if (e.materialId) {
      const mat = doc.materials[e.materialId];
      if (mat) {
        effectiveDensity = mat.density;
        densitySource = `material '${e.materialId}'`;
      }
    }

    const volumeResult = measureVolume.run(doc, { entityId });
    if (!volumeResult.data) {
      return noop(doc, volumeResult.summary);
    }

    const { volume } = volumeResult.data as MeasureVolumeData;
    const mass = volume * effectiveDensity;
    const data: MassPropertiesData = { volume, density: effectiveDensity, mass, unit: 'g' };
    return {
      document: doc,
      summary:
        `Mass of ${entityId}: volume=${volume.toFixed(doc.displayPrecision)} ${doc.units}³, ` +
        `density=${effectiveDensity} g/${doc.units}³ (${densitySource}), mass=${mass.toFixed(doc.displayPrecision)} g.`,
      affected: [],
      data,
    };
  },
});
