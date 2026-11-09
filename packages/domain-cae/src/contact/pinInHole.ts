/** pin_in_hole and pin_bearing_report: a clearance pin bearing on a lug hole by contact (PHY-06 FR-CNT-11, V1 template). */

import { boundsCorners, entityBoundsInDoc } from '@core/geometry/bounds';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';
import { lengthUnitName, stressUnitName, toAnalysisLength } from '../decks/units';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { indexMesh } from '../thermal/meshGeometry';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { NOT_APPROVED, refuseCnt } from './codes';
import { behaviourSchema, formulationSchema, frictionSchema } from './pairSchema';
import { findPair } from './pairRules';
import { type WallNode, axisFrame, bearingOf } from './pinBearingMath';
import { BLOCK, slaveAreas } from './reader';
import { forceUnitName } from './pretensionRules';

const n = (value: number): string => significantNumber(value, 5);

/** Most rows one pin_bearing_report returns. */
const MAX_ROWS = 400;

const axisSchema = {
  axisPoint: vec3('A point on the hole axis, document units.'),
  axisDirection: vec3('Direction of the hole axis (need not be unit length).'),
};

/** Extent of `entityId` along the unit `direction` from `point`: [low, high] in document units, or null. */
function extentAlong(doc: CadDocument, entityId: string, point: Vec3, direction: Vec3): readonly [number, number] | null {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined) return null;
  const along = boundsCorners(entityBoundsInDoc(doc, entity)).map((corner) => dot3(sub3(corner, point), direction));
  return [Math.min(...along), Math.max(...along)];
}

/**
 * @affects doc.analysis.cases[analysisId].contact (+1 pair `cp-<step>.<k>`: slave = the hole wall of the plate, master = the pin wall; affected: [analysisId, pairId])
 * @invariant the fit is a clearance (hole diameter > pin diameter, explicit in the geometry); composes add_contact_pair through execute; the analytic bearing
 *   estimate is the rigid-pin cosine distribution p = p0 cos(theta), p0 = 4 P / (pi d t) (resultant: P = p0 (d / 2) t integral of cos^2 over -90..90 degrees)
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; hole <= pin diameter, non-positive values, zero axis, plate
 *   or pin missing -> CNT_PIN_FIT_INVALID; every refusal of add_contact_pair passes through
 */
export const pinInHole = defineCommand({
  name: 'pin_in_hole',
  description:
    'Pin-in-hole template for a lug or clevis joint in a nonlinear_static analysis: adds the contact pair (add_contact_pair) between the hole wall of plateEntityId ' +
    '(slave) and the outer wall of pinEntityId (master), both selected at mid-thickness on the hole axis (axisPoint, axisDirection, document units). The ' +
    'clearance is EXPLICIT: holeDiameter > pinDiameter (the model geometry must have them; an equal or tighter fit is an interference: use interference_fit). ' +
    'Both entities must be parts of the analysis. The pin floats until it bears: load the pin (e.g. a force on a pin end face) and fix the plate, or add a ' +
    'displacement-controlled first step (check_contact warns CNT_RIGID_BODY_BY_CONTACT_ONLY otherwise). Absent formulation = the case formulation, else ' +
    'surface_to_surface; absent behaviour = hard; absent friction = frictionless (all named in the summary). With pinLoad P (analysis force unit) it also returns ' +
    'the closed-form bearing estimate: nominal P / (d t) and the rigid-pin cosine peak 4 P / (pi d t) (t = plate thickness along the axis). Then fea_mesh, ' +
    `check_contact, fea_solve, pin_bearing_report (the FE bearing distribution and hoop stress). ${NOT_APPROVED}`,
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Unique pair name in the case, e.g. "lug_pin".'),
    plateEntityId: z.string().describe('Solid entity of the plate / lug with the hole, a part of the analysis.'),
    pinEntityId: z.string().describe('Solid entity of the pin, a part of the analysis.'),
    ...axisSchema,
    pinDiameter: z.number().describe('Pin outer diameter, document length units (> 0).'),
    holeDiameter: z.number().describe('Hole diameter, document length units; must exceed pinDiameter (clearance fit).'),
    pinLoad: z
      .number()
      .optional()
      .describe('Pin force P on the plate in the analysis force unit (> 0): adds the closed-form bearing estimate to the result.'),
    formulation: formulationSchema.optional(),
    behaviour: behaviourSchema.optional().describe('Pressure-overclosure of the pair; absent = hard.'),
    friction: frictionSchema.optional().describe('Coulomb friction of the pair; absent = frictionless.'),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'pin_in_hole';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (message: string, path: string): CommandResult =>
      refuseCnt(doc, command, 'CNT_PIN_FIT_INVALID', message, [params.analysisId], [path]);
    const { pinDiameter, holeDiameter, pinLoad } = params;
    if (![pinDiameter, holeDiameter].every((value) => Number.isFinite(value) && value > 0))
      return fail('pinDiameter and holeDiameter must be finite and > 0', 'pinDiameter');
    if (!(holeDiameter > pinDiameter))
      return fail(
        `holeDiameter ${holeDiameter} does not exceed pinDiameter ${pinDiameter}: a clearance fit needs a larger hole (an interference fit is interference_fit)`,
        'holeDiameter',
      );
    if (pinLoad !== undefined && !(Number.isFinite(pinLoad) && pinLoad > 0)) return fail('pinLoad must be finite and > 0', 'pinLoad');
    const length = Math.hypot(...params.axisDirection);
    if (!(length > 0) || ![...params.axisPoint, ...params.axisDirection].every(Number.isFinite))
      return fail('axisPoint must be finite and axisDirection a non-zero finite vector', 'axisDirection');
    const axis = scale3(params.axisDirection, 1 / length);
    const span = extentAlong(doc, params.plateEntityId, params.axisPoint, axis);
    if (span === null || !Object.hasOwn(doc.entities, params.pinEntityId))
      return fail(`plate '${params.plateEntityId}' or pin '${params.pinEntityId}' is not an entity of the document`, 'plateEntityId');
    const trial: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const across = cross3(axis, trial);
    const lateral = scale3(across, 1 / Math.hypot(...across));
    const thickness = span[1] - span[0];
    const middle = add3(params.axisPoint, scale3(axis, (span[0] + span[1]) / 2));
    const formulation = params.formulation ?? (analysis.contact === undefined ? 'surface_to_surface' : undefined);
    const added = execute(
      doc,
      'add_contact_pair',
      {
        analysisId: params.analysisId,
        name: params.name,
        slave: { entityId: params.plateEntityId, facesNear: [add3(middle, scale3(lateral, holeDiameter / 2))] },
        master: { entityId: params.pinEntityId, facesNear: [add3(middle, scale3(lateral, pinDiameter / 2))] },
        ...(formulation === undefined ? {} : { formulation }),
        behaviour: params.behaviour ?? { kind: 'hard' },
        ...(params.friction === undefined ? {} : { friction: params.friction }),
      },
      ctx,
    );
    if (added.error !== undefined)
      return refuseCnt(doc, command, added.error.code, `add_contact_pair refused: ${added.summary}`, [params.analysisId], []);
    const pairId = added.affected[1] ?? '';
    const bearing =
      pinLoad === undefined
        ? null
        : {
            nominal: pinLoad / (pinDiameter * thickness),
            cosinePeak: (4 * pinLoad) / (Math.PI * pinDiameter * thickness),
            model:
              'rigid pin, close fit: p = p0 cos(theta) on |theta| < 90 deg, p0 = 4 P / (pi d t); a larger clearance narrows the arc and raises the peak',
            unit: `${forceUnitName(analysis.unitSystem)}/${lengthUnitName(analysis.unitSystem)}^2`,
          };
    return {
      document: added.document,
      summary:
        `${command}: pair '${pairId}' (${params.name}) in '${params.analysisId}': hole wall of '${params.plateEntityId}' (slave, D ${n(holeDiameter)} ${doc.units}) on pin '${params.pinEntityId}' (master, d ${n(pinDiameter)} ${doc.units}), ` +
        `radial clearance ${n((holeDiameter - pinDiameter) / 2)} ${doc.units}, plate thickness ${n(thickness)} ${doc.units} along the axis; formulation ${formulation ?? analysis.contact?.formulation}${formulation !== undefined && params.formulation === undefined ? ' by default' : ''}, ` +
        `behaviour ${params.behaviour === undefined ? 'hard by default' : params.behaviour.kind}, ${params.friction === undefined ? 'frictionless by default' : `friction mu ${params.friction.mu}`}.` +
        `${bearing === null ? '' : ` Closed form: nominal bearing ${n(bearing.nominal)}, cosine peak ${n(bearing.cosinePeak)} ${bearing.unit}.`} ${NOT_APPROVED}`,
      affected: [params.analysisId, pairId],
      data: {
        analysisId: params.analysisId,
        pairId,
        clearance: { radial: (holeDiameter - pinDiameter) / 2, unit: doc.units },
        thickness,
        bearing,
        reviewRequired: true,
      },
    };
  },
});

/**
 * @invariant read-only; numbers from results re-verified against the artifact store; the slave nodes of the pair are the hole wall; angle 0 = loadDirection projected
 *   normal to the axis, positive about the axis; at most 400 rows (truncated flag); reviewRequired
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; unknown pair -> CNT_PAIR_NOT_FOUND; unknown step -> NLS_STEP_NOT_FOUND;
 *   zero / parallel axis and load direction -> CNT_INPUT_INVALID; stale / no results -> FEA_RESULTS_STALE / FEA_RESULTS_MISSING / FEA_SUMMARY_MISMATCH; no CONTACT block ->
 *   CNT_CONTACT_RESULTS_MISSING
 */
export const pinBearingReport = defineCommand({
  name: 'pin_bearing_report',
  description:
    'Bearing of a pin on its hole from a SOLVED nonlinear_static analysis (pin_in_hole): per slave node of the pair (the hole wall) the angle about the axis from ' +
    'loadDirection (0 = the direction of the pin force on the plate), the contact pressure and the hoop stress sigma_theta (from the STRESS field), sorted by angle; ' +
    'the peak pressure with its angle, the contact half-angle, the resultant of pressure x area along and across the load direction (along = the pin force carried ' +
    'by the wall; compare with the applied pin load) and the largest hoop stress with its node. Last stored increment of the step (default: the last step). ' +
    'Pressures are nodal (extrapolated): peaks read a few % high. Lengths / stresses / forces in the analysis unit system. Compare with the pin_in_hole closed form. ' +
    NOT_APPROVED,
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    pair: z.string().describe('The pin / hole pair (id or unique name; affected[1] of pin_in_hole).'),
    step: z.string().optional().describe('Step id or unique name; absent = the last step with results.'),
    ...axisSchema,
    loadDirection: vec3(
      'Direction of the pin force on the plate, document units; its component normal to the axis is the angle reference.',
    ),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'pin_bearing_report';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [analysis.id], [path]);
    const pair = findPair(analysis.contact, params.pair);
    if (pair === undefined) return fail('CNT_PAIR_NOT_FOUND', `no contact pair '${params.pair}' in '${analysis.id}'`, 'pair');
    const steps = analysis.nonlinear?.steps ?? {};
    const order = analysis.nonlinear?.stepOrder ?? [];
    const stepId =
      params.step === undefined
        ? order.at(-1)
        : Object.hasOwn(steps, params.step)
          ? params.step
          : Object.values(steps).find((step) => step.name === params.step)?.id;
    if (stepId === undefined || order.indexOf(stepId) < 0)
      return fail('NLS_STEP_NOT_FOUND', `no step '${params.step ?? '(last)'}'`, 'step');
    const scale = toAnalysisLength(doc, analysis.unitSystem, 1);
    const frame = axisFrame(scale3(params.axisPoint, scale), params.axisDirection, params.loadDirection);
    if (frame === null)
      return fail('CNT_INPUT_INVALID', 'axisDirection must be non-zero and loadDirection must not be parallel to it', 'loadDirection');
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    if (trust.state !== 'solved' || trust.resultsArtifact === null || trust.meshArtifact === null)
      return fail(
        trust.state === 'stale' ? 'FEA_RESULTS_STALE' : trust.state === 'untrusted' ? 'FEA_SUMMARY_MISMATCH' : 'FEA_RESULTS_MISSING',
        trust.problem?.message ?? `no current verified results (state ${trust.state}): run fea_mesh and fea_solve`,
        'analysisId',
      );
    const stored = trust.resultsArtifact.steps.filter((step) => step.step === order.indexOf(stepId) + 1);
    const result = stored.at(-1);
    const contact = result?.fields[BLOCK];
    const pressureAt = contact === undefined ? -1 : contact.components.indexOf('CPRESS');
    if (result === undefined || contact === undefined || pressureAt < 0)
      return fail('CNT_CONTACT_RESULTS_MISSING', `step '${stepId}' has no stored increment with a ${BLOCK} block`, 'step');
    const index = indexMesh(trust.meshArtifact);
    const stress = result.fields['STRESS']?.values ?? {};
    const nodes: WallNode[] = [...slaveAreas(index, trust.meshArtifact, pair)].flatMap(([node, area]) => {
      const at = index.coordinates.get(node);
      if (at === undefined) return [];
      const pressure = contact.values[String(node)]?.[pressureAt] ?? 0;
      return [{ node, at, area, pressure: Math.max(0, pressure), stress: stress[String(node)] ?? null }];
    });
    if (nodes.length === 0)
      return fail('CNT_PAIR_NOT_FOUND', `pair '${pair.id}' has no slave nodes in the mesh (face set missing: re-run fea_mesh)`, 'pair');
    const bearing = bearingOf(frame, nodes);
    const length = lengthUnitName(analysis.unitSystem);
    const stressName = stressUnitName(analysis.unitSystem);
    const force = forceUnitName(analysis.unitSystem);
    const shown = bearing.rows.slice(0, MAX_ROWS);
    return report(
      doc,
      `${command}: pair '${pair.id}' (${pair.name}), step '${stepId}' time ${n(result.time)}: peak pressure ${bearing.peak === null ? 'none (open)' : `${n(bearing.peak.pressure)} ${stressName} at ${n(bearing.peak.angleDeg)} deg`}, contact half-angle ${bearing.halfAngleDeg === null ? 'n/a' : `${n(bearing.halfAngleDeg)} deg`}, resultant along the load ${n(bearing.resultant.along)} ${force} (across ${n(bearing.resultant.across)}), max hoop stress ${bearing.maxHoop === null ? 'n/a (no STRESS)' : `${n(bearing.maxHoop.stress)} ${stressName} at ${n(bearing.maxHoop.angleDeg)} deg`}. ${NOT_APPROVED}`,
      {
        analysisId: analysis.id,
        pairId: pair.id,
        stepId,
        time: result.time,
        units: { length, stress: stressName, force },
        rows: shown,
        truncated: bearing.rows.length > shown.length,
        peak: bearing.peak,
        halfAngleDeg: bearing.halfAngleDeg,
        resultant: bearing.resultant,
        maxHoop: bearing.maxHoop,
        provenance: {
          pressure: 'frd CONTACT CPRESS at the slave nodes (nodal, extrapolated: peaks read high)',
          resultant: 'sum of pressure x tributary area x outward radial unit vector',
          hoop: 'e_theta . STRESS . e_theta with e_theta = axis x radial, at the wall nodes (frd STRESS)',
        },
        reviewRequired: true,
      },
    );
  },
});
