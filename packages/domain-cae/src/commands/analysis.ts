/** create_analysis / delete_analysis / describe_analysis: the lifecycle of an analysis case. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisInputHash } from '../hash/inputHash';
import { eigenSummaryText } from '../results/summary';
import { trustedRecord, type Trust } from '../shared/trust';
import { analysisOf, caseOf, withoutCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { createdAnalysis, createRefusal } from './analysisCreate';

const ANALYSIS_TYPES = [
  'static',
  'heat_steady',
  'heat_transient',
  'thermo_static',
  'modal',
  'buckling',
  'coupled_temperature_displacement',
  'nonlinear_static',
  'creep',
  'frequency_response',
  'random_response',
  'explicit_dynamics',
  'am_build_distortion',
] as const;
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

/**
 * @affects doc.analysis.cases (adds 1 case; affected: [analysisId])
 * @invariant ids `an-<step>.<k>`; unitSystem follows the document unit; heat_* cases get an empty ThermalSetup, thermo_static a ThermoMechSetup
 *   and a coupled case a ThermoMechSetup holding an empty ThermalSetup (no default reference temperature); defaults are named in the summary
 * @failure factor and factors together or factor < 1 -> FEA_FACTOR_INVALID; modes on another type -> FEA_PARAM_NOT_APPLICABLE; modes outside 1..100 -> FEA_PARAM_INVALID; explicit unitSystem != document unit -> FEA_UNITS_MISMATCH;
 *   thermo_static / coupled without referenceTemperature -> TMC_REFERENCE_TEMPERATURE_MISSING; bad temperature unit -> THM_UNITS_MISMATCH;
 *   frequencyRangeHz on a non-modal type -> FEA_PARAM_NOT_APPLICABLE, a band without min / max or with max <= min or min < 0 -> FEA_PARAM_INVALID;
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
    'frequencies and mode shapes with `modes`, optionally restricted to frequencyRangeHz; needs a material density, loads are ignored; constraints define the supports - a model without supports (free-free) is written with a lower frequency bound of -1 Hz in *FREQUENCY; how ccx treats that bound (it may read it as a shift sigma = (2 pi fmin)^2 rather than a limit below zero) is UNVERIFIED against a real ccx run, and has six rigid-body modes at about 0 Hz, flagged by check_analysis FEA_UNDERCONSTRAINED; results.frequenciesHz, analysis_report data.eigen with mass participation) or buckling ' +
    '(linear eigenvalue buckling of the FIRST load case as reference load, `modes` factors; the critical load is factor x the applied load; ' +
    'results.bucklingFactors; needs constraints and a load) or nonlinear_static (plasticity and/or large displacement with load or displacement steps: set it up with set_nonlinear_controls, set_part_constitutive_set, add_analysis_step and add_curve_probe; results.nonlinear) or creep (a hold at constant loads and temperature while a Norton creep law relaxes / deforms the part, CalculiX *VISCO: set it up with set_creep_step, probe the creep strain with add_result_probe quantity ceeq, then creep_report and check_creep; needs a creep law on the part material, solver calculix) or am_build_distortion (additive-manufacturing residual distortion by the inherent-strain method: layers of the built part are activated one by one, each receiving a stated inherent strain, then released from the plate; set it up with am_build_setup, set_inherent_strain, add_release_step and add_result_probe u_x / u_y / u_z; solver calculix, no loads) or frequency_response (harmonic steady-state response to loads or a base acceleration, CalculiX *STEADY STATE DYNAMICS over the modes) or random_response (response to a base acceleration ASD by modal superposition: rms, 3-sigma peaks, nodal rms field); both need modes or fMaxHz, then set_dynamic_damping, set_frequency_sweep and set_base_excitation (check_structural_dynamics lists what is missing). SAFETY FACTORS: without `factors`/`factor` the aerospace defaults apply ' +
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
        'static | heat_steady | heat_transient | thermo_static | coupled_temperature_displacement | modal | buckling | nonlinear_static | creep | am_build_distortion | frequency_response | random_response.',
      ),
    solver: z
      .enum(['calculix', 'llull_explicit', 'opencourant'])
      .optional()
      .describe(
        'Solver: calculix (default; every implicit type) or llull_explicit (explicit_dynamics only, its default). opencourant is not built.',
      ),
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
    frequencyRangeHz: z
      .object({
        min: z.number().optional().describe('Lowest frequency of interest in Hz, >= 0.'),
        max: z.number().optional().describe('Highest frequency of interest in Hz, > min.'),
      })
      .optional()
      .describe(
        'modal only: restrict the extraction to a frequency band in Hz (CalculiX `*FREQUENCY` n, min, max): at most `modes` frequencies inside the band are returned. Omit for the lowest `modes` frequencies.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const refused = createRefusal(params, doc.units);
    if (refused !== null) return refuseCode(doc, 'create_analysis', refused.code, refused.message, [], refused.paths);
    return createdAnalysis(doc, params);
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
    const eigenText = trust.results === null ? '' : eigenSummaryText(trust.results);
    return report(doc, `describe_analysis: '${analysisId}' (${analysisCase.name}) — ${analysisCase.type}, ${state}${eigenText}.`, {
      case: verifiedView(analysisCase, trust),
      state,
      problem: trust.problem,
      inputHash: { mesh: analysisInputHash(doc, analysisId, 'mesh'), full: analysisInputHash(doc, analysisId, 'full') },
    });
  },
});
