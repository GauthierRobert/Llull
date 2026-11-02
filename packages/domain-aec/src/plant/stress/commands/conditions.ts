/** `set_pipe_operating_conditions`, `set_stress_load_cases` (07 PST M3). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../codes';
import type { OperatingConditions } from '../model/schema';
import { forceSchema, loadCaseSchema, thermalSourceSchema } from '../model/schema';
import { edited, withModel } from '../model/store';
import { defaultLoadCases, loadCaseProblems } from '../solve/cases';
import { thermalStrain } from '../solve/primitives';
import { isRefusal, modelOr } from './common';

const INSTALL_TEMP_C = 21.1;
const CYCLES = 7000;
const POISSON = 0.3;
const STEEL_DENSITY = 7850;

/**
 * @affects plant.stress.models[modelId].conditions: replaced as a whole; the approval is dropped
 * @invariant allowables (ShMPa, ScMPa) and Young's modulus are inputs the engineer reads from the code and the material tables, never defaulted; every default is listed in conditions.defaulted and raises its PST_*_DEFAULTED warning in the analysis; thermal strain is checked for every temperature now, never extrapolated
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown / no-data material or temperature outside its range -> PST_MATERIAL_NOT_FOUND / PST_MATERIAL_NO_DATA / PST_TEMPERATURE_OUT_OF_TABLE; repeated T / P names -> PST_PARAM_INVALID
 */
export const setPipeOperatingConditions = defineCommand({
  name: 'set_pipe_operating_conditions',
  description:
    'Set the operating conditions of a stress model: installation temperature, operating temperatures T1..T9 (degC), pressures P1..P9 (bar g), contents density, corrosion allowance, cycles, and the material. ' +
    'Units: degC, bar g, kg/m3, mm, MPa. Material: youngsModulusMPa (E at the installation temperature, e.g. 203000 for carbon steel in B31.3 App. C), ShMPa (hot allowable) and ScMPa (cold allowable) from the code tables for the design metal temperature, ' +
    'both required and never defaulted; thermal = the source of the free thermal strain from the installation temperature: {table: "carbon-steel-c1"} (built-in mean expansion, 21.1 to 482 degC), {materialId, cteReferenceC?} (a document material with a thermalStrain or cte model) or {meanCtePerK} (a constant secant coefficient, flagged unverified). ' +
    'Named defaults, listed in the result: installTempC 21.1 (70 degF), cycles 7000, corrosionAllowanceMm 0, fluidDensityKgM3 0, poisson 0.3, densityKgM3 7850, ferrousLowStrength false (f cap 1.0), poissonPressure false (pressure acts through the code stress only). ' +
    'Replaces the previous conditions; the thermal strain of every temperature is checked now (a temperature outside the table is refused, never extrapolated). Next: set_stress_load_cases. Returns data { modelId, defaulted, strains }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    installTempC: z.number().describe('Installation (cold) temperature in degC. Default 21.1 (70 degF).').optional(),
    temperatures: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^T[1-9]$/)
            .describe('T1 .. T9'),
          tempC: z.number().describe('Metal temperature in degC.'),
        }),
      )
      .describe('Operating metal temperatures; T1 is the one the b31.3-default preset uses.'),
    pressures: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^P[1-9]$/)
            .describe('P1 .. P9'),
          gaugeBar: z.number().min(0).describe('Pressure in bar gauge.'),
        }),
      )
      .describe(
        'Pressures in bar gauge; they enter the longitudinal pressure stress of the code check (P1 is the design pressure the preset uses).',
      )
      .optional(),
    fluidDensityKgM3: z
      .number()
      .min(0)
      .describe('Density of the contents in kg/m3 for the weight case (water 1000, empty 0). Default 0.')
      .optional(),
    corrosionAllowanceMm: z
      .number()
      .min(0)
      .describe('Corrosion allowance in mm, taken off the wall for sustained and occasional stress. Default 0.')
      .optional(),
    cycles: z
      .number()
      .min(1)
      .describe('Full-range thermal cycles over the life, for the stress range reduction factor f. Default 7000.')
      .optional(),
    wallMm: z
      .number()
      .positive()
      .describe('Nominal wall in mm for every pipe; omit to use the wall of each pipe spec binding / RTE run.')
      .optional(),
    poissonPressure: z
      .boolean()
      .describe('Add the Poisson contraction from the hoop stress as a free axial strain of each pressure load. Default false.')
      .optional(),
    material: z
      .object({
        youngsModulusMPa: z.number().positive().describe('Young modulus in MPa at the installation temperature.'),
        ShMPa: z.number().positive().describe('Allowable stress S_h at the maximum metal temperature, MPa (code table value).'),
        ScMPa: z.number().positive().describe('Allowable stress S_c at the minimum metal temperature, MPa (code table value).'),
        thermal: thermalSourceSchema.describe(
          'Thermal strain source: {table:"carbon-steel-c1"} | {materialId, cteReferenceC?} | {meanCtePerK}.',
        ),
        poisson: z.number().gt(0).lt(0.5).describe('Poisson ratio. Default 0.3.').optional(),
        densityKgM3: z.number().positive().describe('Pipe material density in kg/m3. Default 7850.').optional(),
        ferrousLowStrength: z
          .boolean()
          .describe('Ferrous with SMTS <= 517 MPa and metal temperature <= 371 degC (lifts the cap of f to 1.2 in B31.3). Default false.')
          .optional(),
      })
      .describe('Material of the pipe: Young modulus, allowables S_h and S_c, thermal strain source, optional Poisson ratio and density.'),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'set_pipe_operating_conditions', params.modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, paths: readonly string[]): CommandResult =>
      refuse(doc, 'set_pipe_operating_conditions', code, message, [model.id], paths);
    for (const [list, label] of [
      [params.temperatures.map((entry) => entry.name), 'temperatures'],
      [(params.pressures ?? []).map((entry) => entry.name), 'pressures'],
    ] as const)
      if (new Set(list).size !== list.length) return fail('PST_PARAM_INVALID', `${label} repeat a name`, [label]);
    const defaulted = [
      ...(params.installTempC === undefined ? ['installTempC'] : []),
      ...(params.cycles === undefined ? ['cycles'] : []),
      ...(params.corrosionAllowanceMm === undefined ? ['corrosionAllowanceMm'] : []),
      ...(params.fluidDensityKgM3 === undefined ? ['fluidDensityKgM3'] : []),
      ...(params.material.poisson === undefined ? ['material.poisson'] : []),
      ...(params.material.densityKgM3 === undefined ? ['material.densityKgM3'] : []),
      ...(params.material.ferrousLowStrength === undefined ? ['material.ferrousLowStrength'] : []),
      ...(params.poissonPressure === undefined ? ['poissonPressure'] : []),
    ];
    const conditions: OperatingConditions = {
      installTempC: params.installTempC ?? INSTALL_TEMP_C,
      temperatures: params.temperatures,
      pressures: params.pressures ?? [],
      fluidDensityKgM3: params.fluidDensityKgM3 ?? 0,
      corrosionAllowanceMm: params.corrosionAllowanceMm ?? 0,
      cycles: params.cycles ?? CYCLES,
      ...(params.wallMm === undefined ? {} : { wallMm: params.wallMm }),
      poissonPressure: params.poissonPressure ?? false,
      material: {
        youngsModulusMPa: params.material.youngsModulusMPa,
        ShMPa: params.material.ShMPa,
        ScMPa: params.material.ScMPa,
        thermal: params.material.thermal,
        poisson: params.material.poisson ?? POISSON,
        densityKgM3: params.material.densityKgM3 ?? STEEL_DENSITY,
        ferrousLowStrength: params.material.ferrousLowStrength ?? false,
      },
      defaulted,
    };
    if (conditions.wallMm !== undefined && !(conditions.wallMm - conditions.corrosionAllowanceMm > 0.1))
      return fail(
        'PST_CORROSION_EXCEEDS_WALL',
        `corrosion allowance ${conditions.corrosionAllowanceMm} mm leaves no wall of the ${conditions.wallMm} mm wall`,
        ['corrosionAllowanceMm'],
      );
    const strains: Record<string, number> = {};
    for (const entry of conditions.temperatures) {
      const strain = thermalStrain(doc, conditions, entry.tempC);
      if (!strain.ok) return fail(strain.code, strain.message, [strain.path === 'conditions' ? 'temperatures' : strain.path]);
      strains[entry.name] = strain.strain;
    }
    return {
      ...changed(
        withModel(doc, edited(model, { conditions })),
        `set_pipe_operating_conditions: ${model.id} ${conditions.temperatures.length} temperature(s), ${conditions.pressures.length} pressure(s); defaulted ${defaulted.join(', ') || 'nothing'}.`,
        [model.id],
      ),
      data: { modelId: model.id, defaulted, strains },
    };
  },
});

/**
 * @affects plant.stress.models[modelId].loadCases and .forces: replaced; the approval is dropped
 * @invariant OPE / SUS / OCC cases are solved from their primitive loads together (never superposed); EXP is the algebraic combination of solved cases (OPE - SUS)
 * @failure unknown model -> PST_MODEL_NOT_FOUND; preset without conditions -> PST_CONDITIONS_MISSING; preset without T1, unknown primitive / case, duplicate name -> PST_LOADCASE_INVALID; force pipe not in the model -> PST_PIPE_NOT_FOUND
 */
export const setStressLoadCases = defineCommand({
  name: 'set_stress_load_cases',
  description:
    'Set the load cases of a stress model. Give preset "b31.3-default" (needs conditions with T1: L1 SUS = W + P1, L2 OPE = W + T1 + P1, L3 EXP = L2 - L1) or `cases`. ' +
    'Types: SUS (sustained, checked against S_h), OPE (operating, displacements and loads), OCC (the full occasional state, checked against 1.33 S_h in B31.3 and 1.15 / 1.2 S_h in B31.1), EXP (displacement stress range, checked against S_A). ' +
    'OPE / SUS / OCC list `basic` primitive loads solved together: W (weight of pipe and contents), T1..T9, P1..P9 (from set_pipe_operating_conditions), F1..F9 (point loads from `forces`). EXP lists `combine` terms { case, factor } over solved cases, e.g. L2 x 1 and L1 x -1. ' +
    'Supports with one-way, gap or friction behaviour are re-evaluated per case. `forces` (optional) defines F1..F9: a force N and moment N.mm in global axes at arc length atMm along a pipe; a given list replaces the model forces. Returns data { modelId, cases }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    preset: z.literal('b31.3-default').describe('Generate the SUS / OPE / EXP set from the conditions. Give this or `cases`.').optional(),
    cases: z.array(loadCaseSchema).min(1).describe('Explicit load cases (name, type, basic or combine).').optional(),
    forces: z.array(forceSchema).describe('Point loads F1..F9; replaces the forces of the model.').optional(),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'set_stress_load_cases', params.modelId);
    if (isRefusal(model)) return model;
    if ((params.preset === undefined) === (params.cases === undefined))
      return refuse(doc, 'set_stress_load_cases', 'PST_PARAM_INVALID', 'give exactly one of preset and cases', [model.id], ['preset']);
    let cases = params.cases;
    if (params.preset !== undefined) {
      if (model.conditions === undefined)
        return refuse(
          doc,
          'set_stress_load_cases',
          'PST_CONDITIONS_MISSING',
          `model ${model.id} has no conditions for the preset`,
          [model.id],
          ['conditions'],
        );
      cases = defaultLoadCases(model.conditions) ?? undefined;
      if (cases === undefined)
        return refuse(
          doc,
          'set_stress_load_cases',
          'PST_LOADCASE_INVALID',
          'the preset needs a temperature T1 in the conditions',
          [model.id],
          ['preset'],
        );
    }
    const forces = params.forces ?? model.forces;
    const stray = forces.filter((force) => !model.scope.ids.includes(force.pipeId));
    if (stray.length > 0)
      return refuse(
        doc,
        'set_stress_load_cases',
        'PST_PIPE_NOT_FOUND',
        `forces on pipes outside the model: ${stray.map((force) => force.pipeId).join(', ')}`,
        stray.map((force) => force.pipeId),
        ['forces'],
      );
    const problems = loadCaseProblems(cases ?? [], forces);
    if (problems.length > 0)
      return refuse(
        doc,
        'set_stress_load_cases',
        'PST_LOADCASE_INVALID',
        problems.map(([path, message]) => `${path}: ${message}`).join('; '),
        [model.id],
        problems.map(([path]) => path),
      );
    return {
      ...changed(
        withModel(doc, edited(model, { loadCases: cases ?? [], forces: [...forces] })),
        `set_stress_load_cases: ${model.id} ${(cases ?? []).map((entry) => `${entry.name} ${entry.type}`).join(', ')}.`,
        [model.id],
      ),
      data: { modelId: model.id, cases },
    };
  },
});
