/** Shared parameter schemas, result types and refusal codes of the plant equipment plugin (plant 03 EQP). */

import { z } from '@core/commands/schema';
import { tableRejection } from '@core/commands/noop';

/** A table row is trusted without a flag only at grade A (two independent sources agree); lower grades report `unverified` (AF-32). */
export type SourceGrade = 'A' | 'B' | 'C';

export const TORISPHERICAL_STANDARDS = ['asme_fd', 'asme_80_10', 'asme_80_6', 'din_28011', 'din_28013'] as const;
export type TorisphericalStandard = (typeof TORISPHERICAL_STANDARDS)[number];

export const headSpecSchema = z
  .object({
    type: z
      .enum(['ellipsoidal', 'torispherical', 'hemispherical', 'flat', 'conical'])
      .describe(
        'Head type. ellipsoidal: needs ratio (2 = 2:1 semi-ellipsoidal, depth = D/4). torispherical: needs standard OR crownRadius + knuckleRadius. ' +
          'hemispherical: depth = D/2. flat: depth 0. conical: needs halfAngleDeg (apex half-angle from the axis, 0..90 exclusive).',
      ),
    ratio: z.number().positive().optional().describe('ellipsoidal only: inside diameter / (2 x inside depth). 2 = standard 2:1 head.'),
    standard: z
      .enum(TORISPHERICAL_STANDARDS)
      .optional()
      .describe(
        'torispherical only: asme_fd (crown = D, knuckle 6 % D), asme_80_10, asme_80_6, din_28011 (Kloepper), din_28013 (Korbbogen). ' +
          'The proportions are applied to the inside diameter you give. Rows below grade A make the result report unverified.',
      ),
    crownRadius: z
      .number()
      .positive()
      .optional()
      .describe('torispherical only: crown (dish) radius in document units, with knuckleRadius.'),
    knuckleRadius: z.number().positive().optional().describe('torispherical only: knuckle radius in document units, with crownRadius.'),
    halfAngleDeg: z
      .number()
      .positive()
      .lt(90)
      .optional()
      .describe('conical only: half apex angle between the axis and the cone surface, degrees.'),
    thickness: z.number().positive().optional().describe('flat only: plate thickness in document units (not used by volumes).'),
  })
  .describe('One formed head of a vessel. Only the fields of the chosen type are read.');

export type HeadSpec = z.infer<typeof headSpecSchema>;

const REMEDIATION: Readonly<Record<string, string>> = {
  EQP_PARAM_INVALID: 'Fix the value at the given path (lengths > 0, finite).',
  EQP_HEAD_INVALID: 'Use a named standard or valid radii: ratio > 0, knuckle < 0.5 D, crown >= 0.5 D and > knuckle, half angle in (0, 90).',
  EQP_HEAD_NOT_COVERED:
    'This head type has no closed-form partial volume yet (horizontal torispherical, V1): give a level at 0 or the full diameter.',
  EQP_LEVEL_OUT_OF_RANGE: 'Give levels inside 0..totalHeight, measured from the lowest inside point (head apex or shell bottom).',
  EQP_NOT_FOUND: 'List the tags with equipment_ports or building_schedule kind equipment, and pass a tag (e.g. "V-101") or an element id.',
  EQP_TAG_DUPLICATE: 'Choose another tag; equipment tags are unique in the document.',
  EQP_NOT_PARAMETRIC:
    'Recreate it with add_vessel, or keep it as a block and add nozzles with location { on: "free", position, direction }.',
  EQP_SUPPORT_INVALID:
    'Skirt / legs belong to vertical vessels, saddles to horizontal ones; legs >= 3; saddle stations inside 0..tangentLength.',
  EQP_TRAYS_DONT_FIT: 'Reduce trays.count or trays.spacing so that the last tray is at most tangentLength above the bottom tangent line.',
  EQP_NOZZLE_MARK_DUPLICATE: 'Choose another mark; marks are unique per equipment.',
  EQP_NOZZLE_NOT_FOUND: 'List the marks with equipment_ports.',
  EQP_NOZZLE_OFF_BODY: 'Keep 0 <= elevation (or station) <= tangentLength and radialOffset < inside radius.',
  EQP_NOZZLE_PROJECTION_TOO_SHORT: 'Increase projection: shell nozzles measure from the vessel axis, head nozzles from the tangent line.',
  EQP_RATING_UNKNOWN: 'Use a rating such as CL150, CL300, CL600 or PN16, and a DN of the nominal-size table (15..600).',
  EQP_PORT_CONNECTED: 'Re-route the connected pipe first, or pass force: true.',
};

export const refuse = tableRejection(REMEDIATION);
