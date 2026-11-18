import type { CommandResult } from '@core/commands/types';
import type { PipeLine } from '@aec/plant/types';
import type { CadDocument } from '@core/model/types';
import { heatLossPerMetre } from '../heatLoss';
import { getPiping, refuse } from '../model';
import { deriveRun } from '../routeParts';
import { isMiss, type SpecLookup } from '../specLookup';

export interface HeatLossParams {
  readonly lineId: string;
  readonly fluidTempC: number;
  readonly ambientTempC: number;
  readonly outsideFilmWm2K: number;
  readonly insideFilmWm2K?: number | undefined;
  readonly steelConductivityWmK: number;
  readonly insulationConductivityWmK?: number | undefined;
  readonly outsideEmissivity?: number | undefined;
  readonly insulationConductivitySlopeWmK2?: number | undefined;
  readonly insulationConductivityRefTempC?: number | undefined;
}

export interface InputIssue {
  readonly path: string;
  readonly why: string;
}

/** The first input that is out of range or inconsistent, in checking order. */
export function inputIssue(params: HeatLossParams): InputIssue | undefined {
  for (const [path, value] of [
    ['outsideFilmWm2K', params.outsideFilmWm2K],
    ['steelConductivityWmK', params.steelConductivityWmK],
    ['insideFilmWm2K', params.insideFilmWm2K],
    ['insulationConductivityWmK', params.insulationConductivityWmK],
  ] as const)
    if (value !== undefined && !(value > 0)) return { path, why: `${path} must be > 0 (got ${value})` };
  if (params.outsideEmissivity !== undefined && !(params.outsideEmissivity > 0 && params.outsideEmissivity <= 1))
    return { path: 'outsideEmissivity', why: `outsideEmissivity must be in (0, 1] (got ${params.outsideEmissivity})` };
  if (params.insulationConductivitySlopeWmK2 !== undefined && !Number.isFinite(params.insulationConductivitySlopeWmK2))
    return { path: 'insulationConductivitySlopeWmK2', why: 'insulationConductivitySlopeWmK2 must be a finite number' };
  if ((params.insulationConductivitySlopeWmK2 === undefined) !== (params.insulationConductivityRefTempC === undefined))
    return {
      path: 'insulationConductivityRefTempC',
      why: 'insulationConductivitySlopeWmK2 and insulationConductivityRefTempC go together (the temperature at which the conductivity holds)',
    };
  return undefined;
}

export interface Defaulted {
  readonly insulationK: number;
  readonly defaults: Array<{ input: string; assumed: string }>;
}

/** The insulation conductivity (given, else the spec row) and the defaults noted so far; the refusal when the spec has none. */
export function insulationConductivity(
  doc: CadDocument,
  line: PipeLine,
  lookup: SpecLookup,
  params: HeatLossParams,
): Defaulted | CommandResult {
  const defaults: Array<{ input: string; assumed: string }> = [];
  const insulation = line.insulation;
  let insulationK = params.insulationConductivityWmK ?? 0;
  if (insulation !== undefined && params.insulationConductivityWmK === undefined) {
    const row = line.designTempC === undefined ? undefined : lookup.insulation(insulation.code, line.dn, line.designTempC);
    const fromSpec = row === undefined || isMiss(row) ? null : row.conductivityWmK;
    if (fromSpec === null)
      return refuse(
        doc,
        'line_heat_loss',
        'RTE_SPEC_NO_COMPONENT',
        `insulation conductivity of line ${line.lineNumber}: the spec insulation table has no conductivity for code ${insulation.code} (or the line has no design temperature); pass insulationConductivityWmK`,
        [line.id],
        ['insulationConductivityWmK'],
      );
    insulationK = fromSpec;
    defaults.push({
      input: 'insulationConductivityWmK',
      assumed: `${fromSpec} W/mK from the spec insulation row ${insulation.row ?? insulation.code}`,
    });
  }
  if (params.insideFilmWm2K === undefined)
    defaults.push({ input: 'insideFilmWm2K', assumed: 'neglected: inside film resistance taken as 0 (h_i infinite)' });
  if (insulation === undefined) defaults.push({ input: 'insulation', assumed: 'the line has none: bare pipe, D2 = D1' });
  return { insulationK, defaults };
}

export type HeatLossBase = Omit<Parameters<typeof heatLossPerMetre>[0], 'fluidTempC'>;

/** The inputs of the per-metre heat loss that do not depend on the fluid temperature. */
export function heatLossBase(params: HeatLossParams, line: PipeLine, od: number, wall: number, insulationK: number): HeatLossBase {
  const insulation = line.insulation;
  return {
    ambientTempC: params.ambientTempC,
    outsideDiameterMm: od,
    wallMm: wall,
    insulationThicknessMm: insulation?.thicknessMm ?? 0,
    steelConductivityWmK: params.steelConductivityWmK,
    insulationConductivityWmK: insulationK,
    outsideFilmWm2K: params.outsideFilmWm2K,
    insideFilmWm2K: params.insideFilmWm2K ?? null,
    ...(params.outsideEmissivity === undefined ? {} : { emissivity: params.outsideEmissivity }),
    ...(params.insulationConductivitySlopeWmK2 === undefined || insulation === undefined
      ? {}
      : {
          conductivitySlopeWmK2: params.insulationConductivitySlopeWmK2,
          conductivityRefTempC: params.insulationConductivityRefTempC as number,
        }),
  };
}

/** Centreline length (mm) of the runs of `line` that derive, and the ids of those that do not. */
export function routedLength(doc: CadDocument, line: PipeLine): { lengthMm: number; skipped: string[] } {
  const piping = getPiping(doc);
  let lengthMm = 0;
  const skipped: string[] = [];
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    if (run?.lineId !== line.id) continue;
    const derivation = deriveRun(doc, run);
    if (derivation.ok) lengthMm += derivation.centrelineLengthMm;
    else skipped.push(runId);
  }
  return { lengthMm, skipped };
}

/** The tracing facts of the line: the heat loss at the maintain temperature is the heat the tracing must supply. */
export function tracingOf(line: PipeLine, base: HeatLossBase): Record<string, unknown> | null {
  const maintain = line.tracing?.maintainTempC;
  return line.tracing === undefined
    ? null
    : {
        type: line.tracing.type,
        tracers: line.tracing.tracers,
        maintainTempC: maintain ?? null,
        heatLossAtMaintainWPerM: maintain === undefined ? null : heatLossPerMetre({ ...base, fluidTempC: maintain }).heatLossWPerM,
      };
}

/** The method statement of the result. */
export function heatLossProvenance(params: HeatLossParams, pipeRow: string): Record<string, unknown> {
  return {
    formula: "Q' = (Ti - Ta) / [1/(hi pi D0) + ln(D1/D0)/(2 pi ks) + ln(D2/D1)/(2 pi kins) + 1/(ho pi D2)]",
    sources: [
      'Incropera, Fundamentals of Heat and Mass Transfer, ch. 3 (radial systems, critical radius)',
      'ISO 12241 calculation rules for insulation of equipment and pipework',
    ],
    pipeRow,
    model: `steady state, one dimension radial, ${params.insulationConductivitySlopeWmK2 === undefined ? 'constant conductivities' : 'linear k(T) of the insulation at its mean temperature'}, ${params.outsideEmissivity === undefined ? 'no radiation term (the outside film is lumped)' : 'radiation to the ambient linearised at the surface temperature (Stefan-Boltzmann 5.670374419e-8)'}`,
  };
}
