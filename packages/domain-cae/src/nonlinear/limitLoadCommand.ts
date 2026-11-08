/** limit_load: the limit (collapse) load of a solved nonlinear_static case from one load-displacement curve (PHY-05 FR-NLS-05). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { refuseNls } from './codes';
import { limitLoadReport, limitLoadShape } from './limitLoadQuery';

/**
 * @affects nothing (read-only query; data = limitLoad or lowerBound, method, curve hash, provenance)
 * @invariant every number from the re-verified results artifact; reviewRequired always true; unverified = OR of the material flags (AF-32)
 * @failure see limitLoadReport (FEA_ANALYSIS_NOT_FOUND, NLS_CASE_NOT_NONLINEAR, NLS_PROBE_REFERENCE_UNKNOWN, NLS_PLATEAU_PARAMS_UNSET,
 *   NLS_CURVE_STALE, FEA_SUMMARY_MISMATCH, FEA_RESULTS_MISSING)
 */
export const limitLoad = defineCommand({
  name: 'limit_load',
  description:
    'Find the limit (collapse) load of a SOLVED nonlinear_static analysis from one curve probe (add_curve_probe). method=peak takes the ' +
    'first load maximum (with the displacement still increasing) refined by a parabola; method=plateau needs plateau { slopeFraction, window } ' +
    '(no defaults) and takes the load where the secant slope over the window falls below slopeFraction x the initial slope; method=auto is ' +
    'peak when the curve has a maximum. A curve that never peaks (e.g. a load-controlled run, which cannot pass a limit point) gives only a ' +
    'lowerBound (largest load carried) with NLS_LIMIT_NOT_REACHED. Values are magnitudes in data.loadUnit (force for reactions and force loads, stress for a pressure) and the analysis length unit. Refuses stale ' +
    'results (NLS_CURVE_STALE). Without a PHY-00 mesh convergence study on the case it warns VNV_NO_CONVERGENCE_STUDY. Next: compute_margins ' +
    'criterion=limit_load, or check_analysis.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema, ...limitLoadShape }),
  run: (doc, { analysisId, probe, method, plateau }, ctx): CommandResult => {
    const found = limitLoadReport(doc, analysisId, { probe, method, plateau }, ctx);
    if ('code' in found) return refuseNls(doc, 'limit_load', found.code, found.message, found.ids, found.paths);
    const { result, loadUnit, lengthUnit } = found;
    const value = result.found === 'not_reached' ? result.lowerBound : result.limitLoad;
    const text =
      result.found === 'not_reached'
        ? `limit not reached: lower bound ${significantNumber(value, 6)} ${loadUnit} (NLS_LIMIT_NOT_REACHED)`
        : `limit load ${significantNumber(value, 6)} ${loadUnit} (${result.found}) at displacement ${significantNumber(result.atDisplacement, 6)} ${lengthUnit}`;
    return report(
      doc,
      `limit_load: '${analysisId}' curve '${found.probe.name}' (${found.curve.time.length} points, method ${method}): ${text}${found.warnings.length > 0 ? `; ${found.warnings.map((warning) => warning.split(':')[0]).join(', ')}` : ''}${found.unverifiedReasons.length > 0 ? '; UNVERIFIED inputs' : ''}. Computed by llull, not approved: needs a qualified engineer.`,
      {
        analysisId,
        probeId: found.probe.id,
        probeName: found.probe.name,
        method,
        found: result.found,
        ...(result.found === 'not_reached' ? { lowerBound: result.lowerBound } : { limitLoad: result.limitLoad }),
        ...(result.found === 'peak' ? { sample: result.sample } : {}),
        atDisplacement: result.atDisplacement,
        loadUnit,
        lengthUnit,
        points: found.curve.time.length,
        curveHash: found.curveHash,
        resultsHash: found.resultsHash,
        warnings: found.warnings,
        provenance: found.provenance,
        unverified: found.unverifiedReasons.length > 0,
        unverifiedReasons: found.unverifiedReasons,
        reviewRequired: true,
        reviewReason: 'a limit load supports a strength (collapse) claim',
      },
    );
  },
});
