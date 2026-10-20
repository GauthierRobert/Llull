/** Zod params shared by cfd_create_case / cfd_update_case and the normalisation of parsed params into a `CfdCase` (no `undefined` members). */

import { vec3, z } from '@core/commands/schema';
import type { Vec3 } from '@core/model/types';
import type { CfdBoundaryTag, CfdCase, CfdFreestream, CfdSlice } from '@core/model/cfd';

const entityIds = z
  .array(z.string())
  .describe('Ids of the 3D solids / instances that form the body in the flow (unioned into one surface).');

const freestream = z
  .object({
    mach: z.number().optional().describe('Free-stream Mach number (> 0). Give exactly one of mach / speedMS.'),
    speedMS: z.number().optional().describe('Free-stream speed in m/s (> 0). Give exactly one of mach / speedMS.'),
    altitudeM: z
      .number()
      .optional()
      .describe('Geometric altitude in m for the U.S. Standard Atmosphere 1976 (-5000..86000). Default 0 (sea level). Not with `air`.'),
    air: z
      .object({
        densityKgM3: z.number().describe('Air density in kg/m³ (> 0).'),
        temperatureK: z.number().describe('Air temperature in K (> 0).'),
        viscosityPaS: z.number().describe('Dynamic viscosity in Pa·s (> 0).'),
      })
      .optional()
      .describe('Explicit air state instead of the standard atmosphere (not together with altitudeM).'),
    alphaDeg: z.number().optional().describe('Angle of attack in degrees, rotation about the lateral axis, within (-90, 90). Default 0.'),
    betaDeg: z.number().optional().describe('Sideslip angle in degrees within (-90, 90). Default 0.'),
  })
  .describe('Free stream: speed or Mach, air state, angles. The whole object replaces the previous free stream on update.');

const reference = z
  .object({
    areaM2: z.number().describe('Reference area in m² (> 0) of the force coefficients, e.g. frontal area or wing planform.'),
    lengthM: z.number().describe('Reference length in m (> 0): sets the grid (cells per reference length), e.g. chord or body length.'),
    momentPointM: vec3('Moment reference point [x, y, z] in metres, world axes. Default: centre of the bodies bounding box.').optional(),
  })
  .describe('Reference quantities of the force coefficients: area, length (sets the grid) and moment point.');

const domain = z.object({
  rule: z
    .enum(['external_aero', 'buildings', 'custom'])
    .describe(
      'Domain sizing rule: external_aero (aircraft, cars: llull named defaults), buildings (COST 732 / AIJ: 5H upstream, sides and above, 15H downstream, blockage <= 3 %), custom (use `box`).',
    ),
  box: z
    .object({ min: vec3('Lower corner in metres, case frame (x flow, z up).'), max: vec3('Upper corner in metres, case frame.') })
    .optional()
    .describe('Domain box for rule custom only; it must contain the bodies.'),
  symmetryPlane: z
    .enum(['xz'])
    .nullable()
    .optional()
    .describe(
      '"xz": the case is mirror-symmetric about the y = 0 plane of the case frame; only one half is simulated. null / absent: no symmetry.',
    ),
});

const ground = z.object({
  enabled: z.boolean().describe('A no-slip ground plane at the lowest point of the bodies (buildings, cars).'),
  moving: z.boolean().optional().describe('Ground moves at the free-stream speed (cars). Default false.'),
});

const outputs = z.object({
  surfaceFields: z
    .array(z.string())
    .optional()
    .describe('Surface fields to keep, e.g. ["cp", "mach"]. Default none listed (solver defaults).'),
  slices: z
    .array(
      z.object({
        origin: vec3('A point on the plane, metres.'),
        normal: vec3('Plane normal (not zero).'),
        field: z.string().describe('Field name.'),
      }),
    )
    .optional()
    .describe('Plane slices to sample.'),
  probes: z.array(vec3('A probe point [x, y, z] in metres.')).optional().describe('Points where the solver reports values.'),
});

const boundary = z.object({
  kind: z.enum(['wall', 'inlet', 'outlet', 'symmetry', 'ground']).describe('Boundary condition kind.'),
  entityId: z.string().describe('Entity carrying the condition (a body of the case).'),
  faceRefs: z.array(z.string()).optional().describe('Stable face refs when only some faces carry it; absent = the whole entity.'),
});

/** The case fields of an update (every one optional) and of a create (the same, with the three required ones overridden there). */
export const caseFieldShape = {
  entityIds: entityIds.optional(),
  excludedEntityIds: z.array(z.string()).optional().describe('Ids left out of the flow body (e.g. a rider, a mast); default none.'),
  regime: z
    .enum(['auto', 'low_speed', 'compressible'])
    .optional()
    .describe(
      'auto (default): chosen from the Mach number. low_speed needs Mach < 0.3 (lattice Boltzmann); compressible needs 0.3 <= Mach <= 5 (Euler).',
    ),
  freestream: freestream.optional(),
  flowAxis: vec3('Body axis aligned with the free stream at alpha = beta = 0, world axes. Default [1, 0, 0].').optional(),
  upAxis: vec3('Up direction, world axes (not parallel to flowAxis). Default [0, 0, 1].').optional(),
  reference: reference.partial().optional().describe('Reference area / length / moment point; on update only the given members change.'),
  domain: domain.partial().optional().describe('Flow domain; on update only the given members change.'),
  ground: ground.partial().optional().describe('Ground plane; on update only the given members change.'),
  quality: z
    .enum(['draft', 'standard', 'fine'])
    .optional()
    .describe('Grid quality: 64 / 128 / 256 cells per reference length. Default standard.'),
  cellsPerReferenceLength: z.number().int().optional().describe('Cells per reference length (8..2048); overrides quality.'),
  solver: z
    .enum(['lbm', 'euler'])
    .optional()
    .describe('Force a solver; refused outside its Mach range (lbm < 0.3, euler 0.3..5). Default: chosen from the Mach number.'),
  outputs: outputs.partial().optional().describe('Requested outputs; on update only the given members change.'),
};

/** Create-only required members. */
export const createRequiredShape = { entityIds, freestream, reference };

export const boundariesShape = z
  .array(boundary)
  .optional()
  .describe('Replace the whole boundary tag list (use [] to clear). One kind per entity / face.');

export interface DefaultNote {
  readonly path: string;
  readonly value: unknown;
  readonly source: string;
}

type FreestreamInput = z.infer<typeof freestream>;

export const toFreestream = (input: FreestreamInput): CfdFreestream => ({
  ...(input.mach !== undefined && { mach: input.mach }),
  ...(input.speedMS !== undefined && { speedMS: input.speedMS }),
  ...(input.altitudeM !== undefined && { altitudeM: input.altitudeM }),
  ...(input.air !== undefined && { air: { ...input.air } }),
  alphaDeg: input.alphaDeg ?? 0,
  betaDeg: input.betaDeg ?? 0,
});

const toBoundary = (tag: z.infer<typeof boundary>): CfdBoundaryTag => ({
  kind: tag.kind,
  entityId: tag.entityId,
  ...(tag.faceRefs !== undefined && { faceRefs: [...tag.faceRefs] }),
});

const toSlice = (slice: { origin: Vec3; normal: Vec3; field: string }): CfdSlice => ({
  origin: [...slice.origin],
  normal: [...slice.normal],
  field: slice.field,
});

export type CaseFields = { [K in keyof typeof caseFieldShape]?: z.infer<(typeof caseFieldShape)[K]> } & {
  boundaries?: z.infer<typeof boundariesShape>;
};

function mergeDomain(base: CfdCase['domain'], patch: CaseFields['domain']): CfdCase['domain'] {
  if (patch === undefined) return base;
  const rule = patch.rule ?? base.rule;
  const box =
    patch.box !== undefined
      ? { min: [...patch.box.min] as Vec3, max: [...patch.box.max] as Vec3 }
      : rule === 'custom'
        ? base.box
        : undefined;
  const symmetryPlane = patch.symmetryPlane !== undefined ? patch.symmetryPlane : base.symmetryPlane;
  return { rule, ...(box !== undefined && { box }), ...(symmetryPlane !== undefined && { symmetryPlane }) };
}

/**
 * The next case: `base` with the given `fields` applied (members present replace, nested objects merge one level).
 * @invariant no input is mutated; a custom box is dropped when the rule changes away from custom without a new box
 */
export function applyFields(base: CfdCase, fields: CaseFields): CfdCase {
  return {
    ...base,
    ...(fields.entityIds !== undefined && { entityIds: [...fields.entityIds] }),
    ...(fields.excludedEntityIds !== undefined && { excludedEntityIds: [...fields.excludedEntityIds] }),
    ...(fields.regime !== undefined && { regime: fields.regime }),
    ...(fields.freestream !== undefined && { freestream: toFreestream(fields.freestream) }),
    ...(fields.flowAxis !== undefined && { flowAxis: [...fields.flowAxis] as Vec3 }),
    ...(fields.upAxis !== undefined && { upAxis: [...fields.upAxis] as Vec3 }),
    reference: {
      areaM2: fields.reference?.areaM2 ?? base.reference.areaM2,
      lengthM: fields.reference?.lengthM ?? base.reference.lengthM,
      momentPointM: fields.reference?.momentPointM ?? base.reference.momentPointM,
    },
    domain: mergeDomain(base.domain, fields.domain),
    ground: { enabled: fields.ground?.enabled ?? base.ground.enabled, moving: fields.ground?.moving ?? base.ground.moving },
    ...(fields.quality !== undefined && { quality: fields.quality }),
    ...(fields.cellsPerReferenceLength !== undefined && { cellsPerReferenceLength: fields.cellsPerReferenceLength }),
    ...(fields.solver !== undefined && { solver: fields.solver }),
    outputs: {
      surfaceFields: fields.outputs?.surfaceFields !== undefined ? [...fields.outputs.surfaceFields] : base.outputs.surfaceFields,
      slices: fields.outputs?.slices !== undefined ? fields.outputs.slices.map(toSlice) : base.outputs.slices,
      probes: fields.outputs?.probes !== undefined ? fields.outputs.probes.map((p) => [...p] as Vec3) : base.outputs.probes,
    },
    boundaries: fields.boundaries !== undefined ? fields.boundaries.map(toBoundary) : base.boundaries,
  };
}
