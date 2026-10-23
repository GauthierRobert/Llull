/**
 * Parameter schemas of vessel commands (`add_vessel`, `add_process_column`, `update_equipment_parameters`) and the one builder that turns their input
 * into a validated `VesselTemplate`. Every refusal is a coded issue with a param path; every default is named in `defaulted`.
 */

import { z } from '@core/commands/schema';
import { headSpecSchema, type HeadSpec } from '../model';
import { resolveVessel } from '../geometry/vesselFrame';
import type { SupportSpec, VesselDesignData, VesselTemplate } from '../plantData';

export interface VesselIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const issue = (code: string, message: string, path: string): VesselIssue => ({ code, message, path });
export const isVesselIssue = (value: object): value is VesselIssue => 'code' in value && 'path' in value;

export const supportInputSchema = z
  .object({
    type: z
      .enum(['skirt', 'legs', 'saddles', 'none'])
      .describe(
        'skirt (vertical): needs height. legs (vertical): needs count >= 3 and height. saddles (horizontal): needs stations, width and axisElevation. ' +
          'none: needs nothing (baseElevation optional).',
      ),
    height: z
      .number()
      .positive()
      .optional()
      .describe('skirt / legs: height from the level (floor) to the bottom tangent line, document units.'),
    thickness: z.number().positive().optional().describe('skirt: wall thickness. Default: the shell thickness (reported in defaulted).'),
    baseRingWidth: z.number().min(0).optional().describe('skirt: width of the base ring outside the skirt. Default 0 (no ring).'),
    count: z.number().int().optional().describe('legs: number of legs, at least 3, spread evenly (none on the north axis).'),
    pitchDiameter: z
      .number()
      .positive()
      .optional()
      .describe('legs: diameter of the circle through the leg centres. Default: the shell outside diameter.'),
    legWidth: z
      .number()
      .positive()
      .optional()
      .describe('legs: side of the square leg section. Default: 5 % of the shell outside diameter.'),
    stations: z
      .array(z.number())
      .min(1)
      .max(8)
      .optional()
      .describe('saddles: positions along the vessel from the left tangent line, each inside 0..tangentLength.'),
    width: z.number().positive().optional().describe('saddles: width of each saddle along the vessel axis.'),
    axisElevation: z
      .number()
      .positive()
      .optional()
      .describe('saddles: height of the vessel axis above the level; must exceed the shell outside radius.'),
    baseElevation: z
      .number()
      .min(0)
      .optional()
      .describe('none: elevation of the lowest shell point (horizontal) or bottom tangent line (vertical) above the level. Default 0.'),
  })
  .describe('Support of the vessel; only the fields of the chosen type are read.');

export type SupportInput = z.infer<typeof supportInputSchema>;

const stressSchema = z.object({
  value: z.number().positive().describe('Allowable stress.'),
  unit: z.enum(['MPa', 'psi']).describe('Stress unit.'),
  source: z
    .string()
    .optional()
    .describe('Where the value comes from (code table, datasheet): unsourced safety values are flagged by checks.'),
});

export const designInputSchema = z
  .object({
    pressure: z
      .object({
        value: z.number().positive().describe('Pressure, gauge.'),
        unit: z.enum(['MPa', 'kPa', 'bar', 'psi']).describe('Pressure unit.'),
        source: z.string().optional().describe('Where the value comes from (design basis, datasheet).'),
      })
      .optional()
      .describe('Internal design pressure, gauge.'),
    temperatureC: z.number().optional().describe('Design temperature, degrees C.'),
    material: z.string().optional().describe('Material designation, e.g. "SA-516 Gr 70".'),
    allowableStress: stressSchema
      .optional()
      .describe('Allowable stress S at the design temperature. Never defaulted: give it with its source.'),
    allowableStressAtTest: stressSchema.optional().describe('Allowable stress at the test temperature (hydrotest).'),
    jointEfficiency: z
      .object({
        shell: z.number().gt(0).max(1).describe('Joint efficiency E of the shell.'),
        heads: z.number().gt(0).max(1).describe('Joint efficiency E of the heads.'),
      })
      .optional()
      .describe('Weld joint efficiency E of the shell and of the heads, 0 < E <= 1.'),
    materialDensityKgM3: z.number().positive().optional().describe('Metal density, kg/m3. Default 7850 (steel), reported in the notes.'),
    operatingLiquid: z
      .object({
        specificGravity: z.number().positive().describe('Specific gravity of the operating liquid (water = 1).'),
        levelAboveBottomTangent: z
          .number()
          .min(0)
          .describe(
            'Operating liquid level above the bottom tangent line (vertical) or above the shell bottom (horizontal), document units.',
          ),
      })
      .optional()
      .describe('Operating liquid, added to the operating weight and reported by vessel_volume.'),
  })
  .describe('Design data of the vessel (pressure, temperature, material, allowables, efficiencies, operating liquid).');

export type DesignInput = z.infer<typeof designInputSchema>;

export const headsInputSchema = z
  .object({
    top: headSpecSchema.optional().describe('Vertical vessel: top head.'),
    bottom: headSpecSchema.optional().describe('Vertical vessel: bottom head.'),
    left: headSpecSchema.optional().describe('Horizontal vessel: left head (at the start of the axis, -X of the equipment frame).'),
    right: headSpecSchema.optional().describe('Horizontal vessel: right head (+X).'),
  })
  .describe('Formed heads: top + bottom for a vertical vessel, left + right for a horizontal one.');

export type HeadsInput = z.infer<typeof headsInputSchema>;

export interface VesselInput {
  readonly orientation: 'vertical' | 'horizontal';
  readonly insideDiameter: number;
  readonly tangentLength: number;
  readonly heads: HeadsInput;
  readonly shellThickness: number;
  readonly headThickness?: number | undefined;
  readonly corrosionAllowance?: number | undefined;
  readonly support: SupportInput;
}

const HEAD_NAMES = { vertical: ['bottom', 'top'], horizontal: ['left', 'right'] } as const;

/** Heads of the input in (first, second) order, or the issue (missing head, head of the other orientation). */
function pickHeads(input: VesselInput): { first: HeadSpec; second: HeadSpec } | VesselIssue {
  const [firstName, secondName] = HEAD_NAMES[input.orientation];
  const other = input.orientation === 'vertical' ? ['left', 'right'] : ['top', 'bottom'];
  for (const name of other) {
    if (input.heads[name as keyof HeadsInput] !== undefined)
      return issue(
        'EQP_PARAM_INVALID',
        `a ${input.orientation} vessel has ${firstName} and ${secondName} heads, not ${name}`,
        `heads.${name}`,
      );
  }
  const first = input.heads[firstName];
  const second = input.heads[secondName];
  if (first === undefined)
    return issue('EQP_PARAM_INVALID', `heads.${firstName} is required for a ${input.orientation} vessel`, `heads.${firstName}`);
  if (second === undefined)
    return issue('EQP_PARAM_INVALID', `heads.${secondName} is required for a ${input.orientation} vessel`, `heads.${secondName}`);
  return { first, second };
}

function resolveSupport(input: SupportInput, vessel: VesselInput, defaulted: string[]): SupportSpec | VesselIssue {
  const outer = vessel.insideDiameter / 2 + vessel.shellThickness;
  const need = (name: string, value: unknown): VesselIssue | null =>
    value === undefined ? issue('EQP_SUPPORT_INVALID', `support.${name} is required for a ${input.type} support`, `support.${name}`) : null;
  const wrongOrientation = (suits: 'vertical' | 'horizontal'): VesselIssue | null =>
    vessel.orientation === suits
      ? null
      : issue('EQP_SUPPORT_INVALID', `${input.type} supports a ${suits} vessel, this one is ${vessel.orientation}`, 'support.type');
  switch (input.type) {
    case 'skirt': {
      const failure = wrongOrientation('vertical') ?? need('height', input.height);
      if (failure !== null) return failure;
      if (input.thickness === undefined) defaulted.push('support.thickness');
      if (input.baseRingWidth === undefined) defaulted.push('support.baseRingWidth');
      return {
        type: 'skirt',
        height: input.height as number,
        thickness: input.thickness ?? vessel.shellThickness,
        baseRingWidth: input.baseRingWidth ?? 0,
      };
    }
    case 'legs': {
      const failure = wrongOrientation('vertical') ?? need('height', input.height) ?? need('count', input.count);
      if (failure !== null) return failure;
      if ((input.count as number) < 3) return issue('EQP_SUPPORT_INVALID', `legs needs count >= 3 (got ${input.count})`, 'support.count');
      if (input.pitchDiameter === undefined) defaulted.push('support.pitchDiameter');
      if (input.legWidth === undefined) defaulted.push('support.legWidth');
      return {
        type: 'legs',
        count: input.count as number,
        height: input.height as number,
        pitchDiameter: input.pitchDiameter ?? 2 * outer,
        legWidth: input.legWidth ?? 0.1 * outer,
      };
    }
    case 'saddles': {
      const failure =
        wrongOrientation('horizontal') ??
        need('stations', input.stations) ??
        need('width', input.width) ??
        need('axisElevation', input.axisElevation);
      if (failure !== null) return failure;
      const stations = input.stations as number[];
      const outside = stations.findIndex((station) => !(station >= 0 && station <= vessel.tangentLength));
      if (outside >= 0)
        return issue(
          'EQP_SUPPORT_INVALID',
          `saddle station ${stations[outside]} is outside the tangent length 0..${vessel.tangentLength}`,
          `support.stations.${outside}`,
        );
      if ((input.axisElevation as number) <= outer)
        return issue(
          'EQP_SUPPORT_INVALID',
          `axisElevation ${input.axisElevation} must exceed the shell outside radius ${outer}`,
          'support.axisElevation',
        );
      return { type: 'saddles', stations: [...stations], width: input.width as number, axisElevation: input.axisElevation as number };
    }
    case 'none':
      if (input.baseElevation === undefined) defaulted.push('support.baseElevation');
      return { type: 'none', baseElevation: input.baseElevation ?? 0 };
  }
}

/**
 * Validated template of `input`, with the names of the defaults applied.
 * @failure non-positive thickness above the allowance -> EQP_PARAM_INVALID; missing / wrong head, invalid head -> EQP_PARAM_INVALID /
 *   EQP_HEAD_INVALID (path under heads.<name>); support not suiting the orientation or outside the body -> EQP_SUPPORT_INVALID
 */
export function buildVesselTemplate(input: VesselInput): { template: VesselTemplate; defaulted: string[] } | VesselIssue {
  const defaulted: string[] = [];
  const allowance = input.corrosionAllowance ?? 0;
  if (input.corrosionAllowance === undefined) defaulted.push('corrosionAllowance');
  const headThickness = input.headThickness ?? input.shellThickness;
  if (input.headThickness === undefined) defaulted.push('headThickness');
  if (allowance < 0) return issue('EQP_PARAM_INVALID', 'corrosionAllowance must be >= 0', 'corrosionAllowance');
  if (input.shellThickness <= allowance)
    return issue(
      'EQP_PARAM_INVALID',
      `shellThickness ${input.shellThickness} must exceed the corrosion allowance ${allowance}`,
      'shellThickness',
    );
  if (headThickness <= allowance)
    return issue('EQP_PARAM_INVALID', `headThickness ${headThickness} must exceed the corrosion allowance ${allowance}`, 'headThickness');
  const heads = pickHeads(input);
  if (isVesselIssue(heads)) return heads;
  const support = resolveSupport(input.support, input, defaulted);
  if (isVesselIssue(support)) return support;
  const template: VesselTemplate = {
    kind: 'vessel',
    orientation: input.orientation,
    insideDiameter: input.insideDiameter,
    tangentLength: input.tangentLength,
    heads,
    shellThickness: input.shellThickness,
    headThickness,
    corrosionAllowance: allowance,
    support,
  };
  const resolved = resolveVessel(template);
  if ('error' in resolved) {
    const [firstName, secondName] = HEAD_NAMES[input.orientation];
    const path = resolved.path.replace('heads.first', `heads.${firstName}`).replace('heads.second', `heads.${secondName}`);
    return issue('EQP_HEAD_INVALID', resolved.error, path);
  }
  return { template, defaulted };
}

/** The input that would rebuild `template` (stored supports are fully resolved, so they round-trip without defaults). */
export function vesselInputOf(template: VesselTemplate): VesselInput {
  const [firstName, secondName] = HEAD_NAMES[template.orientation];
  const support = template.support;
  return {
    orientation: template.orientation,
    insideDiameter: template.insideDiameter,
    tangentLength: template.tangentLength,
    heads: { [firstName]: template.heads.first, [secondName]: template.heads.second },
    shellThickness: template.shellThickness,
    headThickness: template.headThickness,
    corrosionAllowance: template.corrosionAllowance,
    support: support.type === 'saddles' ? { ...support, stations: [...support.stations] } : support,
  };
}

/** Design data stored from the input (zod output carries no undefined values). */
export const designOf = (input: DesignInput | undefined): VesselDesignData | undefined => (input === undefined ? undefined : { ...input });
