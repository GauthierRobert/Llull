/** add_result_probe / delete_result_probe: points whose values are extracted from the results. */

import type { AnalysisCase, ProbeQuantity } from '@core/model/analysis';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';

export const QUANTITIES = [
  'temperature',
  'heat_flux',
  'u_mag',
  'u_x',
  'u_y',
  'u_z',
  'von_mises',
  's_xx',
  's_yy',
  's_zz',
] as const satisfies readonly ProbeQuantity[];

/**
 * @affects doc.analysis.cases[analysisId].probes (adds 1 probe, id `pr-<step>.<k>`; affected: [probeId])
 * @failure unknown analysis, non-finite point -> refusal, unchanged doc
 */
export const addResultProbe = defineCommand({
  name: 'add_result_probe',
  description:
    'Add a result probe to an analysis: a point (document units) at which a quantity is read from the solved results (the nearest node ' +
    'is used). quantity: temperature (thermal / thermo-mechanical cases, in the case temperature scale), heat_flux, u_mag / u_x / u_y / u_z ' +
    '(displacement), von_mises, s_xx / s_yy / s_zz (stress). Returns the probe id in affected[0].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "hot spot".'),
    point: vec3('Probe location [x, y, z] in document units; it should lie on or inside a part.'),
    quantity: z.enum(QUANTITIES).describe('Quantity to read at the point.'),
  }),
  run: (doc, { analysisId, name, point, quantity }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'add_result_probe', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    if (!point.every(Number.isFinite))
      return refuseCode(doc, 'add_result_probe', 'FEA_PROBE_INVALID', 'point must be three finite numbers', [analysisId], ['point']);
    const id = nextId('pr');
    const next: AnalysisCase = { ...analysisCase, probes: { ...analysisCase.probes, [id]: { name, point, quantity } } };
    return changed(
      withCase(doc, next),
      `add_result_probe: '${id}' (${name}) reads ${quantity} at [${point.join(', ')}] in '${analysisId}'.`,
      [id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].probes (removes 1; affected: [probeId])
 * @failure unknown analysis / probe -> refusal, unchanged doc
 */
export const deleteResultProbe = defineCommand({
  name: 'delete_result_probe',
  description: 'Remove a result probe from an analysis.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema, probeId: z.string().describe('Probe id (affected[0] of add_result_probe).') }),
  run: (doc, { analysisId, probeId }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'delete_result_probe', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    if (!Object.hasOwn(analysisCase.probes, probeId))
      return refuseCode(doc, 'delete_result_probe', 'FEA_PROBE_NOT_FOUND', `no probe '${probeId}' in '${analysisId}'`, [
        analysisId,
        probeId,
      ]);
    const next: AnalysisCase = {
      ...analysisCase,
      probes: Object.fromEntries(Object.entries(analysisCase.probes).filter(([id]) => id !== probeId)),
    };
    return changed(withCase(doc, next), `delete_result_probe: removed '${probeId}' from '${analysisId}'.`, [probeId]);
  },
});
