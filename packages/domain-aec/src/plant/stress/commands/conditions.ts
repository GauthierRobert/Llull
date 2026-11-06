/** `set_pipe_operating_conditions`, `set_stress_load_cases` (07 PST M3). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../codes';
import type { OperatingConditions } from '../model/schema';
import { accelerationSchema, displacementSchema, forceSchema, loadCaseSchema, thermalSourceSchema, windSchema } from '../model/schema';
import { edited, withModel } from '../model/store';
import { defaultLoadCases, loadCaseProblems } from '../solve/cases';
import { thermalStrain } from '../solve/primitives';
import { isRefusal, modelOr } from './common';

const INSTALL_TEMP_C = 21.1;
const CYCLES = 7000;
const POISSON = 0.3;
const STEEL_DENSITY = 7850;
const WATER_DENSITY = 1000;

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
    'Optional: insulation {thicknessMm, densityKgM3, claddingKgM2} (weight of the insulation in W and WW), millTolerancePct (deducted from the wall of the sustained, occasional and hydrotest sections; none by default), hydrotest {testPressureBar, allowableMPa, fluidDensityKgM3 (default 1000)} for load cases of type HYD. Named defaults, listed in the result: installTempC 21.1 (70 degF), cycles 7000, corrosionAllowanceMm 0, fluidDensityKgM3 0, poisson 0.3, densityKgM3 7850, ferrousLowStrength false (f cap 1.0), poissonPressure false (pressure acts through the code stress only). ' +
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
    insulation: z
      .object({
        thicknessMm: z.number().positive().describe('Insulation thickness in mm.'),
        densityKgM3: z.number().positive().describe('Insulation density in kg/m3.'),
        claddingKgM2: z.number().min(0).describe('Cladding (jacketing) mass per outer surface area in kg/m2. Default 0.').optional(),
      })
      .describe('Insulation weight added to the weight cases W and WW (not to a valve or flange with a stated weight). Default none.')
      .optional(),
    millTolerancePct: z
      .number()
      .min(0)
      .lt(50)
      .describe(
        'Mill under-tolerance on the wall in percent (12.5 for B36.10 seamless pipe): taken off the wall for the sustained, occasional and hydrotest stress sections, together with the corrosion allowance (not for hydrotest). Default none (nominal wall).',
      )
      .optional(),
    hydrotest: z
      .object({
        testPressureBar: z.number().positive().describe('Hydrotest pressure in bar gauge (primitive HP).'),
        allowableMPa: z
          .number()
          .positive()
          .describe(
            'Stress limit of the hydrotest case in MPa (e.g. 90 % of the yield strength at the test temperature): stated, never defaulted.',
          ),
        fluidDensityKgM3: z.number().positive().describe('Density of the test water in kg/m3. Default 1000.').optional(),
      })
      .describe('Hydrotest conditions for load cases of type HYD (primitives WW and HP). Default none.')
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
      ...(params.hydrotest !== undefined && params.hydrotest.fluidDensityKgM3 === undefined ? ['hydrotest.fluidDensityKgM3'] : []),
    ];
    const conditions: OperatingConditions = {
      installTempC: params.installTempC ?? INSTALL_TEMP_C,
      temperatures: params.temperatures,
      pressures: params.pressures ?? [],
      fluidDensityKgM3: params.fluidDensityKgM3 ?? 0,
      corrosionAllowanceMm: params.corrosionAllowanceMm ?? 0,
      cycles: params.cycles ?? CYCLES,
      ...(params.wallMm === undefined ? {} : { wallMm: params.wallMm }),
      ...(params.insulation === undefined
        ? {}
        : { insulation: { ...params.insulation, claddingKgM2: params.insulation.claddingKgM2 ?? 0 } }),
      ...(params.millTolerancePct === undefined ? {} : { millTolerancePct: params.millTolerancePct }),
      ...(params.hydrotest === undefined
        ? {}
        : { hydro: { ...params.hydrotest, fluidDensityKgM3: params.hydrotest.fluidDensityKgM3 ?? WATER_DENSITY } }),
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
    if (
      conditions.wallMm !== undefined &&
      !(conditions.wallMm * (1 - (conditions.millTolerancePct ?? 0) / 100) - conditions.corrosionAllowanceMm > 0.1)
    )
      return fail(
        'PST_CORROSION_EXCEEDS_WALL',
        `corrosion allowance ${conditions.corrosionAllowanceMm} mm and mill tolerance ${conditions.millTolerancePct ?? 0} % leave no wall of the ${conditions.wallMm} mm wall`,
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
    'Types: SUS (sustained, checked against S_h), HYD (hydrotest, checked against the stated hydrotest allowable of the conditions), OPE (operating, displacements and loads), OCC (the full occasional state, checked against 1.33 S_h in B31.3 and 1.15 / 1.2 S_h in B31.1), EXP (displacement stress range, checked against S_A). ' +
    'OPE / SUS / OCC list `basic` primitive loads solved together: W (weight of pipe and contents), T1..T9, P1..P9 (from set_pipe_operating_conditions), F1..F9 (point loads from `forces`), WIN1..WIN9 (wind from `wind`), U1..U9 (static acceleration, seismic, from `seismic`), D1..D9 (imposed anchor displacements from `displacements`: the node must be an anchor), WW (weight with the hydrotest water instead of the contents) and HP (the hydrotest pressure), the last two for HYD cases. EXP lists `combine` terms { case, factor } over solved cases, e.g. L2 x 1 and L1 x -1. An OCC case may instead list `combine` terms with a `method`: algebraic (add the results with their factors, then the code stress), scalar (add the code stresses of the terms: the B31.3 occasional check S_L(sustained) + S_L(wind) <= 1.33 S_h is combine [SUS x 1, WIND x 1] scalar) or srss (root of the sum of the squares of the term stresses); scalar and srss are evaluated at the element end stations (nodes). ' +
    'Supports with one-way, gap or friction behaviour are re-evaluated per case. `displacements` (optional) defines D1..D9: translation mm and rotation degrees at an anchor, e.g. a vessel nozzle growing in the operating case; a given list replaces the model displacements. `forces` (optional) defines F1..F9: a force N and moment N.mm in global axes at arc length atMm along a pipe; a given list replaces the model forces. `wind` (optional) defines WIN1..WIN9: the design velocity pressure q in kPa, the drag coefficient Cf and the direction the wind blows toward; every element carries the cross-flow drag q Cf (OD + 2 insulation) |w_n| w_n per length (w_n the wind component normal to the element axis), so an element along the wind carries nothing. `seismic` (optional) defines U1..U9: static accelerations as fractions of g along [x, y, z]; the load is the factor times the weight of pipe, contents, insulation and stated component weights, in that direction (run the +/- directions as separate cases). Both replace the lists of the model. Returns data { modelId, cases }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    preset: z.literal('b31.3-default').describe('Generate the SUS / OPE / EXP set from the conditions. Give this or `cases`.').optional(),
    cases: z.array(loadCaseSchema).min(1).describe('Explicit load cases (name, type, basic or combine).').optional(),
    forces: z.array(forceSchema).describe('Point loads F1..F9; replaces the forces of the model.').optional(),
    wind: z.array(windSchema).describe('Wind loads WIN1..WIN9; replaces the wind loads of the model.').optional(),
    seismic: z.array(accelerationSchema).describe('Static acceleration loads U1..U9 (seismic); replaces the model list.').optional(),
    displacements: z
      .array(displacementSchema)
      .describe(
        'Imposed displacements D1..D9 of anchors (anchor movement, equipment nozzle growth): translation mm and rotation degrees at a node that is an anchor; replaces the displacements of the model.',
      )
      .optional(),
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
    const displacements = params.displacements ?? model.displacements;
    const lost = displacements.flatMap((moved) =>
      'pipeId' in moved.at && !model.scope.ids.includes(moved.at.pipeId) ? [moved.at.pipeId] : [],
    );
    if (lost.length > 0)
      return refuse(
        doc,
        'set_stress_load_cases',
        'PST_PIPE_NOT_FOUND',
        `displacements on pipes outside the model: ${lost.join(', ')}`,
        lost,
        ['displacements'],
      );
    const wind = params.wind ?? model.wind;
    const seismic = params.seismic ?? model.seismic;
    const problems = loadCaseProblems(cases ?? [], forces, displacements, wind, seismic);
    for (const [label, names] of [
      ['wind', wind.map((entry) => entry.name)],
      ['seismic', seismic.map((entry) => entry.name)],
    ] as const)
      names.forEach((name, index) => {
        if (names.indexOf(name) !== index) problems.push([label, `duplicate ${name}`]);
      });
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
        withModel(
          doc,
          edited(model, {
            loadCases: cases ?? [],
            forces: [...forces],
            displacements: [...displacements],
            wind: [...wind],
            seismic: [...seismic],
          }),
        ),
        `set_stress_load_cases: ${model.id} ${(cases ?? []).map((entry) => `${entry.name} ${entry.type}`).join(', ')}.`,
        [model.id],
      ),
      data: { modelId: model.id, cases },
    };
  },
});
