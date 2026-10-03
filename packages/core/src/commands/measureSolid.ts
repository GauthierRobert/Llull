import type { Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { entityBounds, mergeBounds } from './sceneBounds';
import type { Bounds } from './sceneTypes';
import { formatLength } from './units';
import { polygonArea } from './measureAreaPerimeter';
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

/**
 * Signed-tetrahedra sum over an INDEXED triangle mesh — gives the solid volume.
 * Each triangle (A, B, C) contributes A · (B × C) to the scalar triple-product sum.
 * Summing over all `indices.length / 3` triangles and taking |sum| / 6 gives the volume.
 * Result is valid only for a closed, consistently-wound mesh (Manifold output satisfies this).
 *
 * `positions` is a deduplicated vertex buffer (flat [x0,y0,z0, x1,y1,z1, …]).
 * `indices` is the flat triangle index list ([i0,i1,i2, …], one triplet per triangle).
 *
 * Reference: "Efficient feature extraction for 2D/3D objects in mesh representation",
 * Cha Zhang & Tsuhan Chen, ICIP 2001.
 */
function meshVolume(positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number {
  let sum = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t]! * 3,
      ib = indices[t + 1]! * 3,
      ic = indices[t + 2]! * 3;
    const ax = positions[ia]!,
      ay = positions[ia + 1]!,
      az = positions[ia + 2]!;
    const bx = positions[ib]!,
      by = positions[ib + 1]!,
      bz = positions[ib + 2]!;
    const cx = positions[ic]!,
      cy = positions[ic + 1]!,
      cz = positions[ic + 2]!;
    // Scalar triple product A · (B × C)
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
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
        // V = π r² h / 3
        volume = (Math.PI * e.radius * e.radius * e.height) / 3;
        break;
      case 'torus':
        // V = 2 π² · ringRadius · tubeRadius²
        volume = 2 * Math.PI * Math.PI * e.ringRadius * e.tubeRadius * e.tubeRadius;
        break;
      case 'wedge':
        // Right-triangular prism: half the enclosing box volume
        volume = (e.size[0] * e.size[1] * e.size[2]) / 2;
        break;
      case 'pyramid':
        // V = baseWidth × baseDepth × height / 3
        volume = (e.baseWidth * e.baseDepth * e.height) / 3;
        break;
      case 'revolution': {
        // Pappus's centroid theorem (second kind):
        //   V = sweepAngle × |x_centroid| × A_profile
        //
        // Convention from types.ts / revolve_profile: profile points are
        // [radialOffset, axialOffset] where x (radialOffset) is the perpendicular
        // distance from the revolution axis.  The axis vector stored in e.axis
        // selects which world axes map to radial/axial, but for the volume
        // formula only the profile-plane centroid matters — x_centroid IS the
        // centroid's distance from the revolution axis.
        //
        // Guard: Pappus requires the profile NOT to cross the revolution axis
        // (x < 0 would mean points on the other side of the axis).  When any
        // profile x is negative we fall back to a bounding-box approximation
        // and include a caveat in the summary.
        const prof = e.profile;
        const profN = prof.length;
        let profileArea = 0;
        let cx = 0;
        for (let pi = 0; pi < profN; pi++) {
          const [xi, yi] = prof[pi]!;
          const [xj, yj] = prof[(pi + 1) % profN]!;
          const cross = xi * yj - xj * yi;
          profileArea += cross;
          cx += (xi + xj) * cross;
        }
        profileArea = Math.abs(profileArea) / 2;
        // Check for axis-crossing (any point with negative radial offset).
        const crossesAxis = prof.some(([x]) => x < 0);
        if (crossesAxis) {
          // Fallback: bounding-box approximation (same as pre-fix behaviour).
          const b = entityBounds(e);
          volume = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
          const data: MeasureVolumeData = { volume, unit: volumeUnit };
          return {
            document: doc,
            summary:
              `Volume of ${entityId} ≈ ${volume.toFixed(doc.displayPrecision)} ${volumeUnit} ` +
              `(bounding-box approximation — profile crosses revolution axis; Pappus requires profile x ≥ 0).`,
            affected: [],
            data,
          };
        }
        if (profileArea < 1e-12) {
          volume = 0;
          break;
        }
        const sweepAngle = e.angle ?? 2 * Math.PI;
        // centroid x = (1/(6·A)) · Σ (xi+xj)(xi·yj − xj·yi)  — but we need |x_c|
        const xCentroid = Math.abs(cx / (6 * profileArea));
        // V = sweepAngle · x_centroid · A_profile
        volume = sweepAngle * xCentroid * profileArea;
        break;
      }
      default:
        return {
          document: doc,
          summary:
            `measure_volume: entity '${entityId}' is kind '${e.kind}'; ` +
            "supported kinds are 'box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution'.",
          affected: [],
        };
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
    "'cone', 'torus', 'wedge', 'pyramid'. " +
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
          "'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid'.",
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
    // Validate the fallback density param even if it may not be used — caller must
    // supply a valid number so the API stays consistent.
    if (density <= 0) {
      return noop(doc, `mass_properties: density must be > 0, got ${String(density)}.`);
    }

    const e = doc.entities[entityId];
    if (!e) {
      return noop(doc, `mass_properties: entity '${entityId}' not found.`);
    }

    // Resolve the effective density: prefer assigned material over the param.
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
      // measureVolume returned a no-op — propagate its summary.
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
