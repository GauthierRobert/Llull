/** explicit_report / explicit_energy_check: read-only views of an explicit case and its verified result (PHY-19 §5.4, §5.5, AF-20/21/33). */

import type { ExplicitResultsSummary } from '@core/model/explicit';
import type { NamedValue } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { energyError } from './artifact';
import { refuseExplicit } from './codes';
import { DEFAULT_HOURGLASS_LIMIT, MAX_HISTORY_POINTS } from './defaults';
import { explicitCase } from './model';
import { trustedExplicit } from './trust';

const FORMULATION =
  'central-difference explicit integration with lumped (row-sum) mass and a stable step from the element characteristic length; hex8 one-point ' +
  'uniform-strain element with Flanagan-Belytschko viscous hourglass control (Flanagan & Belytschko 1981, IJNME 17:679-706); tet4 constant ' +
  'strain; hypoelastic Jaumann-rate stress update; J2 radial return with Johnson-Cook flow stress (isothermal, T = Tr); linear + quadratic bulk ' +
  'viscosity; kinematic frictionless planar rigid walls; penalty node-to-segment contact with Coulomb friction (LS-DYNA R14 Ch. 29). ' +
  'Decisions and citations: PHY-19 TECHNICAL_SPEC §13.';

const REVIEW = 'impact response supports structural and certification decisions';

/** Every `step`-th sample so at most `limit` remain (the last sample is kept). */
function thin<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  const step = Math.ceil(values.length / limit);
  const kept = values.filter((_, index) => index % step === 0);
  const last = values[values.length - 1];
  if (last !== undefined && kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

const notFound = (doc: CadDocument, command: string, analysisId: string, code: string, message: string): CommandResult =>
  refuseExplicit(doc, command, code, message, [analysisId]);

/**
 * @invariant read-only; numbers only from a summary RE-VERIFIED against its artifact (state `solved`); reviewRequired true and
 *   certificationEvidence false on every report (VC-EXP-61)
 * @failure unknown / non-explicit case -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE (rejected no-op)
 */
export const explicitReport = defineCommand({
  name: 'explicit_report',
  annotations: { readOnly: true },
  description:
    'Read-only report of an explicit_dynamics case: state (unsolved | solved | stale | missing | untrusted), controls with their named defaults, ' +
    'initial velocities, rigid walls and - when solved - the verified result: termination, cycles, final time, minimum step, energies and the ' +
    'energy error, hourglass ratio, added mass ratio, max von Mises and plastic strain with their location, failed elements, per-wall peak force ' +
    'and impulse, and the energy and wall-force histories (at most maxPoints samples each). Always reviewRequired, never certification evidence.',
  params: z.object({
    analysisId: analysisIdSchema,
    maxPoints: z.number().int().optional().describe('Most samples per history, 2 to 500. Default 200.'),
  }),
  run: (doc, { analysisId, maxPoints = 200 }, ctx): CommandResult => {
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return notFound(doc, 'explicit_report', analysisId, found.code, found.message);
    const { analysisCase, spec } = found;
    const trusted = trustedExplicit(doc, analysisCase, ctx?.feaArtifacts);
    const limit = Math.max(2, Math.min(MAX_HISTORY_POINTS, maxPoints));
    const artifact = trusted.artifact;
    const summary = trusted.summary;
    const { results, ...setup } = spec ?? { results: undefined };
    void results;
    const data = {
      analysisId,
      state: trusted.state,
      unitSystem: analysisCase.unitSystem,
      setup: spec === undefined ? null : setup,
      result: summary,
      histories:
        artifact === null || summary === null
          ? null
          : {
              energy: thin(artifact.energy, limit).map((row) => ({ ...row, error: energyError(row, summary.energy.initialKinetic) })),
              walls: artifact.walls.map((wall) => {
                const indices = thin(
                  wall.t.map((_, index) => index),
                  limit,
                );
                return {
                  name: wall.name,
                  t: indices.map((index) => wall.t[index] ?? 0),
                  force: indices.map((index) => wall.force[index] ?? 0),
                };
              }),
            },
      provenance: { formulation: FORMULATION, solver: summary?.solver ?? null, artifactHash: spec?.results?.artifactHash ?? null },
      problem: trusted.problem,
      unverified: summary?.unverified ?? false,
      unverifiedReasons: summary?.unverifiedReasons ?? [],
      reviewRequired: true,
      certificationEvidence: false,
      reviewReason: REVIEW,
    };
    const text =
      summary === null
        ? `explicit_report: ${analysisId} state ${trusted.state}${trusted.problem === null ? '' : ` (${trusted.problem.code}: ${trusted.problem.message})`}.`
        : `explicit_report: ${analysisId} ${summary.termination} termination, ${summary.cycles} cycles to ${significantNumber(summary.finalTimeS, 6)} s; energy error ${significantNumber(100 * summary.energy.errorFinal, 3)} %; max von Mises ${significantNumber(summary.maxVonMises.value, 6)} ${summary.maxVonMises.unit}. Computed by llull, not approved — needs a qualified engineer.`;
    return report(doc, text, data);
  },
});

type Status = 'pass' | 'warn' | 'fail';

interface CheckItem {
  readonly code: string | null;
  readonly status: Status;
  readonly message: string;
  readonly value: number | null;
  readonly limit: NamedValue | null;
}

function energyItems(
  summary: ExplicitResultsSummary,
  limits: { hourglass: NamedValue; energy: NamedValue | null; addedMass: NamedValue | null; contact: NamedValue | null },
): CheckItem[] {
  const { energy } = summary;
  const items: CheckItem[] = [
    summary.termination === 'normal'
      ? { code: null, status: 'pass', message: 'normal termination', value: null, limit: null }
      : {
          code: 'EXP_ABNORMAL_TERMINATION',
          status: 'fail',
          message: 'the run did not reach its end time',
          value: summary.finalTimeS,
          limit: null,
        },
  ];
  const hourglassHigh = energy.hourglassRatioMax > limits.hourglass.value;
  items.push({
    code: hourglassHigh ? 'EXP_HOURGLASS_HIGH' : null,
    status: hourglassHigh ? 'warn' : 'pass',
    message: `hourglass / internal energy max ${significantNumber(energy.hourglassRatioMax, 4)} (limit ${limits.hourglass.value})`,
    value: energy.hourglassRatioMax,
    limit: limits.hourglass,
  });
  if (limits.contact !== null) {
    const high = energy.contactRatioMax > limits.contact.value;
    items.push({
      code: high ? 'EXP_CONTACT_ENERGY_HIGH' : null,
      status: high ? 'warn' : 'pass',
      message: `contact / internal energy max ${significantNumber(energy.contactRatioMax, 4)} (limit ${limits.contact.value})`,
      value: energy.contactRatioMax,
      limit: limits.contact,
    });
  }
  if (limits.energy === null)
    items.push({
      code: 'EXP_ENERGY_LIMIT_UNSET',
      status: 'warn',
      message: 'no energy-error limit given (no default)',
      value: energy.errorMaxAbs,
      limit: null,
    });
  else {
    const high = energy.errorMaxAbs > limits.energy.value;
    items.push({
      code: high ? 'EXP_ENERGY_ERROR_HIGH' : null,
      status: high ? 'fail' : 'pass',
      message: `|energy error| max ${significantNumber(energy.errorMaxAbs, 4)} (limit ${limits.energy.value})`,
      value: energy.errorMaxAbs,
      limit: limits.energy,
    });
  }
  if (limits.addedMass === null) {
    if (energy.addedMassRatio > 0)
      items.push({
        code: 'EXP_ENERGY_LIMIT_UNSET',
        status: 'warn',
        message: 'mass was added but no added-mass limit is given',
        value: energy.addedMassRatio,
        limit: null,
      });
  } else {
    const high = energy.addedMassRatio > limits.addedMass.value;
    items.push({
      code: high ? 'EXP_ADDED_MASS_HIGH' : null,
      status: high ? 'fail' : 'pass',
      message: `added mass ratio ${significantNumber(energy.addedMassRatio, 4)} (limit ${limits.addedMass.value})`,
      value: energy.addedMassRatio,
      limit: limits.addedMass,
    });
  }
  return items;
}

const optionalLimit = (value: number | undefined, source: string): NamedValue | null =>
  value === undefined ? null : { value, source, defaulted: false };

/**
 * @invariant read-only; the hourglass limit is the only named default (0.10, S13 rule of thumb); no energy-error or added-mass default (warnings)
 * @failure unknown / non-explicit case -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE; no verified result -> its state code (EXP_RESULTS_MISSING,
 *   EXP_RESULT_STALE, EXP_ARTIFACT_NOT_FOUND, EXP_SUMMARY_MISMATCH)
 */
export const explicitEnergyCheck = defineCommand({
  name: 'explicit_energy_check',
  annotations: { readOnly: true },
  description:
    'Health check of a solved explicit_dynamics case (PHY-19 §5.4): termination, energy error (E_kin + E_int + E_hg + E_wall - E_kin0 - W_ext) / ' +
    '(E_kin0 + W_ext), hourglass / internal energy ratio, added mass ratio. Limits: hourglassLimit has the named default 0.10 (rule of thumb); ' +
    'energyErrorLimit and addedMassLimit have NO default (a warning says so; the added-mass limit falls back to the case mass-scaling limit). ' +
    'Returns status pass | warn | fail and one item per check with code, value and the limit with its source.',
  params: z.object({
    analysisId: analysisIdSchema,
    hourglassLimit: z.number().optional().describe('Largest hourglass / internal energy ratio, > 0. Default 0.10 (named).'),
    energyErrorLimit: z.number().optional().describe('Largest |energy error| (fraction, e.g. 0.05). No default.'),
    contactLimit: z.number().optional().describe('Largest |contact energy| / internal energy (warning above). No default.'),
    addedMassLimit: z
      .number()
      .optional()
      .describe('Largest added mass / model mass. Default: the case maxAddedMassRatio when mass scaling is on.'),
  }),
  run: (doc, { analysisId, hourglassLimit, energyErrorLimit, addedMassLimit, contactLimit }, ctx): CommandResult => {
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return notFound(doc, 'explicit_energy_check', analysisId, found.code, found.message);
    const trusted = trustedExplicit(doc, found.analysisCase, ctx?.feaArtifacts);
    if (trusted.summary === null)
      return notFound(
        doc,
        'explicit_energy_check',
        analysisId,
        trusted.problem?.code ?? 'EXP_RESULTS_MISSING',
        `no verified result (state ${trusted.state})`,
      );
    const scaling = found.spec?.massScaling;
    const limits = {
      hourglass: hourglassLimit === undefined ? DEFAULT_HOURGLASS_LIMIT() : { value: hourglassLimit, source: 'caller', defaulted: false },
      energy: optionalLimit(energyErrorLimit, 'caller'),
      contact: optionalLimit(contactLimit, 'caller'),
      addedMass:
        addedMassLimit !== undefined
          ? optionalLimit(addedMassLimit, 'caller')
          : scaling?.mode === 'selective'
            ? optionalLimit(scaling.maxAddedMassRatio, 'set_explicit_controls massScaling.maxAddedMassRatio')
            : null,
    };
    const items = energyItems(trusted.summary, limits);
    const status: Status = items.some((item) => item.status === 'fail')
      ? 'fail'
      : items.some((item) => item.status === 'warn')
        ? 'warn'
        : 'pass';
    const flagged = items.filter((item) => item.code !== null).map((item) => item.code);
    return report(doc, `explicit_energy_check: ${analysisId} ${status}${flagged.length > 0 ? ` (${flagged.join(', ')})` : ''}.`, {
      analysisId,
      status,
      items,
      reviewRequired: true,
      certificationEvidence: false,
    });
  },
});
