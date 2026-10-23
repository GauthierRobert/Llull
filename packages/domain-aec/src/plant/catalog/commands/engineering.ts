/** Engineering queries on catalogue data (plant 01 PSC M1): `pipe_section_properties`, `pt_rating`. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { toMm } from '@core/model/units';
import { pipeWallThickness } from '../../../industrial/piping/pipeWeight';
import { getBuilding } from '../../../building/model';
import { bundledCatalog } from '../bundled';
import { refuse } from '../codes';
import { resolveCatalogRow } from '../lookup';
import { en10220OutsideDiameter, sizePair } from '../nominal';
import { BAR_PER_PSI, findRatingTable, ratingAt, tabulatedPsi, availableRatingTables } from '../ptRating';
import { sectionProperties, STEEL_DENSITY_KG_M3 } from '../sectionProperties';
import type { Provenance } from '../types';

const nominalParam = z.union([z.number(), z.string()]);

interface PipeBasis {
  readonly odMm: number;
  readonly wallMm: number;
  readonly basis: 'pipe spec' | 'legacy wall table' | 'catalogue' | 'caller';
  readonly verified: boolean;
  readonly schedule?: string;
  readonly standard?: string;
  readonly provenance?: Provenance;
}

/** ASME B36.10M OD of an NPS, or the EN 10220 OD of a DN when `standard` names EN. */
function standardOd(nps: string | number | undefined, dn: string | number | undefined, standard: string | undefined): number | null {
  const size = sizePair({ nps, dn });
  if (size === null) return null;
  if (standard !== undefined && /EN/i.test(standard)) return size.dn === null ? null : en10220OutsideDiameter(size.dn);
  const pipe = bundledCatalog().families.find((family) => family.id === 'asme-b36.10m');
  return pipe?.sizes.find((row) => row.size.key === size.nps?.key)?.dims['outsideDiameter']?.value ?? null;
}

const properties = z.object({
  pipeId: z
    .string()
    .describe(
      'Id of a pipe element (building category pipe). Its spec binding (OD, wall) is used, else the legacy wall table (flagged unverified).',
    )
    .optional(),
  nps: nominalParam
    .describe(
      'Nominal pipe size, inch designation ("6", "2-1/2" or 2.5). With schedule: OD and wall come from the catalogue. Give nps or dn.',
    )
    .optional(),
  dn: nominalParam.describe('Nominal diameter DN (integer). Converted to NPS for the catalogue lookup.').optional(),
  schedule: z.string().describe('Pipe schedule ("40", "80", "STD", "10S" …); with nps / dn selects the catalogue wall.').optional(),
  standard: z.string().describe('Pipe standard, "ASME B36.10M" (default), "ASME B36.19M" or "EN 10220" (OD only: give wallMm).').optional(),
  odMm: z.number().positive().describe('Outside diameter in mm, when no size is given.').optional(),
  wallMm: z.number().positive().describe('Nominal wall in mm (with nps / dn / odMm, instead of a schedule).').optional(),
  materialDensityKgM3: z.number().positive().describe('Pipe metal density in kg/m3. Default 7850 (carbon steel).').optional(),
  contentDensityKgM3: z.number().min(0).describe('Contents density in kg/m3 (water 1000). Default 0 (empty).').optional(),
  insulation: z
    .object({
      thicknessMm: z.number().positive().describe('Insulation thickness in mm.'),
      densityKgM3: z.number().positive().describe('Insulation density in kg/m3.'),
    })
    .describe('Insulation layer around the pipe (mass only; cladding is not included).')
    .optional(),
});

export const pipeSectionProperties = defineCommand({
  name: 'pipe_section_properties',
  description:
    'Section properties and mass per metre of a round steel pipe: inside diameter, metal and flow area (mm2), second moment I and section modulus Z (mm4, mm3), ' +
    'and mass per metre of the metal (plain-end, 7850 kg/m3 by default), contents and insulation, plus weight in kN/m. ' +
    'Give a pipeId (pipe element: uses its spec OD / wall, else the legacy wall table, flagged unverified), or nps / dn with schedule (ASME B36.10M / B36.19M row from the catalogue), ' +
    'or odMm with wallMm. Lengths are mm in and out (a pipe element diameter is read in document units). Example: NPS 6 Sch 40, water: 28.264 + 18.646 = 46.909 kg/m. ' +
    'Refuses unknown pipes / sizes / schedules and non-physical walls (wall >= OD / 2). Next: use weightKnPerM for support and rack loads (check_pipe_supports, pipe_hydraulics).',
  params: properties,
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuse(doc, 'pipe_section_properties', code, message, ids, paths);
    let basis: PipeBasis;
    if (params.pipeId !== undefined) {
      const element = getBuilding(doc).elements[params.pipeId];
      if (element === undefined || element.category !== 'pipe')
        return fail('PSC_PIPE_UNKNOWN', `no pipe element "${params.pipeId}"`, [params.pipeId], ['pipeId']);
      const spec = element.spec;
      const diameter = toMm(doc, element.diameter);
      basis =
        spec === undefined
          ? { odMm: diameter, wallMm: pipeWallThickness(diameter), basis: 'legacy wall table', verified: false }
          : {
              odMm: spec.odMm,
              wallMm: spec.wallMm,
              basis: 'pipe spec',
              verified: spec.verified,
              ...(spec.schedule === undefined ? {} : { schedule: spec.schedule }),
            };
    } else if (params.schedule !== undefined) {
      const outcome = resolveCatalogRow(bundledCatalog(), {
        type: 'pipe',
        nps: params.nps,
        dn: params.dn,
        schedule: params.schedule,
        standard: params.standard,
      });
      if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.ids, ['nps']);
      const od = outcome.row.dims['outsideDiameter'];
      const wall = outcome.row.dims['wall'];
      if (od === undefined || wall === undefined) return fail('PSC_CATALOG_ROW_MISSING', 'the catalogue row has no outsideDiameter / wall');
      basis = {
        odMm: od.value,
        wallMm: wall.value,
        basis: 'catalogue',
        verified: outcome.row.verified,
        schedule: outcome.row.schedule ?? params.schedule,
        standard: outcome.row.standard,
        provenance: od.provenance,
      };
    } else if (params.wallMm !== undefined) {
      const od = params.odMm ?? standardOd(params.nps, params.dn, params.standard);
      if (od === null) return fail('PSC_SIZE_UNKNOWN', 'give odMm, or a nps / dn that has a standard outside diameter', [], ['nps']);
      basis = { odMm: od, wallMm: params.wallMm, basis: 'caller', verified: true };
    } else return fail('PSC_SIZE_UNKNOWN', 'give a pipeId, nps / dn with schedule, or odMm with wallMm', [], ['pipeId']);
    const section = sectionProperties({
      odMm: basis.odMm,
      wallMm: basis.wallMm,
      steelDensityKgM3: params.materialDensityKgM3 ?? STEEL_DENSITY_KG_M3,
      contentDensityKgM3: params.contentDensityKgM3 ?? 0,
      ...(params.insulation === undefined ? {} : { insulation: params.insulation }),
    });
    if (section === null)
      return fail(
        'PSC_SIZE_UNKNOWN',
        `OD ${basis.odMm} mm and wall ${basis.wallMm} mm are not a physical pipe (need 0 < wall < OD / 2)`,
        [],
        ['wallMm'],
      );
    const unverified = !basis.verified;
    return report(
      doc,
      `pipe_section_properties: OD ${basis.odMm} x wall ${basis.wallMm} mm (${basis.basis}${basis.schedule === undefined ? '' : `, sch ${basis.schedule}`}): ID ${section.insideDiameterMm.toFixed(2)} mm, metal ${section.massKgPerM.toFixed(3)} kg/m, ` +
        `contents ${section.contentMassKgPerM.toFixed(3)}, insulation ${section.insulationMassKgPerM.toFixed(3)}, total ${section.totalMassKgPerM.toFixed(3)} kg/m = ${section.weightKnPerM.toFixed(5)} kN/m${unverified ? '; UNVERIFIED (PSC_DATA_UNVERIFIED)' : ''}.`,
      {
        outsideDiameterMm: basis.odMm,
        wallMm: basis.wallMm,
        ...section,
        steelDensityKgM3: params.materialDensityKgM3 ?? STEEL_DENSITY_KG_M3,
        contentDensityKgM3: params.contentDensityKgM3 ?? 0,
        basis: basis.basis,
        ...(basis.schedule === undefined ? {} : { schedule: basis.schedule }),
        ...(basis.standard === undefined ? {} : { standard: basis.standard }),
        verified: basis.verified,
        ...(unverified ? { warnings: [{ code: 'PSC_DATA_UNVERIFIED', basis: basis.basis }] } : {}),
        ...(basis.provenance === undefined ? {} : { provenance: basis.provenance }),
        formulas: {
          mass: 'metal mass = density x pi (D - t) t x 1e-6 kg/m (0.0246615 (D - t) t for 7850)',
          secondMoment: 'I = pi/64 (D^4 - d^4), Z = 2 I / D',
          weight: 'kN/m = total kg/m x 9.80665 / 1000',
        },
      },
    );
  },
});

const TEMPERATURE_UNITS = ['C', 'F'] as const;

/**
 * @affects none; data = { ratingBar, ratingPsi?, method, bracket, verified, tableId }
 * @invariant read-only; linear interpolation only between tabulated rows; verified only when every used row is grade A
 * @failure no table for the standard / group -> PSC_CATALOG_ROW_MISSING; class missing -> PSC_CATALOG_ROW_MISSING; temperature outside the table -> PSC_PT_TEMPERATURE_OUT_OF_TABLE
 */
export const ptRating = defineCommand({
  name: 'pt_rating',
  description:
    'Pressure-temperature rating of a flange class: the maximum working pressure in bar gauge (or psig) at a temperature, from the bundled ASME B16.5 table for material group 1.1 ' +
    '(carbon steel A105 / A216 WCB / A515-70 / A516-70) classes 150 to 2500. Linear interpolation between tabulated temperatures (permitted by B16.5); at or below the first row ' +
    '(38 degC) the first value applies; above the last row or below -29 degC the command refuses (PSC_PT_TEMPERATURE_OUT_OF_TABLE). Class 150 is tabulated to 200 degC, class 300 and up only to 50 degC (other points have no agreeing source). ' +
    'Give temperatureC, or temperature { value, unit: "C" | "F" }. unit "psi" returns the tabulated psig at or below 100 degF (285 for class 150) and otherwise converts bar at 0.0689475729 bar/psi, stating it. ' +
    'verified is true only when every row used is grade A. Ratings are for a qualified engineer to confirm. Next: check_pipe_spec compares design pressure with this rating.',
  params: z.object({
    standard: z.string().describe('Rating standard, "ASME B16.5" (the only bundled table).'),
    materialGroup: z.string().describe('Material group, "1.1" (the only bundled group).'),
    class: z.number().int().positive().describe('ASME pressure class: 150, 300, 600, 900, 1500, 2500.'),
    temperatureC: z.number().describe('Design temperature in degC. Give this or temperature.').optional(),
    temperature: z
      .object({ value: z.number().describe('Temperature value.'), unit: z.enum(TEMPERATURE_UNITS).describe('C or F.') })
      .describe('Design temperature with its unit. Give this or temperatureC.')
      .optional(),
    unit: z.enum(['bar', 'psi']).describe('Pressure unit of the answer: bar (gauge, default) or psi (psig).').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult => refuse(doc, 'pt_rating', code, message, [], [path]);
    if ((params.temperatureC === undefined) === (params.temperature === undefined))
      return fail('PSC_UNIT_INVALID', 'give exactly one of temperatureC or temperature { value, unit }', 'temperatureC');
    const temperatureC =
      params.temperatureC ??
      (params.temperature?.unit === 'F' ? ((params.temperature.value - 32) * 5) / 9 : (params.temperature?.value as number));
    const table = findRatingTable(params.standard, params.materialGroup);
    if (table === undefined)
      return fail(
        'PSC_CATALOG_ROW_MISSING',
        `no rating table for ${params.standard} group ${params.materialGroup} (available: ${availableRatingTables().join(', ')}; others are import-only)`,
        'standard',
      );
    const rating = ratingAt(table, params.class, temperatureC);
    if (!rating.ok) return fail(rating.code, rating.message, rating.code === 'PSC_PT_TEMPERATURE_OUT_OF_TABLE' ? 'temperatureC' : 'class');
    const psi = params.unit === 'psi' ? tabulatedPsi(table, params.class, temperatureC) : null;
    const ratingPsi = params.unit === 'psi' ? (psi?.psi ?? rating.ratingBar / BAR_PER_PSI) : undefined;
    const method = psi === null ? rating.method : 'tabulated psig';
    const verified = psi === null ? rating.verified : psi.verified;
    const shown = ratingPsi === undefined ? `${rating.ratingBar.toFixed(4)} bar` : `${ratingPsi.toFixed(2)} psig`;
    return report(
      doc,
      `pt_rating: ${table.standard} group ${table.materialGroup} class ${params.class} at ${temperatureC.toFixed(2)} degC: ${shown} (${method}${psi === null && ratingPsi !== undefined ? `, converted at ${BAR_PER_PSI} bar/psi` : ''})${verified ? '' : '; UNVERIFIED (PSC_DATA_UNVERIFIED)'}.`,
      {
        tableId: table.id,
        standard: table.standard,
        materialGroup: table.materialGroup,
        class: params.class,
        temperatureC,
        ratingBar: rating.ratingBar,
        ...(ratingPsi === undefined
          ? {}
          : { ratingPsi, unit: 'psi', ...(psi === null ? { conversion: `1 psi = ${BAR_PER_PSI} bar` } : {}) }),
        method,
        bracket: rating.bracket.map((row) => ({ temperatureC: row.temperatureC, ratingBar: row.bar.value, verified: row.bar.verified })),
        verified,
        ...(verified ? {} : { warnings: [{ code: 'PSC_DATA_UNVERIFIED', table: table.id }] }),
      },
    );
  },
});
