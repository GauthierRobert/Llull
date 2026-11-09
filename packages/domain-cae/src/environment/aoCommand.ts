/** ao_erosion (PHY-14 FR-ENV-10): atomic-oxygen recession depth Ey F and mass loss rho A Ey F. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { EROSION_REFERENCES, massLossG, recessionCm } from './atomicOxygen';
import { refuseEnv, unverifiedItem, type EnvItem } from './codes';
import { describeInput, givenInput, isInputProblem, materialInput, type ResolvedInput } from './inputs';
import { materialProperty, type MaterialMissing } from './materialValue';
import { spaceEnvironmentOf } from './model';
import { quantitySchema, type UnitProblem } from './units';

const COMMAND = 'ao_erosion';
const UM_PER_CM = 1e4;
const YIELD_UNITS = ['cm^3/atom', 'mm^3/atom', 'm^3/atom'] as const;
const FLUENCE_UNITS = ['atoms/cm^2', 'atoms/m^2'] as const;
/** Volume per atom in cm^3 and fluence in atoms/cm^2 are the formula units; these are the SI-to-cm factors of the accepted unit strings. */
const YIELD_TO_CM3: Readonly<Record<(typeof YIELD_UNITS)[number], number>> = { 'cm^3/atom': 1, 'mm^3/atom': 1e-3, 'm^3/atom': 1e6 };
const FLUENCE_TO_CM2: Readonly<Record<(typeof FLUENCE_UNITS)[number], number>> = { 'atoms/cm^2': 1, 'atoms/m^2': 1e-4 };

const blank = (text: string | undefined): boolean => text === undefined || text.trim() === '';

/**
 * @affects nothing; read-only, data { recessionUm, recessionCm, massLossG?, erosionYield, fluence, inputs, items, unverified }
 * @invariant recession = Ey F (cm, reported in um); mass loss = rho A Ey F; yield and fluence are inputs with a source, never computed or defaulted (the kapton_h reference carries its citation and caveat)
 * @failure no Ey -> ENV_PROPERTY_MISSING; no fluence (param or mission) -> ENV_FLUENCE_UNSET; yield / fluence / density without a source -> ENV_SOURCE_MISSING; non-positive or non-finite value, wrong unit -> ENV_PARAM_INVALID; area without density -> ENV_PROPERTY_MISSING
 */
export const aoErosion = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Atomic-oxygen (LEO) erosion of a polymer: recession depth d = Ey * F and, with density and exposed area, mass loss m = rho * A * Ey * F, where Ey is the erosion yield (volume eroded per incident atom) ' +
    'and F the fluence (atoms per area). Ey: `erosionYield` {value, unit cm^3/atom | mm^3/atom | m^3/atom, source}, or `reference` "kapton_h" (3.0e-24 cm^3/atom, flight-experiment reference: STS-8 / EOIM-1, ' +
    'JAXA AA1830019009 + SPENVIS; it depends on exposure conditions), or `material` with an aoErosionYield property. F: `fluence` {value, unit atoms/cm^2 | atoms/m^2, source} or the mission fluence ' +
    '(set_mission_environment aoFluence); llull never computes fluence from an orbit. Mass loss needs `area` {value, unit} and a density (`density` {value, unit, source}, or the material density). ' +
    'Every yield, fluence and density given as a parameter needs its `source`. Returns recessionUm, massLossG (when area is given), the inputs with their sources and the ENV_VALUE_UNVERIFIED warning for ' +
    'unsourced or typical values. Example: Kapton H, F 1e21 atoms/cm^2: 30.0 um. Not an exposure-condition-specific prediction: yields in ISS orbit and ground facilities differ.',
  params: z.object({
    erosionYield: z
      .object({
        value: z.number().describe('Erosion yield Ey, > 0.'),
        unit: z.enum(YIELD_UNITS).describe('cm^3/atom (e.g. Kapton H 3.0e-24), mm^3/atom or m^3/atom.'),
        source: z.string().optional().describe('REQUIRED: where the yield comes from (flight experiment, test report).'),
      })
      .optional()
      .describe('Erosion yield, overrides `reference` and `material`.'),
    reference: z
      .enum(['kapton_h'])
      .optional()
      .describe('Bundled reference yield: "kapton_h" = 3.0e-24 cm^3/atom (cited, with the exposure-condition caveat).'),
    material: z.string().optional().describe('Material id: Ey from its aoErosionYield property, density from its density.'),
    fluence: z
      .object({
        value: z.number().describe('Fluence F, >= 0.'),
        unit: z.enum(FLUENCE_UNITS).describe('atoms/cm^2 or atoms/m^2.'),
        source: z.string().optional().describe('REQUIRED: the mission analysis it comes from.'),
      })
      .optional()
      .describe('Atomic-oxygen fluence; default: the mission aoFluence.'),
    area: quantitySchema.optional().describe('Exposed area {value, unit (cm^2, mm^2, m^2 ...)} for the mass loss.'),
    density: z
      .object({
        value: z.number().describe('Density, > 0.'),
        unit: z.string().describe('Density unit, e.g. "g/cm^3", "kg/m^3".'),
        source: z.string().optional().describe('REQUIRED: where the density comes from.'),
      })
      .optional()
      .describe('Density for the mass loss; default: the material density.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseEnv(doc, COMMAND, code, message, params.material === undefined ? [] : [params.material], [path]);
    const failFor = (problem: UnitProblem | MaterialMissing, path: string): CommandResult =>
      'path' in problem
        ? fail('ENV_PARAM_INVALID', problem.message, problem.path)
        : fail(problem.code === 'PROP_NO_MODEL_FOR_PROPERTY' ? 'ENV_PROPERTY_MISSING' : problem.code, problem.reason, path);
    const items: EnvItem[] = [];

    let erosionYield: ResolvedInput;
    if (params.erosionYield !== undefined) {
      if (blank(params.erosionYield.source)) return fail('ENV_SOURCE_MISSING', 'the erosion yield needs its source', 'erosionYield.source');
      if (!(Number.isFinite(params.erosionYield.value) && params.erosionYield.value > 0))
        return fail('ENV_PARAM_INVALID', `erosion yield must be finite and > 0 (got ${params.erosionYield.value})`, 'erosionYield.value');
      erosionYield = {
        value: params.erosionYield.value * YIELD_TO_CM3[params.erosionYield.unit],
        unit: 'cm^3/atom',
        source: params.erosionYield.source,
        unverified: false,
      };
    } else if (params.reference !== undefined) {
      const reference = EROSION_REFERENCES[params.reference];
      if (reference === undefined) return fail('ENV_PARAM_INVALID', `no reference '${params.reference}'`, 'reference');
      erosionYield = { value: reference.erosionYieldCm3PerAtom, unit: 'cm^3/atom', source: reference.source, unverified: false };
      items.push({ code: 'ENV_MODEL_ASSUMPTION', severity: 'info', message: `${reference.label}: ${reference.caveat}` });
    } else if (params.material !== undefined) {
      const found = materialProperty(doc, ctx, params.material, 'aoErosionYield', 'cm^3');
      if ('reason' in found) return failFor(found, 'material');
      erosionYield = { ...materialInput(found), unit: 'cm^3/atom' };
    } else
      return fail(
        'ENV_PROPERTY_MISSING',
        'no erosion yield: give `erosionYield`, `reference` or a `material` with an aoErosionYield property',
        'erosionYield',
      );
    if (!(Number.isFinite(erosionYield.value) && erosionYield.value > 0))
      return fail('ENV_PARAM_INVALID', 'the erosion yield must be finite and > 0', 'erosionYield');

    const missionFluence = spaceEnvironmentOf(doc).aoFluence;
    let fluence: ResolvedInput;
    if (params.fluence !== undefined) {
      if (blank(params.fluence.source))
        return fail('ENV_SOURCE_MISSING', 'the fluence needs its source (mission analysis)', 'fluence.source');
      fluence = {
        value: params.fluence.value * FLUENCE_TO_CM2[params.fluence.unit],
        unit: 'atoms/cm^2',
        source: params.fluence.source,
        unverified: false,
      };
    } else if (missionFluence !== undefined) {
      fluence = {
        value: missionFluence.value * FLUENCE_TO_CM2[missionFluence.unit],
        unit: 'atoms/cm^2',
        source: missionFluence.source,
        unverified: false,
      };
    } else return fail('ENV_FLUENCE_UNSET', 'no fluence: give `fluence` or record aoFluence with set_mission_environment', 'fluence');
    if (!(Number.isFinite(fluence.value) && fluence.value >= 0))
      return fail('ENV_PARAM_INVALID', 'the fluence must be finite and >= 0', 'fluence');

    const inputs: Record<string, ReturnType<typeof describeInput>> = {
      erosionYield: describeInput(erosionYield),
      fluence: describeInput(fluence),
    };
    let mass: number | undefined;
    if (params.area !== undefined) {
      const area = givenInput(params.area, 'cm^2', 'area');
      if (isInputProblem(area)) return failFor(area, 'area');
      if (!(area.value > 0)) return fail('ENV_PARAM_INVALID', `area must be > 0 (got ${params.area.value} ${params.area.unit})`, 'area');
      let density: ResolvedInput;
      if (params.density !== undefined) {
        if (blank(params.density.source)) return fail('ENV_SOURCE_MISSING', 'the density needs its source', 'density.source');
        const given = givenInput(params.density, 'g/cm^3', 'density');
        if (isInputProblem(given)) return failFor(given, 'density');
        density = given;
      } else if (params.material !== undefined) {
        const found = materialProperty(doc, ctx, params.material, 'density', 'g/cm^3');
        if ('reason' in found) return failFor(found, 'material');
        density = materialInput(found);
      } else return fail('ENV_PROPERTY_MISSING', 'mass loss needs a density: give `density` (with source) or a `material`', 'density');
      if (!(density.value > 0) || !Number.isFinite(density.value))
        return fail('ENV_PARAM_INVALID', 'density must be finite and > 0', 'density');
      inputs['area'] = describeInput({ ...area, unverified: false });
      inputs['density'] = describeInput(density);
      mass = massLossG(density.value, area.value, erosionYield.value, fluence.value);
    }

    const recession = recessionCm(erosionYield.value, fluence.value);
    const unverifiedNames = Object.entries(inputs)
      .filter(([, input]) => input.unverified)
      .map(([name]) => name);
    if (unverifiedNames.length > 0) items.push(unverifiedItem(`input ${unverifiedNames.join(', ')}`));
    const data = {
      recessionUm: recession * UM_PER_CM,
      recessionCm: recession,
      ...(mass === undefined ? {} : { massLossG: mass }),
      inputs,
      items,
      unverified: unverifiedNames.length > 0,
    };
    return report(
      doc,
      `${COMMAND}: recession ${(recession * UM_PER_CM).toPrecision(9)} um (Ey ${erosionYield.value} cm^3/atom x F ${fluence.value} atoms/cm^2)${mass === undefined ? '' : `; mass loss ${mass.toPrecision(9)} g`}. ${data.unverified ? `Unverified inputs: ${unverifiedNames.join(', ')}.` : 'All inputs sourced.'}`,
      data,
    );
  },
});
