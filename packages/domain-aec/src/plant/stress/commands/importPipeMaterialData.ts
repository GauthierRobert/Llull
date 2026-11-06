/** `import_pipe_material_data`: a piping code material table (allowable stress, modulus, thermal expansion) as PHY-01 property models on a document material (07 PST M5b, FR-PST-12). */

import { execute } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../codes';

const KELVIN = 273.15;
const REFERENCE_C = 21.1;
const MAX_ROWS = 200;
const DEFAULT_DENSITY_KG_M3 = 7850;
const finite = z.number().refine(Number.isFinite, 'must be finite');

const row = z.object({
  tempC: finite.describe('Metal temperature of the row in degC (rows strictly increasing).'),
  ShMPa: finite
    .refine((value) => value > 0, 'must be positive')
    .describe('Basic allowable stress S (B31.3 Table A-1) or S_h (B31.1 Appendix A) at this temperature, MPa.'),
  EGPa: finite
    .refine((value) => value > 0, 'must be positive')
    .describe("Young's modulus at this temperature in GPa (B31.3 Table C-6). Give it on every row or on none.")
    .optional(),
  meanCtePerK: finite
    .describe(
      'Mean thermal expansion coefficient between the reference temperature and this temperature, 1/K (B31.3 Table C-1 / A-1 mean coefficient). Give this or growthMmPerM on every row, or neither.',
    )
    .optional(),
  growthMmPerM: finite
    .describe(
      'Thermal growth from the reference temperature to this temperature in mm per m of pipe (the tabulated linear expansion). Give this or meanCtePerK on every row, or neither.',
    )
    .optional(),
});

/**
 * @affects CadDocument.materials[materialId]: created when absent; the models E, thermalStrain, pipingAllowableStress (and Fty, Ftu) added or replaced
 * @invariant thermalStrain is (L - L_ref) / L_ref with value 0 at referenceTempC, from the stated mean coefficient or growth; models are basis "unspecified" so every use is unverified (PST_MATERIAL_UNVERIFIED); tables are never extrapolated
 * @failure fewer than 2 rows, more than 200, non-increasing temperatures, E / expansion on some rows only, a row with both expansion forms, a reference above the last row -> PST_TABLE_INVALID; a library (read-only) material or the material commands' own refusals -> their code
 */
export const importPipeMaterialData = defineCommand({
  name: 'import_pipe_material_data',
  description:
    'Store a piping code material table you read from the code as property models on a document material, so thermal growth and allowables come from a named, sourced record: ' +
    'pipingAllowableStress (S or S_h, MPa, versus temperature), E (GPa, optional) and thermalStrain (from the mean expansion coefficient or the tabulated growth, optional) as linear tables over the rows, plus the specified minimum yield / tensile strength as constants. ' +
    'The data is copyrighted: pass what your licence allows and state the licence in `licence`; llull ships none. Rows are in degC, strictly increasing; the thermal strain is referenced to referenceTempC (default 21.1 degC = 70 degF, listed in defaulted) and is exactly 0 there; a reference below the first row extends the strain table down to it by a straight line to the first row (the mean coefficient is nearly constant there; the validity range then starts at the reference). ' +
    'Every model is basis "unspecified": results that use it carry PST_MATERIAL_UNVERIFIED until a qualified engineer has checked the table (no command marks a table verified). Creates the material when absent (density defaults to 7850 kg/m^3, listed in defaulted); re-importing replaces the models. ' +
    'Next: set_pipe_operating_conditions with material.thermal { materialId } for the thermal strain; read S_h(T) and E(T) with evaluate_property (property pipingAllowableStress, E) and pass them as ShMPa / youngsModulusMPa (they are stated inputs, never looked up silently).',
  params: z.object({
    materialId: z.string().min(1).describe('Name of the document material to create or extend, e.g. "A106-B".'),
    designation: z
      .string()
      .min(1)
      .describe('Material designation and form as in the table, e.g. "ASTM A106 Gr. B seamless pipe". Recorded in every model citation.'),
    rows: z.array(row).describe('Table rows by temperature, 2 to 200, tempC strictly increasing.'),
    SMYSMPa: finite
      .refine((value) => value > 0, 'must be positive')
      .describe('Specified minimum yield strength in MPa (stored as Fty).')
      .optional(),
    SMTSMPa: finite
      .refine((value) => value > 0, 'must be positive')
      .describe('Specified minimum tensile strength in MPa (stored as Ftu).')
      .optional(),
    referenceTempC: finite.describe('Reference temperature of the thermal strain in degC. Default 21.1 (70 degF).').optional(),
    densityKgM3: finite
      .refine((value) => value > 0, 'must be positive')
      .describe('Density in kg/m^3 when the material is created. Default 7850.')
      .optional(),
    source: z
      .object({
        citation: z.string().min(3).describe('The code edition and table, e.g. "ASME B31.3-2022 Table A-1 and Appendix C".'),
        locator: z.string().min(1).describe('Where in it: table and page.').optional(),
      })
      .describe('Where the numbers come from (required).'),
    licence: z
      .string()
      .min(3)
      .describe('Statement of the right to hold and use this table, e.g. "company licence ASME-2026-114". Recorded.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const bad = (message: string, path: string): CommandResult =>
      refuse(doc, 'import_pipe_material_data', 'PST_TABLE_INVALID', message, [params.materialId], [path]);
    const rows = params.rows;
    if (rows.length < 2 || rows.length > MAX_ROWS) return bad(`give 2 to ${MAX_ROWS} rows, got ${rows.length}`, 'rows');
    const increasing = rows.findIndex((entry, i) => i > 0 && !(entry.tempC > (rows[i - 1] as (typeof rows)[number]).tempC));
    if (increasing >= 0) return bad(`tempC must be strictly increasing (row ${increasing})`, `rows.${increasing}.tempC`);
    const hasE = rows.map((entry) => entry.EGPa !== undefined);
    if (hasE.some(Boolean) && !hasE.every(Boolean)) return bad('EGPa must be given on every row or on none', 'rows');
    const expansion = rows.map((entry) => (entry.meanCtePerK !== undefined ? 1 : 0) + (entry.growthMmPerM !== undefined ? 1 : 0));
    if (expansion.some((count) => count > 1)) return bad('a row gives meanCtePerK or growthMmPerM, not both', 'rows');
    const strains = rows.map((entry) => entry.meanCtePerK !== undefined || entry.growthMmPerM !== undefined);
    if (strains.some(Boolean) && !strains.every(Boolean))
      return bad('meanCtePerK or growthMmPerM must be given on every row or on none', 'rows');
    const referenceC = params.referenceTempC ?? REFERENCE_C;
    const first = (rows[0] as (typeof rows)[number]).tempC;
    const last = (rows[rows.length - 1] as (typeof rows)[number]).tempC;
    if (strains.every(Boolean) && referenceC > last)
      return bad(`the reference temperature ${referenceC} degC is above the last row (${last} degC)`, 'referenceTempC');
    const defaulted = [
      ...(params.referenceTempC === undefined && strains.every(Boolean) ? [`referenceTempC=${REFERENCE_C}`] : []),
      ...(params.densityKgM3 === undefined && doc.materials?.[params.materialId] === undefined
        ? [`densityKgM3=${DEFAULT_DENSITY_KG_M3}`]
        : []),
    ];
    const citation = `${params.source.citation}, ${params.designation} (licence: ${params.licence})`;
    const source = { citation, ...(params.source.locator === undefined ? {} : { locator: params.source.locator }) };
    const validity = (lo: number, hi: number): unknown => [{ variable: 'T', unit: 'K', data: [lo + KELVIN, hi + KELVIN] }];
    const tabulated = (unit: string, values: readonly number[]): Record<string, unknown> => ({
      form: { kind: 'table1d', variable: 'T', interpolation: 'linear', points: rows.map((entry, i) => [entry.tempC + KELVIN, values[i]]) },
      unit,
      variables: [{ variable: 'T', unit: 'K' }],
      validity: validity(first, last),
    });
    const models: Record<string, unknown>[] = [
      {
        id: 'S.code',
        property: 'pipingAllowableStress',
        basis: 'unspecified',
        source,
        ...tabulated(
          'MPa',
          rows.map((entry) => entry.ShMPa),
        ),
      },
    ];
    if (hasE.every(Boolean))
      models.push({
        id: 'E.code',
        property: 'E',
        basis: 'unspecified',
        source,
        ...tabulated(
          'GPa',
          rows.map((entry) => entry.EGPa as number),
        ),
      });
    if (strains.every(Boolean)) {
      const strain = rows.map((entry) =>
        entry.meanCtePerK !== undefined ? entry.meanCtePerK * (entry.tempC - referenceC) : (entry.growthMmPerM as number) / 1000,
      );
      const points = rows.map((entry, i) => [entry.tempC, strain[i] as number] as const);
      // the strain is exactly 0 at the reference: add that point when no row sits on it
      const onReference = points.findIndex(([tempC]) => Math.abs(tempC - referenceC) < 1e-9);
      const withReference = onReference >= 0 ? points : [...points, [referenceC, 0] as const].sort((a, b) => a[0] - b[0]);
      models.push({
        id: 'thermalStrain.code',
        property: 'thermalStrain',
        basis: 'unspecified',
        source,
        unit: '1',
        variables: [{ variable: 'T', unit: 'K' }],
        validity: validity(Math.min(first, referenceC), last),
        form: {
          kind: 'table1d',
          variable: 'T',
          interpolation: 'linear',
          points: withReference.map(([tempC, value]) => [tempC + KELVIN, value]),
        },
      });
    }
    for (const [id, property, value] of [
      ['Fty.code', 'Fty', params.SMYSMPa],
      ['Ftu.code', 'Ftu', params.SMTSMPa],
    ] as const)
      if (value !== undefined)
        models.push({
          id,
          property,
          basis: 'unspecified',
          source,
          unit: 'MPa',
          variables: [],
          validity: [],
          form: { kind: 'constant', value },
        });
    let next = doc;
    if (doc.materials?.[params.materialId] === undefined) {
      const created = execute(
        next,
        'create_material',
        { name: params.materialId, density: params.densityKgM3 ?? DEFAULT_DENSITY_KG_M3, densityUnit: 'kg/m^3' },
        ctx,
      );
      if (created.rejected === true) return { ...created, document: doc };
      next = created.document;
    }
    for (const model of models) {
      const defined = execute(next, 'define_property_model', { material: params.materialId, model, replace: true }, ctx);
      if (defined.rejected === true) return { ...defined, document: doc };
      next = defined.document;
    }
    return {
      ...changed(
        next,
        `import_pipe_material_data: ${params.materialId} (${params.designation}) ${rows.length} rows ${first} to ${last} degC: ${models.map((model) => model['property']).join(', ')}; basis unspecified (unverified)${defaulted.length > 0 ? `; defaulted ${defaulted.join(', ')}` : ''}.`,
        [],
      ),
      data: {
        materialId: params.materialId,
        models: models.map((model) => ({ id: model['id'], property: model['property'] })),
        rows: rows.length,
        rangeC: [first, last],
        referenceTempC: strains.every(Boolean) ? referenceC : null,
        referencePointAdded: strains.every(Boolean) && !rows.some((entry) => Math.abs(entry.tempC - referenceC) < 1e-9),
        defaulted,
        unverified: true,
      },
    };
  },
});
