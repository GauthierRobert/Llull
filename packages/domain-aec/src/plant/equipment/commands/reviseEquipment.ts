/**
 * In-place revision of parametric exchangers, tanks and pumps (`update_equipment_parameters`, plant 03 EQP-FU): the patch schemas and, per kind, the
 * function that merges a patch into the stored template, re-runs the creation builder (so every creation refusal applies) and keeps what the user
 * did not touch (resolved supports, tube wall provenance, user thicknesses, vendor envelope, nozzle records).
 */

import { z } from '@core/commands/schema';
import type { CadDocument, DocumentUnit } from '@core/model/types';
import { parseTema } from '../codecheck/tema';
import type { EquipmentTemplate, ExchangerSideDesign, ExchangerTemplate, NozzleRecord, PumpTemplate, TankTemplate } from '../plantData';
import { buildExchangerTemplate, channelSchema, exchangerShape, sideSchema, type ExchangerInput } from './exchangerParams';
import { buildPumpTemplate, pumpShape, type PumpInput } from './pumpParams';
import { buildTankTemplate, tankShape, type TankInput } from './tankParams';
import { isVesselIssue, type VesselIssue } from './vesselParams';

export const exchangerPatchSchema = z
  .object({
    temaType: exchangerShape.temaType.optional(),
    shellInsideDiameter: exchangerShape.shellInsideDiameter.optional(),
    shellThickness: exchangerShape.shellThickness.optional(),
    corrosionAllowance: exchangerShape.corrosionAllowance,
    tubes: exchangerShape.tubes.partial().optional().describe('Tube fields to change; the others are kept (give wallThickness OR bwg).'),
    tubesheetThickness: exchangerShape.tubesheetThickness.optional(),
    frontChannel: channelSchema.partial().optional().describe('Front channel fields to change { length, thickness }.'),
    rearChannel: channelSchema.partial().optional().describe('Rear channel fields to change (fixed-tubesheet rears L, M, N only).'),
    support: exchangerShape.support.describe(
      'New support; replaces the whole support (saddles { stations, width, axisElevation } or none).',
    ),
    design: z
      .object({
        shellSide: sideSchema.partial().optional().describe('Shell-side design fields to set.'),
        tubeSide: sideSchema.partial().optional().describe('Tube-side design fields to set.'),
        materialDensityKgM3: z.number().positive().optional().describe('Metal density, kg/m3.'),
      })
      .optional()
      .describe('Design data to set per side; fields you omit are kept.'),
  })
  .describe('Exchanger fields to change (add_heat_exchanger meaning); everything omitted stays. Only for a parametric exchanger.');

export const tankPatchSchema = z
  .object({
    diameter: tankShape.diameter.optional(),
    shellHeight: tankShape.shellHeight.optional(),
    courses: tankShape.courses.optional(),
    courseThicknesses: tankShape.courseThicknesses,
    roof: tankShape.roof.partial().optional().describe('Roof fields to change { type, slopeRatio, radius, thickness }.'),
    bottom: tankShape.bottom.unwrap().partial().optional().describe('Bottom fields to change { annularPlate, thickness }.'),
    design: tankShape.design.partial().optional().describe('Design fields to change; the others are kept.'),
  })
  .describe(
    'Tank fields to change (add_storage_tank meaning); everything omitted stays. Course thicknesses that came from the one-foot method are derived ' +
      'again from the new shape; thicknesses you gave are kept (give courseThicknesses again when the course count changes). Only for a parametric tank.',
  );

export const pumpPatchSchema = z
  .object({
    standard: pumpShape.standard.optional(),
    size: pumpShape.size,
    envelope: pumpShape.envelope
      .unwrap()
      .partial()
      .optional()
      .describe('Envelope fields to change; the others are kept. Not together with size.'),
    api610Type: pumpShape.api610Type,
    rating: pumpShape.rating,
    driver: pumpShape.driver
      .unwrap()
      .partial()
      .nullable()
      .optional()
      .describe('Driver box fields to change { length, width, height, couplingGap }; null removes the driver.'),
    baseplate: pumpShape.baseplate.unwrap().partial().optional().describe('Baseplate box fields to change.'),
    weightKg: pumpShape.weightKg,
  })
  .describe(
    'Pump fields to change (add_pump meaning); everything omitted stays. A new size / envelope / rating re-places the SUC and DIS nozzles (their marks ' +
      'and port ids stay); extra free nozzles stay where they are. Only for a parametric pump.',
  );

export type ExchangerPatch = z.infer<typeof exchangerPatchSchema>;
export type TankPatch = z.infer<typeof tankPatchSchema>;
export type PumpPatch = z.infer<typeof pumpPatchSchema>;

export interface Revision<T extends EquipmentTemplate> {
  readonly template: T;
  readonly nozzles: readonly NozzleRecord[];
}

/** `value` without its undefined entries (a zod partial object carries explicit undefined). */
const defined = <T extends object>(value: T | undefined | null): Partial<T> =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)) as Partial<T>;

/** Dotted paths (one and two levels) of the fields a patch sets. */
function patchedPaths(patch: object): string[] {
  return Object.entries(defined(patch)).flatMap(([key, value]) => [
    key,
    ...(typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.keys(defined(value)).map((inner) => `${key}.${inner}`)
      : []),
  ]);
}

/** Old defaults the patch did not set, plus the new builder's own. */
function mergeDefaulted(old: readonly string[], built: readonly string[], patch: object): string[] {
  const touched = new Set(patchedPaths(patch));
  return [...new Set([...old.filter((name) => !touched.has(name)), ...built])];
}

const sideOf = (old: ExchangerSideDesign | undefined, patch: Partial<ExchangerSideDesign> | undefined): ExchangerSideDesign | undefined =>
  old === undefined && patch === undefined ? undefined : { ...old, ...defined(patch) };

function exchangerInputOf(template: ExchangerTemplate, patch: ExchangerPatch): ExchangerInput {
  const { support, tubes, design } = template;
  const temaType = patch.temaType ?? template.temaType;
  const parsed = parseTema(temaType);
  const fixed = 'tema' in parsed && parsed.tema.fixedTubesheet;
  const tubePatch = defined(patch.tubes);
  const tubeBase = {
    outsideDiameter: tubes.outsideDiameter,
    ...(tubePatch.bwg === undefined ? { wallThickness: tubes.wallThickness } : {}),
    count: tubes.count,
    length: tubes.length,
    passes: tubes.passes,
    pitch: tubes.pitch,
    layoutAngleDeg: tubes.layoutAngleDeg,
  };
  const designPatch = patch.design;
  return {
    temaType,
    orientation: 'horizontal',
    shellInsideDiameter: patch.shellInsideDiameter ?? template.shellInsideDiameter,
    shellThickness: patch.shellThickness ?? template.shellThickness,
    corrosionAllowance: patch.corrosionAllowance ?? template.corrosionAllowance,
    tubes: { ...tubeBase, ...tubePatch },
    tubesheetThickness: patch.tubesheetThickness ?? template.tubesheetThickness,
    frontChannel: { ...template.frontChannel, ...defined(patch.frontChannel) },
    ...(fixed ? { rearChannel: { ...(template.rearChannel ?? template.frontChannel), ...defined(patch.rearChannel) } } : {}),
    support: patch.support ?? (support.type === 'saddles' ? { ...support, stations: [...support.stations] } : support),
    ...(design === undefined && designPatch === undefined
      ? {}
      : {
          design: {
            shellSide: sideOf(design?.shellSide, designPatch?.shellSide),
            tubeSide: sideOf(design?.tubeSide, designPatch?.tubeSide),
            materialDensityKgM3: designPatch?.materialDensityKgM3 ?? design?.materialDensityKgM3,
          },
        }),
  } as ExchangerInput;
}

/**
 * The exchanger `old` with `patch` applied, rebuilt through `buildExchangerTemplate`; nozzles are returned unchanged (the caller re-validates them).
 * @failure any creation refusal of add_heat_exchanger for the merged input, with the path it names
 */
export function reviseExchanger(
  units: DocumentUnit,
  old: ExchangerTemplate,
  nozzles: readonly NozzleRecord[],
  patch: ExchangerPatch,
): Revision<ExchangerTemplate> | VesselIssue {
  const built = buildExchangerTemplate(exchangerInputOf(old, patch), units);
  if (isVesselIssue(built)) return built;
  const wallKept =
    patch.tubes === undefined ||
    (patch.tubes.outsideDiameter === undefined && patch.tubes.wallThickness === undefined && patch.tubes.bwg === undefined);
  const tubes = wallKept
    ? { ...built.template.tubes, wallSource: old.tubes.wallSource, wallUnverified: old.tubes.wallUnverified }
    : built.template.tubes;
  return { template: { ...built.template, tubes, defaulted: mergeDefaulted(old.defaulted, built.defaulted, patch) }, nozzles };
}

function tankInputOf(template: TankTemplate, patch: TankPatch): TankInput {
  const { roof, bottom } = template;
  const thicknesses = patch.courseThicknesses ?? (template.thicknessSource === 'user' ? [...template.courseThicknesses] : undefined);
  return {
    standard: 'api_650',
    diameter: patch.diameter ?? template.diameter,
    shellHeight: patch.shellHeight ?? template.shellHeight,
    courses: patch.courses ?? [...template.courses],
    ...(thicknesses === undefined ? {} : { courseThicknesses: thicknesses }),
    roof: {
      type: roof.type,
      ...(roof.slope === undefined ? {} : { slopeRatio: roof.slope }),
      ...(roof.radius === undefined ? {} : { radius: roof.radius }),
      thickness: roof.thickness,
      ...defined(patch.roof),
    },
    bottom: { type: 'flat', annularPlate: bottom.annularPlate, thickness: bottom.thickness, ...defined(patch.bottom) },
    design: { ...template.design, ...defined(patch.design) },
  } as TankInput;
}

/**
 * The tank `old` with `patch` applied, rebuilt through `buildTankTemplate`; nozzles are returned unchanged (the caller re-validates them).
 * @failure any creation refusal of add_storage_tank for the merged input, with the path it names
 */
export function reviseTank(
  units: DocumentUnit,
  old: TankTemplate,
  nozzles: readonly NozzleRecord[],
  patch: TankPatch,
): Revision<TankTemplate> | VesselIssue {
  const built = buildTankTemplate(tankInputOf(old, patch), units);
  if (isVesselIssue(built)) return built;
  return { template: { ...built.template, defaulted: mergeDefaulted(old.defaulted, built.defaulted, patch) }, nozzles };
}

function pumpInputOf(template: PumpTemplate, patch: PumpPatch): PumpInput {
  const { envelope, driver, baseplate } = template;
  const byEnvelope = patch.envelope !== undefined || (template.size === undefined && patch.size === undefined);
  const explicit = {
    a: envelope.a,
    f: envelope.f,
    h1: envelope.h1,
    h2: envelope.h2,
    suctionDn: envelope.suctionDn,
    dischargeDn: envelope.dischargeDn,
    ...(envelope.grade === 'A' && template.size === undefined ? { source: envelope.source } : {}),
    ...defined(patch.envelope),
  };
  const driverBox =
    patch.driver === null || (driver === undefined && patch.driver === undefined) ? undefined : { ...driver, ...defined(patch.driver) };
  const weightKg = patch.weightKg ?? template.weightKg;
  const api610Type = patch.api610Type ?? template.api610Type;
  return {
    standard: patch.standard ?? template.standard,
    ...(byEnvelope ? { envelope: explicit } : { size: patch.size ?? template.size }),
    ...(api610Type === undefined ? {} : { api610Type }),
    rating: patch.rating ?? envelope.rating,
    ...(driverBox === undefined ? {} : { driver: driverBox }),
    ...(template.defaulted.includes('baseplate') && patch.baseplate === undefined
      ? {}
      : { baseplate: { ...baseplate, ...defined(patch.baseplate) } }),
    ...(weightKg === undefined ? {} : { weightKg }),
  } as PumpInput;
}

/**
 * The pump `old` with `patch` applied, rebuilt through `buildPumpTemplate`. The SUC / DIS records that exist keep their record (facing, service, hardware)
 * when DN and rating are unchanged, and are re-placed on the new envelope; other nozzles are kept.
 * @failure any creation refusal of add_pump for the merged input, with the path it names
 */
export function revisePump(
  doc: CadDocument,
  old: PumpTemplate,
  nozzles: readonly NozzleRecord[],
  patch: PumpPatch,
): Revision<PumpTemplate> | VesselIssue {
  if (patch.size !== undefined && patch.envelope !== undefined)
    return { code: 'EQP_PARAM_INVALID', message: 'give size OR envelope, not both', path: 'envelope' };
  const input = pumpInputOf(old, patch);
  const box = input.driver;
  if (box !== undefined && !(box.length > 0 && box.width > 0 && box.height > 0))
    return { code: 'EQP_PARAM_INVALID', message: 'a new driver needs length, width and height', path: 'driver' };
  const built = buildPumpTemplate(doc, input);
  if (isVesselIssue(built)) return built;
  const fresh = new Map(built.nozzles.map((record) => [record.mark, record]));
  const revised = nozzles.map((record): NozzleRecord => {
    const next = fresh.get(record.mark);
    if (next === undefined) return record;
    return record.dn === next.dn && record.rating === next.rating
      ? { ...record, location: next.location, projection: next.projection }
      : { ...next, facing: record.facing, ...(record.service === undefined ? {} : { service: record.service }) };
  });
  return { template: { ...built.template, defaulted: mergeDefaulted(old.defaulted, built.defaulted, patch) }, nozzles: revised };
}
