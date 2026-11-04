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
  EQP_TAG_DUPLICATE: 'Choose another tag; equipment tags are unique in the document, trays / supports / members within their category.',
  EQP_ELEMENT_READONLY: 'Edit the assembly that generated it (update_access_platform, update_pipe_rack).',
  EQP_NOT_PARAMETRIC:
    'Recreate it with add_vessel, or keep it as a block and add nozzles with location { on: "free", position, direction }.',
  EQP_SUPPORT_INVALID:
    'Skirt / legs belong to vertical vessels, saddles to horizontal ones; legs >= 3; saddle stations inside 0..tangentLength.',
  EQP_TEMA_INVALID:
    'Use three TEMA letters: front head A, B, C or N; shell E, F, G, H or J; rear head L, M, N, P, S, T, U or W, e.g. BEM, AES, AEU.',
  EQP_TEMA_UNSUPPORTED:
    'Use a front A, B, C or N with an E, F, G, H or J shell (front D and shells K, X are not modelled), or model the item with add_vessel.',
  EQP_PUMP_SIZE_UNKNOWN:
    'Give envelope { a, f, h1, h2, suctionDn, dischargeDn } from the vendor datasheet, or a size of the shipped tables (ISO 2858: 50-32-160, 50-32-200, 65-40-250, 80-50-200; B73.1: AA, AB, A05, A60).',
  EQP_TRAYS_DONT_FIT: 'Reduce trays.count or trays.spacing so that the last tray is at most tangentLength above the bottom tangent line.',
  EQP_NOZZLE_MARK_DUPLICATE: 'Choose another mark; marks are unique per equipment.',
  EQP_NOZZLE_NOT_FOUND: 'List the marks with equipment_ports.',
  EQP_NOZZLE_OFF_BODY: 'Keep 0 <= elevation (or station) <= tangentLength and radialOffset < inside radius.',
  EQP_NOZZLE_PROJECTION_TOO_SHORT: 'Increase projection: shell nozzles measure from the vessel axis, head nozzles from the tangent line.',
  EQP_RATING_UNKNOWN: 'Use a rating such as CL150, CL300, CL600 or PN16, and a DN of the nominal-size table (15..600).',
  EQP_PORT_CONNECTED: 'Re-route the connected pipe first, or pass force: true.',
  EQP_ALLOWABLE_MISSING:
    'Set design.allowableStress (value, unit, source) and design.jointEfficiency with update_equipment_parameters; llull never defaults S or E.',
  EQP_FORMULA_OUT_OF_RANGE:
    'The thin-wall rules need P <= 0.385 S E and t <= R/2; thick-wall design (Appendix 1-2) is out of scope and needs an engineer.',
  EQP_API650_ONE_FOOT_LIMIT: 'The one-foot method covers D <= 60 m; the variable-design-point method is not built.',
  EQP_MATERIAL_NOT_IN_TABLE: 'Use A283M Gr C, A36M or A516M Gr 485 (A516-70), or give allowableStress { design, test, source } in MPa.',
  EQP_COURSES_MISMATCH: 'Make the course heights add up to shellHeight.',
  EQP_DESIGN_DATA_MISSING: 'Add the missing design data (see paths) with update_equipment_parameters set.design.',
  EQP_SHELL_UNDER_THICKNESS: 'Increase shellThickness or lower the design pressure (update_equipment_parameters).',
  EQP_HEAD_UNDER_THICKNESS: 'Increase headThickness (update_equipment_parameters).',
  EQP_MAWP_BELOW_DESIGN: 'Increase the governing thickness so that the MAWP reaches the design pressure, or lower the design pressure.',
  EQP_NOZZLE_OVERLAP: 'Move one of the two nozzles (update_nozzle) so that their reinforcement zones do not intersect.',
  EQP_NOZZLE_REINFORCEMENT_INSUFFICIENT:
    'Thicken the shell or the neck, or add a reinforcing pad (not modelled here): the UG-37 area replacement fails; have an engineer review the pad.',
  EQP_NOZZLE_IN_KNUCKLE: 'Move the head nozzle toward the head centre (update_nozzle radialOffset).',
  EQP_NOZZLE_IN_SUPPORT: 'Move the nozzle clear of the saddle / skirt (update_nozzle), or provide an opening in the support.',
  EQP_TABLE_UNVERIFIED: 'Confirm the value from the licensed standard or a vendor; it comes from a table row below grade A.',
  EQP_VALUE_UNSOURCED: 'Add the source (standard, datasheet) of the value with update_equipment_parameters.',
  EQP_FLANGE_PLACEHOLDER: 'Assign a pipe class / catalogue flange: the catalogue has no row for this DN, rating and facing.',
};

export const refuse = tableRejection(REMEDIATION);

/** One-line remediation of a stable code (a generic pointer for an unknown code). */
export const remediationOf = (code: string): string => REMEDIATION[code] ?? 'see the command description';
