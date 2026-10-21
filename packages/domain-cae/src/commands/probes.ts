/** add_result_probe: points whose values are extracted from the results. */

import type { AnalysisCase, ProbeQuantity } from '@core/model/analysis';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { axisFrame, CYLINDRICAL_QUANTITIES } from '../results/cylindrical';
import { analysisIdSchema } from '../shared/schemas';
import { DYNAMIC_PROBE_QUANTITIES, isDynamicQuantity, probeQuantitiesOf } from '../dynamics/quantities';

const QUANTITIES = [
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

export const PROBE_QUANTITIES = [...QUANTITIES, ...CYLINDRICAL_QUANTITIES] as const;

/**
 * @affects doc.analysis.cases[analysisId].probes (adds 1 probe, id `pr-<step>.<k>`; affected: [probeId])
 * @failure unknown analysis, non-finite point -> refusal, unchanged doc
 */
export const addResultProbe = defineCommand({
  name: 'add_result_probe',
  description:
    'Add a result probe to an analysis: a point (document units) at which a quantity is read from the solved results (the nearest node ' +
    'is used). quantity: temperature (thermal / thermo-mechanical cases, in the case temperature scale), heat_flux, u_mag / u_x / u_y / u_z ' +
    '(displacement), von_mises, s_xx / s_yy / s_zz (stress), and the cylindrical components s_hoop / s_radial / s_axial / u_radial about an ' +
    'axis (axisPoint + axisDirection; default: the z axis through the centre of the mesh bounding box, so a quarter / half model needs the ' +
    'real axis; hoop / radial are null on the axis). Dynamic cases: random_response probes read a_x / a_y / a_z (absolute acceleration rms, g), ' +
    'u_x_rel / u_y_rel / u_z_rel (displacement relative to the base) and s_xx / s_yy / s_zz; frequency_response probes read u_x / u_y / u_z and ' +
    's_xx / s_yy / s_zz (complex response peaks). Returns the probe id in affected[0].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "hot spot".'),
    point: vec3('Probe location [x, y, z] in document units; it should lie on or inside a part.'),
    quantity: z.enum([...PROBE_QUANTITIES, ...DYNAMIC_PROBE_QUANTITIES]).describe('Quantity to read at the point.'),
    axisPoint: vec3(
      'A point [x, y, z] (document units) on the axis of the cylindrical quantities. Default: centre of the mesh bounding box.',
    )
      .optional()
      .describe('Only for s_hoop / s_radial / s_axial / u_radial.'),
    axisDirection: vec3('Axis direction [x, y, z], any non-zero length. Default [0, 0, 1].')
      .optional()
      .describe('Only for s_hoop / s_radial / s_axial / u_radial.'),
  }),
  run: (doc, { analysisId, name, point, quantity, axisPoint, axisDirection }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'add_result_probe', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const allowed = probeQuantitiesOf(analysisCase.type);
    if (allowed === null ? isDynamicQuantity(quantity) : !allowed.includes(quantity))
      return refuseCode(
        doc,
        'add_result_probe',
        'DYN_PROBE_QUANTITY',
        `quantity ${quantity} does not apply to a ${analysisCase.type} analysis${allowed === null ? '' : ` (use ${allowed.join(', ')})`}`,
        [analysisId],
        ['quantity'],
      );
    if (!point.every(Number.isFinite))
      return refuseCode(doc, 'add_result_probe', 'FEA_PROBE_INVALID', 'point must be three finite numbers', [analysisId], ['point']);
    const cylindrical = (CYLINDRICAL_QUANTITIES as readonly string[]).includes(quantity);
    if ((axisPoint !== undefined || axisDirection !== undefined) && !cylindrical)
      return refuseCode(
        doc,
        'add_result_probe',
        'FEA_PROBE_INVALID',
        `axisPoint / axisDirection only apply to ${CYLINDRICAL_QUANTITIES.join(' / ')}`,
        [analysisId],
        ['axisPoint'],
      );
    if (axisPoint?.every(Number.isFinite) === false || (axisDirection !== undefined && axisFrame([0, 0, 0], axisDirection) === null))
      return refuseCode(
        doc,
        'add_result_probe',
        'FEA_PROBE_INVALID',
        'axisPoint must be finite and axisDirection a non-zero finite vector',
        [analysisId],
        ['axisDirection'],
      );
    const id = nextId('pr');
    const probe = {
      name,
      point,
      quantity,
      ...(axisPoint !== undefined ? { axisPoint } : {}),
      ...(axisDirection !== undefined ? { axisDirection } : {}),
    };
    const next: AnalysisCase = { ...analysisCase, probes: { ...analysisCase.probes, [id]: probe } };
    return changed(
      withCase(doc, next),
      `add_result_probe: '${id}' (${name}) reads ${quantity} at [${point.join(', ')}] in '${analysisId}'.`,
      [id],
    );
  },
});
