/** create_analysis phases: ordered parameter refusals, then the new case and its summary. */

import { round6 } from '@lib/compactNumber';
import type { AnalysisCase, AnalysisType, FactorSet, Q, ThermoMechSetup } from '@core/model/analysis';
import type { CadDocument, DocumentUnit } from '@core/model/types';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { withCase } from '../shared/access';
import { loadCaseNameProblem } from '../shared/names';
import { DEFAULT_FACTORS, defaultMeshControls, emptyThermalSetup, unitSystemOf } from '../shared/defaults';
import { temperatureProblem } from '../shared/quantity';
import { isDynamicType } from '../dynamics/quantities';

const BUILT: ReadonlySet<AnalysisType> = new Set([
  'static',
  'modal',
  'buckling',
  'heat_steady',
  'heat_transient',
  'thermo_static',
  'coupled_temperature_displacement',
  'nonlinear_static',
  'creep',
  'frequency_response',
  'random_response',
  'explicit_dynamics',
  'am_build_distortion',
]);
/** Modes extracted for a dynamic case given only fMaxHz (the 05 cap); only the modes up to fMaxHz are used. */
const DYNAMIC_MODES_FOR_FMAX = 100;
const isThermal = (type: AnalysisType): boolean => type === 'heat_steady' || type === 'heat_transient';
/** Types that carry a ThermoMechSetup (stress-free reference temperature). */
const hasThermoMech = (type: AnalysisType): boolean => type === 'thermo_static' || type === 'coupled_temperature_displacement';

interface Band {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

interface FactorsInput {
  readonly ultimate: number;
  readonly yield: number;
  readonly extra?: readonly { readonly name: string; readonly value: number; readonly justification: string }[] | undefined;
}

/** The validated create_analysis parameters, as the schema outputs them. */
export interface CreateParams {
  readonly name: string;
  readonly analysisType: AnalysisType;
  readonly solver?: 'calculix' | 'llull_explicit' | 'opencourant' | undefined;
  readonly unitSystem?: string | undefined;
  readonly temperatureScale?: 'degC' | 'K' | undefined;
  readonly referenceTemperature?: Q | undefined;
  readonly loadCaseName?: string | undefined;
  readonly factors?: FactorsInput | undefined;
  readonly factor?: number | undefined;
  readonly modes?: number | undefined;
  readonly fMaxHz?: number | undefined;
  readonly frequencyRangeHz?: Band | undefined;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

const refusal = (code: string, message: string, path: string): Refusal => ({ code, message, paths: [path] });

function factorProblem(input: FactorsInput): string | null {
  const { ultimate, yield: yieldFactor, extra = [] } = input;
  if (!(ultimate >= 1) || !(yieldFactor >= 1)) return 'ultimate and yield factors must be >= 1';
  const bad = extra.find((factor) => !(factor.value >= 1) || factor.justification.trim() === '' || factor.name.trim() === '');
  return bad === undefined ? null : `extra factor '${bad.name}' needs name, value >= 1 and a justification`;
}

function bandValid(band: Band): boolean {
  const { min, max } = band;
  if (min === undefined && max === undefined) return false;
  if (min !== undefined && !(Number.isFinite(min) && min >= 0)) return false;
  return max === undefined || (Number.isFinite(max) && max > (min ?? 0));
}

const plain = (value: number): string => String(round6(value));

function solverOf(params: CreateParams): NonNullable<CreateParams['solver']> {
  return params.solver ?? (params.analysisType === 'explicit_dynamics' ? 'llull_explicit' : 'calculix');
}

function solverRefusal(params: CreateParams): Refusal | null {
  const type = params.analysisType;
  const solver = solverOf(params);
  if ((type === 'explicit_dynamics') !== (solver === 'llull_explicit'))
    return refusal(
      'EXP_SOLVER_UNSUPPORTED',
      `solver '${solver}' cannot run a '${type}' analysis (explicit_dynamics: llull_explicit; others: calculix)`,
      'solver',
    );
  if (type === 'am_build_distortion' && solver !== 'calculix')
    return refusal('PRC_SOLVER_UNSUPPORTED', `solver '${solver}' cannot run an am_build_distortion analysis (calculix only)`, 'solver');
  if (type === 'creep' && solver !== 'calculix')
    return refusal('CRP_SOLVER_UNSUPPORTED', `solver '${solver}' cannot run a creep analysis (calculix only)`, 'solver');
  return null;
}

function unitsRefusal(params: CreateParams, units: DocumentUnit): Refusal | null {
  const unitSystem = unitSystemOf(units);
  if (params.unitSystem !== undefined && params.unitSystem !== unitSystem)
    return refusal(
      'FEA_UNITS_MISMATCH',
      `unitSystem '${params.unitSystem}' disagrees with document unit '${units}' (${unitSystem})`,
      'unitSystem',
    );
  return null;
}

function thermalRefusal(params: CreateParams): Refusal | null {
  const { analysisType: type, referenceTemperature, loadCaseName, temperatureScale } = params;
  const thermalUse = isThermal(type) || hasThermoMech(type);
  if (temperatureScale !== undefined && !thermalUse)
    return refusal('FEA_PARAM_NOT_APPLICABLE', `temperatureScale does not apply to a '${type}' analysis`, 'temperatureScale');
  if ((referenceTemperature !== undefined || loadCaseName !== undefined) && !hasThermoMech(type))
    return refusal(
      'FEA_PARAM_NOT_APPLICABLE',
      `referenceTemperature / loadCaseName apply to thermo_static and coupled_temperature_displacement only`,
      'referenceTemperature',
    );
  if (hasThermoMech(type) && referenceTemperature === undefined)
    return refusal('TMC_REFERENCE_TEMPERATURE_MISSING', `a ${type} analysis needs referenceTemperature`, 'referenceTemperature');
  const temperature = referenceTemperature === undefined ? null : temperatureProblem(referenceTemperature);
  if (temperature !== null) return refusal('THM_UNITS_MISMATCH', temperature, 'referenceTemperature');
  const caseNameProblem = loadCaseName === undefined ? null : loadCaseNameProblem(loadCaseName);
  if (caseNameProblem !== null) return refusal('FEA_LOAD_INVALID', caseNameProblem, 'loadCaseName');
  return null;
}

function factorRefusal(params: CreateParams): Refusal | null {
  const factorError = params.factors === undefined ? null : factorProblem(params.factors);
  if (factorError !== null) return refusal('FEA_FACTOR_INVALID', factorError, 'factors');
  if (params.factor !== undefined && params.factors !== undefined)
    return refusal('FEA_FACTOR_INVALID', 'give either factor (one number) or factors { ultimate, yield }, not both', 'factor');
  if (params.factor !== undefined && !(params.factor >= 1))
    return refusal('FEA_FACTOR_INVALID', `factor ${params.factor} must be a number >= 1`, 'factor');
  return null;
}

function modesRefusal(params: CreateParams): Refusal | null {
  const type = params.analysisType;
  const dynamic = isDynamicType(type);
  const eigen = type === 'modal' || type === 'buckling' || dynamic;
  if (params.modes !== undefined && !eigen)
    return refusal('FEA_PARAM_NOT_APPLICABLE', `modes applies to modal, buckling and dynamic analyses only, not ${type}`, 'modes');
  if (params.fMaxHz !== undefined && !dynamic)
    return refusal('FEA_PARAM_NOT_APPLICABLE', `fMaxHz applies to frequency_response and random_response only, not ${type}`, 'fMaxHz');
  if (dynamic && params.modes === undefined && params.fMaxHz === undefined)
    return refusal('DYN_BASIS_MISSING', `a ${type} analysis needs modes or fMaxHz (the modal basis has no default)`, 'modes');
  if (params.fMaxHz !== undefined && !(params.fMaxHz > 0 && Number.isFinite(params.fMaxHz)))
    return refusal('FEA_PARAM_INVALID', `fMaxHz ${params.fMaxHz} must be > 0`, 'fMaxHz');
  if (params.modes !== undefined && !(params.modes >= 1 && params.modes <= 100))
    return refusal('FEA_PARAM_INVALID', `modes ${params.modes} must be an integer from 1 to 100`, 'modes');
  return null;
}

function bandRefusal(params: CreateParams): Refusal | null {
  const band = params.frequencyRangeHz;
  if (band !== undefined && params.analysisType !== 'modal')
    return refusal(
      'FEA_PARAM_NOT_APPLICABLE',
      `frequencyRangeHz applies to modal analyses only, not ${params.analysisType}`,
      'frequencyRangeHz',
    );
  if (band !== undefined && !bandValid(band))
    return refusal('FEA_PARAM_INVALID', 'frequencyRangeHz needs min and / or max (finite), min >= 0 and max > min', 'frequencyRangeHz');
  return null;
}

/** The first failing parameter check, in the order the command documents, or null when every check passes. */
export function createRefusal(params: CreateParams, units: DocumentUnit): Refusal | null {
  if (!BUILT.has(params.analysisType))
    return refusal('FEA_ANALYSIS_TYPE_UNSUPPORTED', `analysisType '${params.analysisType}' is not built`, 'analysisType');
  return (
    solverRefusal(params) ??
    unitsRefusal(params, units) ??
    thermalRefusal(params) ??
    factorRefusal(params) ??
    modesRefusal(params) ??
    bandRefusal(params)
  );
}

function factorsOf(params: CreateParams): FactorSet {
  if (params.factor !== undefined) return { ultimate: params.factor, yield: params.factor, extra: [] };
  if (params.factors === undefined) return DEFAULT_FACTORS;
  return { ultimate: params.factors.ultimate, yield: params.factors.yield, extra: params.factors.extra ?? [] };
}

function modesOf(params: CreateParams): number | undefined {
  const type = params.analysisType;
  return params.modes ?? (type === 'modal' ? 6 : type === 'buckling' ? 3 : isDynamicType(type) ? DYNAMIC_MODES_FOR_FMAX : undefined);
}

function thermomechOf(params: CreateParams, scale: 'degC' | 'K'): ThermoMechSetup | undefined {
  const { analysisType: type, referenceTemperature, loadCaseName } = params;
  return hasThermoMech(type) && referenceTemperature !== undefined
    ? {
        referenceTemperature,
        temperatureScale: scale,
        loadCaseName: loadCaseName ?? 'thermal',
        ...(type === 'coupled_temperature_displacement' ? { thermal: emptyThermalSetup(scale) } : {}),
      }
    : undefined;
}

function bandField(band: Band | undefined): Pick<AnalysisCase, 'frequencyRangeHz'> | Record<string, never> {
  return band !== undefined
    ? { frequencyRangeHz: { ...(band.min !== undefined ? { min: band.min } : {}), ...(band.max !== undefined ? { max: band.max } : {}) } }
    : {};
}

function newCase(
  doc: CadDocument,
  params: CreateParams,
  id: string,
  solver: NonNullable<CreateParams['solver']>,
  factors: FactorSet,
  modes: number | undefined,
  scale: 'degC' | 'K',
): AnalysisCase {
  const type = params.analysisType;
  const thermomech = thermomechOf(params, scale);
  return {
    id,
    name: params.name,
    type,
    solver,
    unitSystem: unitSystemOf(doc.units),
    ...(modes !== undefined ? { modes } : {}),
    ...bandField(params.frequencyRangeHz),
    factors,
    parts: {},
    constraints: {},
    constraintOrder: [],
    loads: {},
    loadOrder: [],
    mesh: defaultMeshControls(doc.units),
    probes: {},
    dispositions: {},
    ...(isThermal(type) ? { thermal: emptyThermalSetup(scale) } : {}),
    ...(thermomech !== undefined ? { thermomech } : {}),
    ...(isDynamicType(type) ? { dynamics: { basis: params.fMaxHz !== undefined ? { fMaxHz: params.fMaxHz } : {} } } : {}),
  };
}

function createSummary(doc: CadDocument, params: CreateParams, analysisCase: AnalysisCase, scale: 'degC' | 'K'): string {
  const { id, name, type, solver, unitSystem, modes, factors, mesh } = analysisCase;
  const band = params.frequencyRangeHz;
  const thermalUse = isThermal(type) || hasThermoMech(type);
  const stated = params.factor !== undefined || params.factors !== undefined;
  const extraNote = factors.extra.length > 0 ? ` + ${factors.extra.length} extra` : '';
  const factorNote = `safety factors ultimate ${plain(factors.ultimate)}, yield ${plain(factors.yield)}${extraNote} (${stated ? 'set by the caller' : 'DEFAULT 14 CFR 25.303 - pass factor/factors if the user states another safety factor'})`;
  const modesNote =
    modes === undefined ? '' : `, ${modes} mode(s)${band === undefined ? '' : ` in ${band.min ?? 0}-${band.max ?? 'inf'} Hz`}`;
  const scaleNote = thermalUse ? `, temperatureScale ${scale}${params.temperatureScale === undefined ? ' (default)' : ''}` : '';
  return `create_analysis: '${id}' (${name}) — ${type}, ${solver}, ${unitSystem}${modesNote}${scaleNote}; ${isThermal(type) && !stated ? '' : `${factorNote}; `}mesh default tet order ${mesh.order} globalSize ${plain(mesh.globalSize)} ${doc.units}; no parts yet (next: set_part_idealization).`;
}

/** The case for validated params, added to the document. */
export function createdAnalysis(doc: CadDocument, params: CreateParams): CommandResult {
  const scale = params.temperatureScale ?? 'degC';
  const factors = factorsOf(params);
  const modes = modesOf(params);
  const id = nextId('an');
  const analysisCase = newCase(doc, params, id, solverOf(params), factors, modes, scale);
  return changed(withCase(doc, analysisCase), createSummary(doc, params, analysisCase, scale), [id]);
}
