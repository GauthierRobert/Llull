/** check_rotor_resonance: Campbell crossings of a solved modal analysis with the k.rpm/60 excitation of the flight model's rotors (14 FLL-M4). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { eigenReport } from '../results/eigenReport';
import { bandMargin, crossingRpm, excitationHz, marginPct } from './campbellMath';
import { CAMPBELL_WIDTH, campbellSvg } from './campbellSvg';
import { refuseFll } from './codes';
import { rotorsOfFlightModel, trimmedRpm } from './rotorSource';

const NAME = 'check_rotor_resonance';
/** Modes at or below this frequency are rigid-body motions of an unrestrained model, not structural modes (eigenReport's absolute floor), Hz. */
const RIGID_BODY_HZ = 1e-3;
const HARMONIC_LIMIT = 100;

type Status = 'pass' | 'fail' | 'unknown';

interface Row {
  rotorId: string;
  harmonic: number;
  label: string;
  mode: number;
  frequencyHz: number;
  crossingRpm: number | null;
  minMarginPct: number | null;
  minMarginAtRpm: number | null;
  atOperating: { rpm: number; excitationHz: number; marginPct: number | null }[];
  status: Status;
  reason: string | null;
}

/** Status of one row: unknown without a band or without a caller-given margin requirement, else pass / fail against it. */
function statusOf(minMargin: number | null, threshold: number | undefined): { status: Status; reason: string | null } {
  if (minMargin === null) return { status: 'unknown', reason: 'no rpm band for this rotor (give rpmBand or a controller / rotor speed)' };
  if (threshold === undefined) return { status: 'unknown', reason: 'no margin requirement given (marginThresholdPct + marginSource)' };
  return minMargin >= threshold ? { status: 'pass', reason: null } : { status: 'fail', reason: `margin below ${threshold} %` };
}

const pct = (value: number | null): string => (value === null ? 'n/a' : `${Number(value.toPrecision(4))} %`);
const sig = (value: number): number => Number(value.toPrecision(5));

/**
 * @affects nothing - read-only; data { rows[], crossings[], rotors[], status, reviewRequired, svg, width, ... }
 * @invariant reads the stored modal results only (state must be solved: a stale or unsolved case is refused); crossing rpm = 60 f / k exactly; margin = |f - k rpm/60| / (k rpm/60);
 *   a row passes only against a caller-given threshold with its source, otherwise it is unknown; a missing rpm band or blade count is unknown, never pass; modal frequencies are taken as rpm-independent
 * @failure unknown analysis, non-modal analysis, unsolved / stale / untrusted results, no flight rotors, unknown rotor or scenario, inverted band, threshold without source, failed trim -> rejected with the FLL / FEA code
 */
export const checkRotorResonance = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'Check a rotor against the modes of a SOLVED modal analysis (14 FLL, Campbell diagram): for each rotor of the flight model (add_rotor), each excitation ' +
    'harmonic k (default 1 and 2 per rev, plus the blade count B when known: blade passing) and each elastic mode, the crossing speed rpm = 60 f / k when it ' +
    'lies inside the rotor rpm band, and the margin |f_mode - f_exc| / f_exc x 100 % with f_exc = k rpm / 60, at the operating speeds and as the smallest value over ' +
    'the band (0 at a crossing). Reads the stored modal frequencies only (create_analysis modal, solved; unsolved or stale results are refused); rigid-body modes (about 0 Hz) are skipped; ' +
    'frequencies are taken as constant with rpm (no centrifugal stiffening or gyroscopic split: the Campbell mode lines are horizontal). The rpm band is the caller rpmBand, else the ' +
    'minRpm..maxRpm of the flight controller commanding the rotor (scenario picks it), else the rotor own constant rpm; the operating speeds are the caller operatingRpm, else the ' +
    'trimmed speed of scenario (trim_flight at airspeedMps / flightPathDeg), else the rotor own rpm when above 0. The blade count is not in the flight model: give bladeCount ' +
    '(all rotors) or bladeCounts (per rotor id), else the blade-passing harmonic is listed as unassessed. The required margin is NEVER defaulted: give marginThresholdPct and ' +
    'marginSource (the requirement it comes from); without them every row is status "unknown" (the crossings and margins are still reported). data: { analysisId, rotors[] { ' +
    'rotorId, bandRpm [low, high] | null, bandSource, operatingRpm[], operatingSource, harmonics[], bladeCount | null }, rows[] { rotorId, harmonic, label, mode, frequencyHz, ' +
    'crossingRpm | null, minMarginPct, minMarginAtRpm, atOperating[] { rpm, excitationHz, marginPct }, status pass|fail|unknown, reason }, crossings[] (rows with a crossing), ' +
    'unassessed[], threshold { pct, source } | null, status (fail if any row fails, else unknown if any row or rotor is unknown, else pass), reviewRequired, svg, width }. ' +
    'data.svg is the Campbell diagram (rpm against Hz: mode lines, k rpm/60 rays, shaded bands, crossings); with the CLI, `--save campbell.svg` writes it (`.png` rasterizes it). ' +
    'plot false omits it. Read-only.',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of a MODAL analysis that is solved (state solved in analysis_report).'),
    rotors: z.array(z.string()).optional().describe('Rotor ids (add_rotor) to check. Default: every rotor of the flight model.'),
    scenario: z
      .string()
      .optional()
      .describe(
        'Flight scenario id (define_flight_scenario): selects the controller whose rpm limits are the band, and the vehicle trimmed for the operating speed when airspeedMps or flightPathDeg is given.',
      ),
    airspeedMps: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe(
        'With scenario: trim_flight airspeed, m/s, to take the operating rpm from the trimmed rotor speeds. Default none: no trim.',
      ),
    flightPathDeg: z
      .number()
      .min(-89)
      .max(89)
      .optional()
      .describe('With scenario: trim flight-path angle, deg (a trim is run when this or airspeedMps is given).'),
    rpmBand: z
      .tuple([z.number().min(0), z.number().positive()])
      .optional()
      .describe('Operating rpm band [low, high] of every checked rotor, overriding the controller / rotor speed. low <= high.'),
    operatingRpm: z
      .array(z.number().positive())
      .optional()
      .describe('Operating speeds in rpm (e.g. hover, cruise) where the margin is also reported; overrides the trim / rotor speed.'),
    harmonics: z
      .array(z.number().int().min(1).max(HARMONIC_LIMIT))
      .optional()
      .describe('Excitation orders k (per-rev multiples). Default [1, 2]; the blade count is added when known.'),
    bladeCount: z
      .number()
      .int()
      .min(1)
      .max(HARMONIC_LIMIT)
      .optional()
      .describe('Blades per rotor, for the blade-passing harmonic of every checked rotor (not stored in the flight model).'),
    bladeCounts: z
      .record(z.string(), z.number().int().min(1).max(HARMONIC_LIMIT))
      .optional()
      .describe('Blades per rotor id; overrides bladeCount for that rotor.'),
    marginThresholdPct: z
      .number()
      .min(0)
      .optional()
      .describe('Required minimum margin, percent. Never defaulted: needs marginSource. Without it every row is unknown.'),
    marginSource: z
      .string()
      .min(1)
      .optional()
      .describe('Where the required margin comes from (standard, customer spec, design rule). Required with marginThresholdPct.'),
    plot: z.boolean().optional().describe('Draw data.svg (default true).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (
      code: string,
      message: string,
      ids: readonly string[] = [params.analysisId],
      paths: readonly string[] = [],
    ): CommandResult => refuseFll(doc, NAME, code, message, ids, paths);
    const analysis = caseOf(doc, params.analysisId);
    if (analysis === undefined)
      return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${params.analysisId}'`, [params.analysisId], ['analysisId']);
    if (analysis.type !== 'modal') return fail('FLL_NOT_MODAL', `analysis '${params.analysisId}' is ${analysis.type}, not modal`);
    if ((params.marginThresholdPct === undefined) !== (params.marginSource === undefined))
      return fail(
        'FLL_THRESHOLD_SOURCE',
        'marginThresholdPct and marginSource go together: a margin requirement needs the source it comes from',
        [params.analysisId],
        ['marginThresholdPct', 'marginSource'],
      );
    if (params.rpmBand !== undefined && params.rpmBand[0] > params.rpmBand[1])
      return fail('FLL_BAND_INVALID', `rpmBand [${params.rpmBand.join(', ')}] has low above high`, [params.analysisId], ['rpmBand']);
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const eigen = trust.resultsArtifact !== null ? eigenReport(analysis, trust.resultsArtifact) : null;
    if (eigen === null || eigen.kind !== 'modal')
      return fail(
        'FLL_MODAL_UNAVAILABLE',
        `the modal results of '${params.analysisId}' are not available (state ${trust.state}${trust.problem === null ? '' : `, ${trust.problem.code}`}): solve the analysis first`,
      );
    const modes = eigen.modes.filter((mode) => Number.isFinite(mode.frequencyHz) && mode.frequencyHz > RIGID_BODY_HZ);
    if (modes.length === 0) return fail('FLL_NO_MODES', 'the modal results hold no elastic mode (frequency above 0.001 Hz)');
    const records = rotorsOfFlightModel(doc, params.scenario, ctx);
    if (typeof records === 'string') return fail('FLL_NO_ROTORS', records);
    const unknown = (params.rotors ?? []).filter((id) => !records.some((rotor) => rotor.id === id));
    if (unknown.length > 0)
      return fail(
        'FLL_ROTOR_UNKNOWN',
        `no rotor ${unknown.map((id) => `'${id}'`).join(', ')} in the flight model`,
        [params.analysisId, ...unknown],
        ['rotors'],
      );
    const rotors = records.filter((rotor) => params.rotors === undefined || params.rotors.includes(rotor.id));
    let trimmed: Record<string, number> = {};
    if (
      params.operatingRpm === undefined &&
      params.scenario !== undefined &&
      (params.airspeedMps !== undefined || params.flightPathDeg !== undefined)
    ) {
      const result = trimmedRpm(
        doc,
        { scenario: params.scenario, airspeedMps: params.airspeedMps, flightPathDeg: params.flightPathDeg },
        ctx,
      );
      if (typeof result === 'string') return fail('FLL_TRIM_FAILED', `trim_flight did not give the operating speeds: ${result}`);
      trimmed = result;
    }
    const threshold = params.marginThresholdPct;
    const baseHarmonics = [...new Set(params.harmonics ?? [1, 2])];
    const rows: Row[] = [];
    const unassessed: { rotorId: string; reason: string }[] = [];
    const bands: { rotorId: string; lowRpm: number; highRpm: number }[] = [];
    const rotorData = rotors.map((rotor) => {
      const band: { low: number; high: number; source: string } | null =
        params.rpmBand !== undefined
          ? { low: params.rpmBand[0], high: params.rpmBand[1], source: 'rpmBand (caller)' }
          : rotor.controllerBand !== null
            ? {
                low: rotor.controllerBand.lowRpm,
                high: rotor.controllerBand.highRpm,
                source: `controller '${rotor.controllerBand.controllerId}' minRpm..maxRpm`,
              }
            : rotor.rpm > 0
              ? { low: rotor.rpm, high: rotor.rpm, source: 'rotor rpm (constant)' }
              : null;
      if (band !== null) bands.push({ rotorId: rotor.id, lowRpm: band.low, highRpm: band.high });
      const trimmedRotor = trimmed[rotor.id];
      const operating: { rpms: number[]; source: string } =
        params.operatingRpm !== undefined
          ? { rpms: [...params.operatingRpm], source: 'operatingRpm (caller)' }
          : trimmedRotor !== undefined
            ? { rpms: [trimmedRotor], source: `trim_flight '${params.scenario ?? ''}'` }
            : rotor.rpm > 0
              ? { rpms: [rotor.rpm], source: 'rotor rpm (constant)' }
              : { rpms: [], source: 'none' };
      const blades = params.bladeCounts?.[rotor.id] ?? params.bladeCount ?? null;
      if (blades === null)
        unassessed.push({
          rotorId: rotor.id,
          reason: 'blade count not given (bladeCount / bladeCounts): the blade-passing harmonic is not checked',
        });
      const orders = [...new Set([...baseHarmonics, ...(blades === null ? [] : [blades])])].sort((a, b) => a - b);
      for (const harmonic of orders)
        for (const mode of modes) {
          const margin = band === null ? null : bandMargin(mode.frequencyHz, harmonic, band.low, band.high);
          rows.push({
            rotorId: rotor.id,
            harmonic,
            label: harmonic === blades ? `${harmonic}P (blade passing)` : `${harmonic}P`,
            mode: mode.mode,
            frequencyHz: mode.frequencyHz,
            crossingRpm: margin?.crossingRpm ?? null,
            minMarginPct: margin?.minMarginPct ?? null,
            minMarginAtRpm: margin?.atRpm ?? null,
            atOperating: operating.rpms.map((rpm) => ({
              rpm,
              excitationHz: excitationHz(harmonic, rpm),
              marginPct: marginPct(mode.frequencyHz, harmonic, rpm),
            })),
            ...statusOf(margin?.minMarginPct ?? null, threshold),
          });
        }
      return {
        rotorId: rotor.id,
        bandRpm: band === null ? null : [band.low, band.high],
        bandSource: band?.source ?? 'none',
        operatingRpm: operating.rpms,
        operatingSource: operating.source,
        harmonics: orders,
        bladeCount: blades,
      };
    });
    const crossings = rows.filter((row) => row.crossingRpm !== null);
    const failed = rows.filter((row) => row.status === 'fail');
    const status: Status =
      failed.length > 0 ? 'fail' : rows.some((row) => row.status === 'unknown') || unassessed.length > 0 ? 'unknown' : 'pass';
    const reviewRequired = status !== 'pass' || trust.resultsArtifact?.binding === 'imported-unbound';
    const svg =
      params.plot === false || bands.length === 0
        ? null
        : campbellSvg(
            {
              modes,
              harmonics: [...new Set(rows.map((row) => row.harmonic))]
                .sort((a, b) => a - b)
                .map((harmonic) => ({ harmonic, label: `${harmonic}P` })),
              bands,
              crossings: crossings.flatMap((row) =>
                row.crossingRpm === null ? [] : [{ rpm: row.crossingRpm, frequencyHz: row.frequencyHz }],
              ),
            },
            `Campbell diagram ${params.analysisId}`,
          );
    const data = {
      analysisId: params.analysisId,
      rotors: rotorData,
      modeCount: modes.length,
      rows,
      crossings,
      unassessed,
      threshold: threshold === undefined ? null : { pct: threshold, source: params.marginSource ?? '' },
      status,
      reviewRequired,
      note: 'modal frequencies are taken as constant with rpm (no centrifugal stiffening, no gyroscopic split); the margin is against the stored modal results only',
      svg,
      width: svg === null ? null : CAMPBELL_WIDTH,
    };
    const worst = rows.reduce<Row | null>(
      (best, row) => (row.minMarginPct !== null && (best === null || row.minMarginPct < (best.minMarginPct ?? Infinity)) ? row : best),
      null,
    );
    const worstText =
      worst === null
        ? ''
        : `; smallest margin ${pct(worst.minMarginPct)} (${worst.rotorId} ${worst.label} mode ${worst.mode} ${sig(worst.frequencyHz)} Hz at ${worst.minMarginAtRpm === null ? 'n/a' : sig(worst.minMarginAtRpm)} rpm; crossing speed ${sig(crossingRpm(worst.frequencyHz, worst.harmonic))} rpm)`;
    const requirement =
      threshold === undefined
        ? '; no margin requirement given: rows are unknown'
        : `; requirement ${threshold} % (${params.marginSource ?? ''})`;
    return report(
      doc,
      `${NAME}: ${status} - ${rotorData.length} rotor(s) x ${modes.length} mode(s), ${rows.length} row(s), ${crossings.length} crossing(s) in the band, ${failed.length} fail${worstText}${requirement}` +
        `${unassessed.length > 0 ? `; ${unassessed.length} rotor(s) without blade count` : ''}; review required: ${reviewRequired}.`,
      data,
    );
  },
});
