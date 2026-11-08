/** add_bolt_pretension / delete_bolt_pretension: bolt preload sections of a nonlinear_static case (PHY-06 FR-CNT-03, TR-CNT-04). */

import type { BoltPretension, PreloadSpec, PretensionSettings } from '@core/model/contact';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { refuseCnt } from './codes';
import { findBolt, forceUnitName, pretensionProblem, withPretension } from './pretensionRules';
import { preloadForce } from './pretensionDeck';
import { lengthUnitName, toAnalysisLength } from '../decks/units';

const preloadSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('force').describe('Preload given as the bolt axial force.'),
      value: z.number().describe('Preload force P in the analysis force unit (N for N-mm-t-s), > 0; tension.'),
    }),
    z.object({
      kind: z.literal('torque').describe('Preload derived from the tightening torque: P = T / (K D) (NASA-STD-5020 A.2-1).'),
      torque: z.number().describe('Tightening torque T in analysis force x analysis length (N*mm for N-mm-t-s), > 0.'),
      diameter: z.number().describe('Nominal bolt diameter D in DOCUMENT length units, > 0.'),
      nutFactor: z
        .number()
        .optional()
        .describe('Nut factor K (> 0). REQUIRED, never defaulted: without it the command refuses with CNT_NUT_FACTOR_MISSING.'),
      nutFactorSource: z
        .string()
        .optional()
        .describe('Where K comes from (torque-tension test record, handbook table). REQUIRED with nutFactor.'),
    }),
  ])
  .describe('Bolt preload: a force, or a torque with its nut factor.');

/** The torque preload with its nut factor and source, or null when either is absent (the nut factor is never defaulted). */
function torquePreload(input: Extract<z.output<typeof preloadSchema>, { kind: 'torque' }>): PreloadSpec | null {
  const { nutFactor, nutFactorSource } = input;
  if (nutFactor === undefined || nutFactorSource === undefined) return null;
  return { kind: 'torque', torque: input.torque, diameter: input.diameter, nutFactor, nutFactorSource };
}

const n = (value: number): string => significantNumber(value, 6);

/**
 * @affects doc.analysis.cases[analysisId].pretension (adds 1 bolt `bp-<step>.<k>`; affected: [analysisId, boltId])
 * @invariant the preload step is the first step of the case; a torque preload carries nut factor + source (never defaulted); names unique;
 *   lockAfter absent = true (named in the summary); the section is cut from the mesh at deck time (one closed cut through the part)
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; part missing / not in the case -> FEA_TARGET_UNRESOLVED /
 *   FEA_PART_NOT_IN_ANALYSIS; plane outside the part or zero normal -> CNT_PRETENSION_SECTION_INVALID; preload <= 0 -> CNT_PRELOAD_INVALID; torque
 *   without nut factor / source -> CNT_NUT_FACTOR_MISSING; unknown step -> CNT_STEP_UNKNOWN; not the first step -> CNT_PRETENSION_STEP_ORDER;
 *   name taken -> CNT_PAIR_NAME_TAKEN
 */
export const addBoltPretension = defineCommand({
  name: 'add_bolt_pretension',
  description:
    'Preload a bolt in a nonlinear_static analysis (the mechanism of CalculiX *PRE-TENSION SECTION, written explicitly: the mesh is cut across the shank, the cut nodes are duplicated and tied by equations to a reference node that carries the preload). entityId = the bolt part (a part of the case); section = a ' +
    'plane through the plain shank { point, normal } in document units (normal = the bolt axis direction; the section is cut from the mesh, so ' +
    'the plane must cross the bolt exactly once). preload = { kind: "force", value } (analysis force unit) or { kind: "torque", torque, diameter, ' +
    'nutFactor, nutFactorSource } with P = T / (K D); the nut factor is never defaulted. preloadStepId = the FIRST step of the case (add_analysis_step ' +
    'first; the bolt carries no load before it): the preload is applied there with the other loads at their step multipliers, then, when lockAfter ' +
    '(default true, reported in the summary), the bolt length is held fixed in every later step so external loads add to the preload through the ' +
    'joint stiffness; lockAfter false keeps the preload force constant instead. Combine with add_contact_pair for the clamped faces (a quadratic ' +
    'element carrying a contact face may not touch the section: CalculiX rule). Then fea_mesh, check_contact, fea_solve, contact_report (bolt axial ' +
    'force, bending, separation). Returns the bolt id in affected[1].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Unique bolt name in the case, e.g. "m8_left".'),
    entityId: z.string().describe('Id of the bolt part: a 3D part of the analysis (set_part_idealization).'),
    section: z
      .object({
        point: vec3('A point on the section plane, document units, inside the plain shank.'),
        normal: vec3('Plane normal = the bolt axis direction (positive preload = tension along it); need not be unit length.'),
      })
      .describe('Plane that cuts the bolt shank once; the pretension section is the mesh faces along it.'),
    preload: preloadSchema,
    preloadStepId: z.string().describe('Id of the first step of the case (affected[0] of add_analysis_step).'),
    lockAfter: z
      .boolean()
      .optional()
      .describe('Hold the bolt length fixed in the steps after the preload step (default true). false: the preload force stays constant.'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'add_bolt_pretension';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [params.analysisId], [path]);
    const settings = analysis.pretension;
    if (Object.values(settings?.bolts ?? {}).some((bolt) => bolt.name === params.name))
      return fail('CNT_PAIR_NAME_TAKEN', `a bolt named '${params.name}' exists already`, 'name');
    const preload = params.preload.kind === 'force' ? params.preload : torquePreload(params.preload);
    if (preload === null)
      return fail('CNT_NUT_FACTOR_MISSING', 'a torque preload needs nutFactor and nutFactorSource (never defaulted)', 'preload.nutFactor');
    const body: Omit<BoltPretension, 'id' | 'name'> = {
      entityId: params.entityId,
      section: { point: params.section.point, normal: params.section.normal },
      preload,
      preloadStepId: params.preloadStepId,
      lockAfter: params.lockAfter ?? true,
    };
    const bad = pretensionProblem(doc, analysis, body);
    if (bad !== null) return fail(bad.code, bad.message, bad.path);
    const bolt: BoltPretension = { id: nextId('bp'), name: params.name, ...body };
    const next: PretensionSettings = { bolts: { ...settings?.bolts, [bolt.id]: bolt }, order: [...(settings?.order ?? []), bolt.id] };
    const force = preloadForce(bolt.preload, toAnalysisLength(doc, analysis.unitSystem, 1));
    return changed(
      withPretension(doc, analysis, next),
      `${command}: '${bolt.id}' (${bolt.name}) on '${bolt.entityId}' in '${analysis.id}': preload ${n(force)} ${forceUnitName(analysis.unitSystem)}${bolt.preload.kind === 'torque' ? ` (= ${n(bolt.preload.torque)} / (K ${bolt.preload.nutFactor} x D ${bolt.preload.diameter} ${lengthUnitName(analysis.unitSystem)}), nut factor source: ${bolt.preload.nutFactorSource})` : ''}, applied in step '${bolt.preloadStepId}', lockAfter ${bolt.lockAfter}${params.lockAfter === undefined ? ' (default)' : ''}; section plane through [${bolt.section.point.join(', ')}] normal [${bolt.section.normal.join(', ')}], cut from the mesh at fea_mesh time.`,
      [analysis.id, bolt.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].pretension (removes 1 bolt; the last one removes the settings; affected: [analysisId, boltId])
 * @failure unknown case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; unknown bolt -> CNT_PRETENSION_NOT_FOUND (refusals, unchanged doc)
 */
export const deleteBoltPretension = defineCommand({
  name: 'delete_bolt_pretension',
  description:
    'Remove a bolt pretension (id = affected[1] of add_bolt_pretension, or its unique name) from a nonlinear_static analysis. Re-mesh and re-solve afterwards.',
  annotations: { destructive: true },
  params: z.object({
    analysisId: analysisIdSchema,
    bolt: z.string().describe('Bolt id (affected[1] of add_bolt_pretension) or unique name.'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'delete_bolt_pretension';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const settings = analysis.pretension;
    const bolt = findBolt(settings, params.bolt);
    if (settings === undefined || bolt === undefined)
      return refuseCnt(
        doc,
        command,
        'CNT_PRETENSION_NOT_FOUND',
        `no bolt pretension '${params.bolt}' in '${params.analysisId}'`,
        [params.analysisId],
        ['bolt'],
      );
    const order = settings.order.filter((id) => id !== bolt.id);
    const next: PretensionSettings | undefined =
      order.length === 0
        ? undefined
        : { bolts: Object.fromEntries(Object.entries(settings.bolts).filter(([id]) => id !== bolt.id)), order };
    return changed(
      withPretension(doc, analysis, next),
      `${command}: '${bolt.id}' (${bolt.name}) removed from '${analysis.id}'; ${order.length} bolt(s) left.`,
      [analysis.id, bolt.id],
    );
  },
});
