/** create_analysis / delete_analysis / describe_analysis: the lifecycle of an analysis case. */

import type { AnalysisCase, AnalysisType, FactorSet, ThermoMechSetup } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisInputHash } from '../hash/inputHash';
import { trustedRecord, type Trust } from '../shared/trust';
import { analysisOf, caseOf, withCase, withoutCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { loadCaseNameProblem } from '../shared/names';
import { DEFAULT_FACTORS, defaultMeshControls, emptyThermalSetup, unitSystemOf } from '../shared/defaults';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { temperatureProblem } from '../shared/quantity';
import { isDynamicType } from '../dynamics/quantities';

const ANALYSIS_TYPES = [
  'static',
  'heat_steady',
  'heat_transient',
  'thermo_static',
  'modal',
  'buckling',
  'coupled_temperature_displacement',
  'nonlinear_static',
  'frequency_response',
  'random_response',
] as const;
const BUILT: ReadonlySet<AnalysisType> = new Set([
  'static',
  'modal',
  'buckling',
  'heat_steady',
  'heat_transient',
  'thermo_static',
  'coupled_temperature_displacement',
  'nonlinear_static',
  'frequency_response',
  'random_response',
]);
/** Modes extracted for a dynamic case given only fMaxHz (the 05 cap); only the modes up to fMaxHz are used. */
const DYNAMIC_MODES_FOR_FMAX = 100;
const isThermal = (type: AnalysisType): boolean => type === 'heat_steady' || type === 'heat_transient';
/** Types that carry a ThermoMechSetup (stress-free reference temperature). */
const hasThermoMech = (type: AnalysisType): boolean => type === 'thermo_static' || type === 'coupled_temperature_displacement';

const factorsSchema = z.object({
  ultimate: z.number().describe('Ultimate factor on limit loads (14 CFR 25.303 uses 1.5). Must be >= 1.'),
  yield: z.number().describe('Yield factor (1.0 = no detrimental permanent deformation at limit). Must be >= 1.'),
  extra: z
    .array(
      z.object({
        name: z.string().describe('Name of the additional factor, e.g. "fitting factor".'),
        value: z.number().describe('Factor value, >= 1.'),
        justification: z.string().describe('Mandatory reason / source of the factor.'),
      }),
    )
    .optional()
    .describe('Additional multiplicative factors, each with a justification.'),
});

function factorProblem(input: z.output<typeof factorsSchema>): string | null {
  const { ultimate, yield: yieldFactor, extra = [] } = input;
  if (!(ultimate >= 1) || !(yieldFactor >= 1)) return 'ultimate and yield factors must be >= 1';
  const bad = extra.find((factor) => !(factor.value >= 1) || factor.justification.trim() === '' || factor.name.trim() === '');
  return bad === undefined ? null : `extra factor '${bad.name}' needs name, value >= 1 and a justification`;
}

const plain = (value: number): string => String(Math.round(value * 1e6) / 1e6);

/**
 * @affects doc.analysis.cases (adds 1 case; affected: [analysisId])
 * @invariant ids `an-<step>.<k>`; unitSystem follows the document unit; heat_* cases get an empty ThermalSetup, thermo_static a ThermoMechSetup
 *   and a coupled case a ThermoMechSetup holding an empty ThermalSetup (no default reference temperature); defaults are named in the summary
 * @failure factor and factors together or factor < 1 -> FEA_FACTOR_INVALID; modes on another type -> FEA_PARAM_NOT_APPLICABLE; modes outside 1..100 -> FEA_PARAM_INVALID; explicit unitSystem != document unit -> FEA_UNITS_MISMATCH;
 *   thermo_static / coupled without referenceTemperature -> TMC_REFERENCE_TEMPERATURE_MISSING; bad temperature unit -> THM_UNITS_MISMATCH;
 *   factor < 1 -> FEA_FACTOR_INVALID; temperature params on a type that has no use for them -> FEA_PARAM_NOT_APPLICABLE (all refusals, unchanged doc)
 */
export const createAnalysis = defineCommand({
  name: 'create_analysis',
  description:
    'Create a finite-element analysis case (CalculiX) in the document and return its id in affected[0]. analysisType: static (linear ' +
    'structural), heat_steady / heat_transient (thermal conduction, convection, radiation) or thermo_static (structural response to a ' +
    'temperature field; REQUIRES referenceTemperature, the stress-free temperature, no default) or coupled_temperature_displacement ' +
    '(steady-state heat conduction and thermal stress solved together: thermal boundary conditions with add_thermal_bc, mechanical ones with ' +
    'add_fea_constraint / add_fea_load, REQUIRES referenceTemperature; the temperature field is solved, not set), modal (free-vibration natural ' +
    'frequencies and mode shapes with `modes`; needs constraints and a material density, loads are ignored; results.frequenciesHz) or buckling ' +
    '(linear eigenvalue buckling of the FIRST load case as reference load, `modes` factors; the critical load is factor x the applied load; ' +
    'results.bucklingFactors; needs constraints and a load) or nonlinear_static (plasticity and/or large displacement with load or displacement steps: set it up with set_nonlinear_controls, set_part_constitutive_set, add_analysis_step and add_curve_probe; results.nonlinear) or frequency_response (harmonic steady-state response to loads or a base acceleration, CalculiX *STEADY STATE DYNAMICS over the modes) or random_response (response to a base acceleration ASD by modal superposition: rms, 3-sigma peaks, nodal rms field); both need modes or fMaxHz, then set_dynamic_damping, set_frequency_sweep and set_base_excitation (check_structural_dynamics lists what is missing). SAFETY FACTORS: without `factors`/`factor` the aerospace defaults apply ' +
    '(ultimate 1.5 per 14 CFR 25.303, yield 1.0) and the summary says so; when the user states a safety factor (e.g. "SF 2") pass `factor: 2` ' +
    '(one number applied to both ultimate and yield) or `factors` { ultimate, yield } - compute_margins applies exactly these. unitSystem follows the document unit (mm: N-mm-t-s, m: N-m-kg-s, in: lbf-in-slinch-s) and a different one is ' +
    'refused. The case starts with the default mesh (tet, quadratic, 10 mm) and no parts: next set_part_idealization, then ' +
    'add_fea_constraint / add_fea_load (or the thermal commands), set_mesh_controls, and the host runs fea_mesh then fea_solve. ' +
    'describe_analysis shows the case at any time.',
  params: z.object({
    name: z.string().min(1).describe('Display name of the analysis, e.g. "bracket under 500 N".'),
    analysisType: z
      .enum(ANALYSIS_TYPES)
      .describe(
        'static | heat_steady | heat_transient | thermo_static | coupled_temperature_displacement | modal | buckling | nonlinear_static | frequency_response | random_response.',
      ),
    solver: z.enum(['calculix']).optional().describe('Solver; only calculix is built (default).'),
    unitSystem: z
      .enum(['N-mm-t-s', 'N-m-kg-s', 'lbf-in-slinch-s'])
      .optional()
      .describe('Unit system of loads and results. Default follows the document unit; an explicit value that disagrees is refused.'),
    temperatureScale: z
      .enum(['degC', 'K'])
      .optional()
      .describe('Scale temperatures are reported in (thermal, thermo_static and coupled cases only). Default degC, recorded in the case.'),
    referenceTemperature: quantitySchema
      .optional()
      .describe(
        'thermo_static and coupled_temperature_displacement ONLY, REQUIRED there: stress-free (reference) temperature, e.g. { value: 20, unit: "degC" }.',
      ),
    loadCaseName: z
      .string()
      .optional()
      .describe(
        'thermo_static and coupled only: name of the load case that carries the thermal load (1-40 letters, digits or underscores). Default "thermal".',
      ),
    factors: factorsSchema
      .optional()
      .describe('Safety factors; omit for the defaults (ultimate 1.5, yield 1.0, no extra). When given, state both ultimate and yield.'),
    factor: z
      .number()
      .optional()
      .describe(
        'Shorthand for the user-stated safety factor: ONE number >= 1 applied to both ultimate and yield (e.g. 2 for "SF 2"). Use factors instead for different values or extra factors; giving both is refused.',
      ),
    modes: z
      .number()
      .int()
      .optional()
      .describe(
        'modal / buckling / frequency_response / random_response: number of modes (natural frequencies) or buckling factors to extract, 1 to 100. Default 6 (modal) or 3 (buckling); dynamic cases have no default (give modes or fMaxHz).',
      ),
    fMaxHz: z
      .number()
      .optional()
      .describe(
        'frequency_response / random_response only: highest frequency of interest in Hz; modes above it are not used. Without modes, 100 modes are extracted.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'create_analysis', code, message, ids, paths);
    const { name, analysisType: type, referenceTemperature, loadCaseName, temperatureScale } = params;
    if (!BUILT.has(type)) return fail('FEA_ANALYSIS_TYPE_UNSUPPORTED', `analysisType '${type}' is not built`, [], ['analysisType']);
    const unitSystem = unitSystemOf(doc.units);
    if (params.unitSystem !== undefined && params.unitSystem !== unitSystem)
      return fail(
        'FEA_UNITS_MISMATCH',
        `unitSystem '${params.unitSystem}' disagrees with document unit '${doc.units}' (${unitSystem})`,
        [],
        ['unitSystem'],
      );
    const thermalUse = isThermal(type) || hasThermoMech(type);
    if (temperatureScale !== undefined && !thermalUse)
      return fail('FEA_PARAM_NOT_APPLICABLE', `temperatureScale does not apply to a '${type}' analysis`, [], ['temperatureScale']);
    if ((referenceTemperature !== undefined || loadCaseName !== undefined) && !hasThermoMech(type))
      return fail(
        'FEA_PARAM_NOT_APPLICABLE',
        `referenceTemperature / loadCaseName apply to thermo_static and coupled_temperature_displacement only`,
        [],
        ['referenceTemperature'],
      );
    if (hasThermoMech(type) && referenceTemperature === undefined)
      return fail('TMC_REFERENCE_TEMPERATURE_MISSING', `a ${type} analysis needs referenceTemperature`, [], ['referenceTemperature']);
    const temperature = referenceTemperature === undefined ? null : temperatureProblem(referenceTemperature);
    if (temperature !== null) return fail('THM_UNITS_MISMATCH', temperature, [], ['referenceTemperature']);
    const caseNameProblem = loadCaseName === undefined ? null : loadCaseNameProblem(loadCaseName);
    if (caseNameProblem !== null) return fail('FEA_LOAD_INVALID', caseNameProblem, [], ['loadCaseName']);
    const factorError = params.factors === undefined ? null : factorProblem(params.factors);
    if (factorError !== null) return fail('FEA_FACTOR_INVALID', factorError, [], ['factors']);
    if (params.factor !== undefined && params.factors !== undefined)
      return fail('FEA_FACTOR_INVALID', 'give either factor (one number) or factors { ultimate, yield }, not both', [], ['factor']);
    if (params.factor !== undefined && !(params.factor >= 1))
      return fail('FEA_FACTOR_INVALID', `factor ${params.factor} must be a number >= 1`, [], ['factor']);
    const dynamic = isDynamicType(type);
    const eigen = type === 'modal' || type === 'buckling' || dynamic;
    if (params.modes !== undefined && !eigen)
      return fail('FEA_PARAM_NOT_APPLICABLE', `modes applies to modal, buckling and dynamic analyses only, not ${type}`, [], ['modes']);
    if (params.fMaxHz !== undefined && !dynamic)
      return fail('FEA_PARAM_NOT_APPLICABLE', `fMaxHz applies to frequency_response and random_response only, not ${type}`, [], ['fMaxHz']);
    if (dynamic && params.modes === undefined && params.fMaxHz === undefined)
      return fail('DYN_BASIS_MISSING', `a ${type} analysis needs modes or fMaxHz (the modal basis has no default)`, [], ['modes']);
    if (params.fMaxHz !== undefined && !(params.fMaxHz > 0 && Number.isFinite(params.fMaxHz)))
      return fail('FEA_PARAM_INVALID', `fMaxHz ${params.fMaxHz} must be > 0`, [], ['fMaxHz']);
    if (params.modes !== undefined && !(params.modes >= 1 && params.modes <= 100))
      return fail('FEA_PARAM_INVALID', `modes ${params.modes} must be an integer from 1 to 100`, [], ['modes']);

    const scale = temperatureScale ?? 'degC';
    const factors: FactorSet =
      params.factor !== undefined
        ? { ultimate: params.factor, yield: params.factor, extra: [] }
        : params.factors === undefined
          ? DEFAULT_FACTORS
          : { ultimate: params.factors.ultimate, yield: params.factors.yield, extra: params.factors.extra ?? [] };
    const modes = params.modes ?? (type === 'modal' ? 6 : type === 'buckling' ? 3 : dynamic ? DYNAMIC_MODES_FOR_FMAX : undefined);
    const thermomech: ThermoMechSetup | undefined =
      hasThermoMech(type) && referenceTemperature !== undefined
        ? {
            referenceTemperature,
            temperatureScale: scale,
            loadCaseName: loadCaseName ?? 'thermal',
            ...(type === 'coupled_temperature_displacement' ? { thermal: emptyThermalSetup(scale) } : {}),
          }
        : undefined;
    const mesh = defaultMeshControls(doc.units);
    const id = nextId('an');
    const analysisCase: AnalysisCase = {
      id,
      name,
      type,
      solver: 'calculix',
      unitSystem,
      ...(modes !== undefined ? { modes } : {}),
      factors,
      parts: {},
      constraints: {},
      constraintOrder: [],
      loads: {},
      loadOrder: [],
      mesh,
      probes: {},
      dispositions: {},
      ...(isThermal(type) ? { thermal: emptyThermalSetup(scale) } : {}),
      ...(thermomech !== undefined ? { thermomech } : {}),
      ...(dynamic ? { dynamics: { basis: params.fMaxHz !== undefined ? { fMaxHz: params.fMaxHz } : {} } } : {}),
    };
    const stated = params.factor !== undefined || params.factors !== undefined;
    const extraNote = factors.extra.length > 0 ? ` + ${factors.extra.length} extra` : '';
    const factorNote = `safety factors ultimate ${plain(factors.ultimate)}, yield ${plain(factors.yield)}${extraNote} (${stated ? 'set by the caller' : 'DEFAULT 14 CFR 25.303 - pass factor/factors if the user states another safety factor'})`;
    const modesNote = modes === undefined ? '' : `, ${modes} mode(s)`;
    const scaleNote = thermalUse ? `, temperatureScale ${scale}${temperatureScale === undefined ? ' (default)' : ''}` : '';
    return changed(
      withCase(doc, analysisCase),
      `create_analysis: '${id}' (${name}) — ${type}, calculix, ${unitSystem}${modesNote}${scaleNote}; ${isThermal(type) && !stated ? '' : `${factorNote}; `}mesh default tet order ${mesh.order} globalSize ${plain(mesh.globalSize)} ${doc.units}; no parts yet (next: set_part_idealization).`,
      [id],
    );
  },
});

function inUseBy(doc: CadDocument, analysisId: string): string[] {
  return Object.values(analysisOf(doc).cases)
    .filter((other) => other.id !== analysisId)
    .filter((other) => {
      const field = other.thermomech?.field;
      return field?.kind === 'thermal_result' && field.analysisId === analysisId;
    })
    .map((other) => other.id);
}

/**
 * @affects doc.analysis.cases (removes 1 case, with its mesh/results summaries; affected: [analysisId])
 * @failure unknown id -> FEA_ANALYSIS_NOT_FOUND; read by another case's thermal_result field -> FEA_ANALYSIS_IN_USE
 */
export const deleteAnalysis = defineCommand({
  name: 'delete_analysis',
  description:
    'Delete an analysis case with all its parts, constraints, loads, mesh controls, probes and recorded mesh/result summaries. Refused ' +
    'while another analysis reads its results as a temperature field. The geometry is untouched.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'delete_analysis', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const users = inUseBy(doc, analysisId);
    if (users.length > 0)
      return refuseCode(doc, 'delete_analysis', 'FEA_ANALYSIS_IN_USE', `analyses ${users.join(', ')} read its results`, [
        analysisId,
        ...users,
      ]);
    return changed(withoutCase(doc, analysisId), `delete_analysis: removed '${analysisId}' (${analysisCase.name}).`, [analysisId]);
  },
});

/** The case with its recorded summaries replaced by the ones re-verified against the artifacts (absent when they could not be). */
function verifiedView(analysisCase: AnalysisCase, trust: Trust): AnalysisCase {
  const { meshSummary, results, ...rest } = analysisCase;
  void meshSummary;
  void results;
  return {
    ...rest,
    ...(trust.mesh !== null ? { meshSummary: trust.mesh } : {}),
    ...(trust.results !== null ? { results: trust.results } : {}),
  };
}

/**
 * @invariant read-only; data.state is unmeshed | meshed | solved | stale (recorded artifact input hash != the current one) | missing (no
 *   artifact store, artifact absent or recorded without it) | untrusted (a recorded summary differs from its artifact: FEA_SUMMARY_MISMATCH in
 *   data.problem); the recorded mesh / results summaries are shown only when re-verified against the artifact store (05 §4.1)
 * @failure unknown id -> FEA_ANALYSIS_NOT_FOUND
 */
export const describeAnalysis = defineCommand({
  name: 'describe_analysis',
  description:
    'Read an analysis case: data { case (parts, constraints, loads, mesh controls, probes, thermal / thermomech set-up, recorded mesh and ' +
    'results summaries), state: unmeshed | meshed | solved | stale | missing | untrusted, inputHash { mesh, full }, problem }. The recorded mesh / results summaries are shown only when they match their artifact in the artifact store (otherwise state missing or untrusted and they are omitted). Without analysisId, list every analysis ' +
    '(id, name, type, state). Use it to find ids for update_/delete_ commands and to check whether artifacts are current.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema.optional() }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const port = ctx?.feaArtifacts;
    if (analysisId === undefined) {
      const analyses = analysisOf(doc).caseOrder.flatMap((id) => {
        const analysisCase = caseOf(doc, id);
        return analysisCase === undefined
          ? []
          : [{ id, name: analysisCase.name, type: analysisCase.type, state: trustedRecord(doc, analysisCase, port).state }];
      });
      return report(
        doc,
        `describe_analysis: ${analyses.length} analysis case(s)${analyses.map((a) => ` ${a.id} (${a.type}, ${a.state})`).join(',')}.`,
        { analyses },
      );
    }
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'describe_analysis', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const trust = trustedRecord(doc, analysisCase, port);
    const state = trust.state;
    return report(doc, `describe_analysis: '${analysisId}' (${analysisCase.name}) — ${analysisCase.type}, ${state}.`, {
      case: verifiedView(analysisCase, trust),
      state,
      problem: trust.problem,
      inputHash: { mesh: analysisInputHash(doc, analysisId, 'mesh'), full: analysisInputHash(doc, analysisId, 'full') },
    });
  },
});
