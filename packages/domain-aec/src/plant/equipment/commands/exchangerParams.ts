/**
 * Parameter schemas of `add_heat_exchanger` and the one builder that turns their input into a validated `ExchangerTemplate`. Every refusal is a
 * coded issue with a param path; every default is named in `defaulted`.
 */

import { z } from '@core/commands/schema';
import type { DocumentUnit } from '@core/model/types';
import { fromMm, MM_PER_UNIT } from '@core/model/units';
import { parseTema } from '../codecheck/tema';
import { tubeWallRow, TUBE_WALL_SOURCE } from '../data/temaTables';
import type { ExchangerChannel, ExchangerKettle, ExchangerSideDesign, ExchangerTemplate, TemaDesignation, TubeBundle } from '../plantData';
import { designInputSchema, isVesselIssue, resolveSupport, supportInputSchema, type VesselIssue } from './vesselParams';

export const channelSchema = z.object({
  length: z
    .number()
    .positive()
    .describe('Channel (cylinder) length from the tubesheet face to the cover / bonnet tangent line, document units.'),
  thickness: z
    .number()
    .positive()
    .optional()
    .describe(
      'Channel wall thickness, nominal, corrosion allowance included. Default: the shell thickness (a named default that check_equipment warns about). Required for front head D.',
    ),
  coverThickness: z
    .number()
    .positive()
    .optional()
    .describe(
      'Flat cover thickness (heads A, C, N, L, N and D; not for a bonnet B / M). Default: the channel thickness. Required for front head D, whose closure is thicker than the channel and has no tabulated dimensions here.',
    ),
});

export const sideSchema = designInputSchema
  .omit({ operatingLiquid: true, materialDensityKgM3: true })
  .extend({
    specificGravity: z
      .number()
      .positive()
      .optional()
      .describe(
        'Specific gravity of the fluid of this side, used for the operating weight (the side is taken as full). Omit: adds nothing.',
      ),
  })
  .describe(
    'Design data of one side: pressure, temperature, material, allowable stress S and joint efficiencies E (never defaulted), fluid specific gravity.',
  );

export const exchangerShape = {
  temaType: z
    .string()
    .min(1)
    .max(16)
    .describe(
      'TEMA designation, exactly three letters: front head A | B | C | D | N, shell E | F | G | H | J | K | X, rear head L | M | N (fixed tubesheet) or P | S | T | U | W ' +
        '(removable bundle), e.g. BEM, AES, AEU, DXU, AKU. D = high-pressure closure (needs frontChannel.thickness and coverThickness), K = kettle (needs kettle {...}, ' +
        'horizontal, removable-bundle rear only), X = cross flow (geometry of E; check_equipment wants two opposite shell nozzles). Unsupported combinations: EQP_EXCHANGER_UNSUPPORTED.',
    ),
  orientation: z
    .enum(['horizontal', 'vertical'])
    .optional()
    .describe(
      'horizontal (default): tube axis along the equipment X, support saddles or none. vertical: tube axis along Z, FRONT HEAD AT THE BOTTOM, support skirt, legs or none; ' +
        'support.height (skirt / legs) or support.baseElevation (none) is the elevation of the bottom tangent line, the outer end of the front channel. Not for the kettle (K).',
    ),
  kettle: z
    .object({
      enlargedInsideDiameter: z
        .number()
        .positive()
        .describe('Inside diameter of the enlarged cylinder over the bundle; must exceed shellInsideDiameter, document units.'),
      enlargedLength: z
        .number()
        .positive()
        .describe('Length of the enlarged cylinder, measured back from the rear end of the shell, document units.'),
      transitionLength: z
        .number()
        .positive()
        .describe(
          'Axial length of the cone from shellInsideDiameter to enlargedInsideDiameter, document units. The restricted cylinder keeps the rest of the shell, which must stay > 0.',
        ),
      enlargedThickness: z
        .number()
        .positive()
        .optional()
        .describe(
          'Wall of the cone and the enlarged cylinder (and of the rear shell cover). Default: shellThickness (a named default that check_equipment warns about).',
        ),
      weirHeight: z
        .number()
        .positive()
        .describe(
          'Overflow weir height above the lowest inside point of the enlarged shell, document units; must be below enlargedInsideDiameter. Internal: stored and shown on the data sheet, no geometry.',
        ),
    })
    .optional()
    .describe(
      'TEMA K (kettle) only, required for it: restricted cylinder at the tubesheet, cone, enlarged cylinder over the bundle, weir. All dimensions are caller inputs.',
    ),
  shellInsideDiameter: z
    .number()
    .positive()
    .describe('Shell inside diameter; the channels and bonnets have the same inside diameter, document units.'),
  shellThickness: z.number().positive().describe('Nominal shell wall thickness (corrosion allowance included), document units.'),
  corrosionAllowance: z
    .number()
    .min(0)
    .optional()
    .describe('Corrosion allowance of the pressure parts, document units. Default 0 (reported in defaulted).'),
  tubes: z
    .object({
      outsideDiameter: z.number().positive().describe('Tube outside diameter, document units.'),
      wallThickness: z.number().positive().optional().describe('Tube wall, document units. Give wallThickness OR bwg.'),
      bwg: z
        .number()
        .int()
        .optional()
        .describe(
          'Tube wall by Birmingham gauge (12, 14, 16, 18) for 3/4 in (19.05 mm) or 1 in (25.4 mm) tubes. Grade B table: the result is unverified.',
        ),
      count: z.number().int().positive().describe('Number of tubes (U-tube bundles: number of tubesheet holes).'),
      length: z
        .number()
        .positive()
        .describe(
          'Tube length between the OUTER faces of the tubesheets (U-tubes: the straight leg), document units. Shell length = length - tubesheets.',
        ),
      passes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Tube-side passes. Default 1 (reported in defaulted). Pass partitions are not modelled.'),
      pitch: z
        .number()
        .positive()
        .optional()
        .describe('Tube pitch, document units. Default 1.25 x the tube outside diameter (TEMA minimum, reported in defaulted).'),
      layoutAngleDeg: z
        .union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)])
        .optional()
        .describe('Tube layout angle: 30 or 60 triangular, 45 rotated square, 90 square. Default 30 (reported in defaulted).'),
    })
    .describe('The tube bundle.'),
  tubesheetThickness: z
    .number()
    .positive()
    .describe('Tubesheet thickness, document units (a floating-head rear has its floating sheet inside the shell, not modelled).'),
  frontChannel: channelSchema.describe(
    'Front (stationary) head: channel length and wall. Bonnet (B) = channel + 2:1 head; A, C, N = channel + flat cover.',
  ),
  rearChannel: channelSchema
    .optional()
    .describe(
      'Rear head for the fixed-tubesheet rears L, M, N only (default: the front channel, reported in defaulted). Other rears close the shell with a 2:1 shell cover.',
    ),
  support: supportInputSchema
    .optional()
    .describe(
      'Horizontal: saddles { stations from the front end of the shell, width, axisElevation } or none. Vertical: skirt { height, thickness?, baseRingWidth? }, legs { count >= 3, height, pitchDiameter?, legWidth? } or none { baseElevation }. Lugs are not modelled. Default none on the level.',
    ),
  design: z
    .object({
      shellSide: sideSchema.optional(),
      tubeSide: sideSchema.optional(),
      materialDensityKgM3: z.number().positive().optional().describe('Metal density, kg/m3. Default 7850 (steel), reported in the notes.'),
    })
    .optional()
    .describe('Design data of the shell side and the tube side.'),
};

const exchangerInput = z.object(exchangerShape);
export type ExchangerInput = z.infer<typeof exchangerInput>;

const issue = (code: string, message: string, path: string): VesselIssue => ({ code, message, path });

/** Layout cell area of a tube in pitch^2: triangular layouts pack 0.866 pitch^2 per tube, square ones 1. */
const cellFactor = (angle: number): number => (angle === 30 || angle === 60 ? Math.sqrt(3) / 2 : 1);

function tubeBundle(input: ExchangerInput['tubes'], units: DocumentUnit, defaulted: string[]): TubeBundle | VesselIssue {
  const { outsideDiameter } = input;
  if (input.wallThickness !== undefined && input.bwg !== undefined)
    return issue('EQP_PARAM_INVALID', 'give tubes.wallThickness OR tubes.bwg, not both', 'tubes.bwg');
  let wall = input.wallThickness;
  let wallSource = 'user input';
  let wallUnverified = false;
  if (input.bwg !== undefined) {
    const row = tubeWallRow(outsideDiameter * MM_PER_UNIT[units], input.bwg);
    if (row === undefined)
      return issue(
        'EQP_PARAM_INVALID',
        `no BWG ${input.bwg} wall in the shipped table for a tube of outside diameter ${outsideDiameter} (3/4 in and 1 in tubes, gauges 12, 14, 16, 18)`,
        'tubes.bwg',
      );
    wall = row.wallMm / MM_PER_UNIT[units];
    wallSource = `BWG ${row.bwg}: ${TUBE_WALL_SOURCE}`;
    wallUnverified = true;
  }
  if (wall === undefined) return issue('EQP_PARAM_INVALID', 'give tubes.wallThickness or tubes.bwg', 'tubes.wallThickness');
  if (wall * 2 >= outsideDiameter)
    return issue(
      'EQP_PARAM_INVALID',
      `tube wall ${wall} leaves no bore in a tube of outside diameter ${outsideDiameter}`,
      'tubes.wallThickness',
    );
  if (input.passes === undefined) defaulted.push('tubes.passes');
  if (input.pitch === undefined) defaulted.push('tubes.pitch');
  if (input.layoutAngleDeg === undefined) defaulted.push('tubes.layoutAngleDeg');
  const pitch = input.pitch ?? 1.25 * outsideDiameter;
  if (pitch <= outsideDiameter)
    return issue('EQP_PARAM_INVALID', `tubes.pitch ${pitch} must exceed the tube outside diameter ${outsideDiameter}`, 'tubes.pitch');
  return {
    outsideDiameter,
    wallThickness: wall,
    wallSource,
    wallUnverified,
    count: input.count,
    length: input.length,
    passes: input.passes ?? 1,
    pitch,
    layoutAngleDeg: input.layoutAngleDeg ?? 30,
  };
}

const sideOf = (side: z.infer<typeof sideSchema> | undefined): ExchangerSideDesign | undefined =>
  side === undefined ? undefined : { ...side };

const unsupportedIssue = (message: string, path: string): VesselIssue => issue('EQP_EXCHANGER_UNSUPPORTED', message, path);

/** The named refusal of a TEMA combination llull does not build, or null. */
function unsupportedCombination(input: ExchangerInput, tema: TemaDesignation, vertical: boolean): VesselIssue | null {
  if (tema.shell === 'K') {
    if (vertical)
      return unsupportedIssue('a kettle (TEMA K) is built horizontal only: orientation vertical is not modelled', 'orientation');
    if (tema.fixedTubesheet)
      return unsupportedIssue(
        `a kettle takes a removable-bundle rear (P, S, T, U, W), not ${tema.rear}: fixed tubesheets in the enlarged shell are not modelled`,
        'temaType.2',
      );
    if (input.kettle === undefined)
      return issue(
        'EQP_PARAM_INVALID',
        'a kettle shell (K) needs kettle { enlargedInsideDiameter, enlargedLength, transitionLength, weirHeight }',
        'kettle',
      );
  } else if (input.kettle !== undefined) return issue('EQP_PARAM_INVALID', `kettle is for the shell letter K, not ${tema.shell}`, 'kettle');
  if (tema.front === 'D') {
    for (const field of ['thickness', 'coverThickness'] as const)
      if (input.frontChannel[field] === undefined)
        return issue(
          'EQP_PARAM_INVALID',
          `front head D (high-pressure closure) needs frontChannel.${field}: no TEMA dimension is shipped, it is never defaulted`,
          `frontChannel.${field}`,
        );
  }
  return null;
}

function resolveKettle(input: ExchangerInput, allowance: number, defaulted: string[]): ExchangerKettle | VesselIssue {
  const kettle = input.kettle as NonNullable<ExchangerInput['kettle']>;
  if (kettle.enlargedInsideDiameter <= input.shellInsideDiameter)
    return issue(
      'EQP_PARAM_INVALID',
      `kettle.enlargedInsideDiameter ${kettle.enlargedInsideDiameter} must exceed shellInsideDiameter ${input.shellInsideDiameter}`,
      'kettle.enlargedInsideDiameter',
    );
  if (kettle.weirHeight >= kettle.enlargedInsideDiameter)
    return issue(
      'EQP_PARAM_INVALID',
      `kettle.weirHeight ${kettle.weirHeight} must be below enlargedInsideDiameter ${kettle.enlargedInsideDiameter}`,
      'kettle.weirHeight',
    );
  if (kettle.enlargedThickness === undefined) defaulted.push('kettle.enlargedThickness');
  const enlargedThickness = kettle.enlargedThickness ?? input.shellThickness;
  if (enlargedThickness <= allowance)
    return issue(
      'EQP_PARAM_INVALID',
      `kettle.enlargedThickness ${enlargedThickness} must exceed the corrosion allowance ${allowance}`,
      'kettle.enlargedThickness',
    );
  return {
    enlargedInsideDiameter: kettle.enlargedInsideDiameter,
    enlargedLength: kettle.enlargedLength,
    transitionLength: kettle.transitionLength,
    enlargedThickness,
    weirHeight: kettle.weirHeight,
  };
}

/**
 * Validated template of `input`, with the names of the defaults applied.
 * @failure invalid TEMA type -> EQP_TEMA_INVALID (path temaType.<i>); kettle vertical or with a fixed rear -> EQP_EXCHANGER_UNSUPPORTED; D without channel + cover thickness, K without kettle, kettle dimensions that do not fit, thickness <= allowance, tube wall without bore,
 *   pitch <= OD, tubes that cannot fit the shell, tube length <= tubesheets, rear channel for a non-fixed rear -> EQP_PARAM_INVALID; support not suiting a
 *   horizontal exchanger -> EQP_SUPPORT_INVALID
 */
export function buildExchangerTemplate(
  input: ExchangerInput,
  units: DocumentUnit,
): { template: ExchangerTemplate; defaulted: string[] } | VesselIssue {
  const defaulted: string[] = [];
  const parsed = parseTema(input.temaType);
  if ('code' in parsed) return issue(parsed.code, parsed.message, parsed.path);
  const { tema } = parsed;
  const vertical = input.orientation === 'vertical';
  const unsupported = unsupportedCombination(input, tema, vertical);
  if (unsupported !== null) return unsupported;
  const allowance = input.corrosionAllowance ?? 0;
  if (input.corrosionAllowance === undefined) defaulted.push('corrosionAllowance');
  if (input.shellThickness <= allowance)
    return issue(
      'EQP_PARAM_INVALID',
      `shellThickness ${input.shellThickness} must exceed the corrosion allowance ${allowance}`,
      'shellThickness',
    );
  const channel = (
    given: { length: number; thickness?: number | undefined; coverThickness?: number | undefined },
    path: string,
    bonnet: boolean,
  ): ExchangerChannel | VesselIssue => {
    if (given.thickness === undefined) defaulted.push(`${path}.thickness`);
    const thickness = given.thickness ?? input.shellThickness;
    if (bonnet && given.coverThickness !== undefined)
      return issue('EQP_PARAM_INVALID', `${path}.coverThickness: a bonnet (B / M) has no flat cover`, `${path}.coverThickness`);
    return thickness <= allowance
      ? issue('EQP_PARAM_INVALID', `${path}.thickness ${thickness} must exceed the corrosion allowance ${allowance}`, `${path}.thickness`)
      : { length: given.length, thickness, ...(given.coverThickness === undefined ? {} : { coverThickness: given.coverThickness }) };
  };
  const frontChannel = channel(input.frontChannel, 'frontChannel', tema.front === 'B');
  if (isVesselIssue(frontChannel)) return frontChannel;
  let rearChannel: ExchangerChannel | undefined;
  if (tema.fixedTubesheet) {
    if (input.rearChannel === undefined) defaulted.push('rearChannel');
    const resolved = channel(input.rearChannel ?? input.frontChannel, 'rearChannel', tema.rear === 'M');
    if (isVesselIssue(resolved)) return resolved;
    rearChannel = resolved;
  } else if (input.rearChannel !== undefined)
    return issue(
      'EQP_PARAM_INVALID',
      `the rear head ${tema.rear} has no channel (it is closed by a shell cover): leave rearChannel out`,
      'rearChannel',
    );
  const kettle = tema.shell === 'K' ? resolveKettle(input, allowance, defaulted) : undefined;
  if (kettle !== undefined && isVesselIssue(kettle)) return kettle;
  const tubes = tubeBundle(input.tubes, units, defaulted);
  if (isVesselIssue(tubes)) return tubes;
  const shellLength = tubes.length - (tema.fixedTubesheet ? 2 : 1) * input.tubesheetThickness;
  if (shellLength <= 0)
    return issue(
      'EQP_PARAM_INVALID',
      `tube length ${tubes.length} leaves no shell after ${tema.fixedTubesheet ? 'two tubesheets' : 'the tubesheet'} of ${input.tubesheetThickness}`,
      'tubes.length',
    );
  const packed = tubes.count * tubes.pitch * tubes.pitch * cellFactor(tubes.layoutAngleDeg);
  const available = (Math.PI * input.shellInsideDiameter ** 2) / 4;
  if (packed > available)
    return issue(
      'EQP_PARAM_INVALID',
      `${tubes.count} tubes at pitch ${tubes.pitch} (${tubes.layoutAngleDeg} deg layout) need ${packed.toPrecision(6)} of cross-section, the shell has ${available.toPrecision(6)}`,
      'tubes.count',
    );
  const wall = Math.max(input.shellThickness, frontChannel.thickness, rearChannel?.thickness ?? 0);
  if (kettle !== undefined) {
    const straight = shellLength - kettle.enlargedLength - kettle.transitionLength;
    if (straight <= 0)
      return issue(
        'EQP_PARAM_INVALID',
        `kettle.enlargedLength ${kettle.enlargedLength} + transitionLength ${kettle.transitionLength} leave no restricted cylinder in the shell length ${shellLength}`,
        'kettle.enlargedLength',
      );
  }
  const support = resolveSupport(
    input.support ?? { type: 'none' },
    {
      orientation: vertical ? 'vertical' : 'horizontal',
      insideDiameter: input.shellInsideDiameter,
      tangentLength: shellLength,
      heads: {},
      shellThickness: wall,
      support: { type: 'none' },
    },
    defaulted,
  );
  if (isVesselIssue(support)) return issue(support.code, support.message, support.path);
  if (input.support === undefined) defaulted.push('support');
  const design = input.design;
  const template: ExchangerTemplate = {
    kind: 'exchanger',
    orientation: vertical ? 'vertical' : 'horizontal',
    ...(kettle === undefined ? {} : { kettle }),
    temaType: input.temaType.trim().toUpperCase(),
    tema,
    shellInsideDiameter: input.shellInsideDiameter,
    shellThickness: input.shellThickness,
    corrosionAllowance: allowance,
    tubes,
    tubesheetThickness: input.tubesheetThickness,
    frontChannel,
    ...(rearChannel === undefined ? {} : { rearChannel }),
    support,
    ...(design === undefined
      ? {}
      : {
          design: {
            shellSide: sideOf(design.shellSide),
            tubeSide: sideOf(design.tubeSide),
            materialDensityKgM3: design.materialDensityKgM3,
          },
        }),
    defaulted,
  };
  return { template, defaulted };
}

/** Bundle-pull length of a removable bundle: tube length plus 1 m in front of the stationary head (named default). */
export const bundlePullLength = (template: ExchangerTemplate, units: DocumentUnit): number | null =>
  template.tema.removableBundle ? template.tubes.length + fromMm({ units }, 1000) : null;
