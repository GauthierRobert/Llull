/** add_contact_pair / update_contact_pair / delete_contact_pair: structural contact pairs of a nonlinear_static case (PHY-06 FR-CNT-01/02). */

import type { AnalysisCase } from '@core/model/analysis';
import type { ContactBehaviour, ContactFormulation, ContactPair, ContactSettings } from '@core/model/contact';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetDistanceWarning, toTarget } from '../shared/target';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { refuseCnt } from './codes';
import { defaultStickSlope } from './defaults';
import { findPair, pairProblem, withContact } from './pairRules';
import { adjustSchema, behaviourSchema, formulationSchema, frictionSchema, toBehaviour } from './pairSchema';

type Body = Omit<ContactPair, 'id' | 'name'>;

const behaviourText = (behaviour: ContactBehaviour): string =>
  behaviour.kind === 'hard'
    ? 'hard (CalculiX defaults)'
    : behaviour.kind === 'exponential'
      ? `exponential c0 ${behaviour.c0}, p0 ${behaviour.p0}`
      : `${behaviour.kind} slope ${significantNumber(behaviour.slope, 6)}`;

/** Friction / default text of a pair for the summaries. */
function frictionText(doc: CadDocument, analysis: AnalysisCase, pair: Body): string {
  if (pair.friction === undefined) return 'frictionless';
  if (pair.friction.stickSlope !== undefined)
    return `friction mu ${pair.friction.mu}, stick slope ${significantNumber(pair.friction.stickSlope, 6)}`;
  const named = defaultStickSlope(doc, analysis);
  return `friction mu ${pair.friction.mu}, stick slope ${named === null ? 'CalculiX default (E1/2; no readable E yet)' : `${significantNumber(named.value, 6)} ${named.unit} (defaulted: ${named.source})`}`;
}

/** Record of the optional fields (absent ones omitted, never undefined). */
function optionalFields(input: {
  readonly friction?: { readonly mu: number; readonly stickSlope?: number | undefined } | null | undefined;
  readonly adjust?: ContactPair['adjust'] | null | undefined;
  readonly smallSliding?: boolean | undefined;
  readonly activeSteps?: readonly string[] | null | undefined;
  readonly noSlipRequired?: boolean | undefined;
}): Partial<Body> {
  const friction = input.friction;
  return {
    ...(friction !== undefined && friction !== null
      ? { friction: { mu: friction.mu, ...(friction.stickSlope !== undefined ? { stickSlope: friction.stickSlope } : {}) } }
      : {}),
    ...(input.adjust !== undefined && input.adjust !== null ? { adjust: input.adjust } : {}),
    ...(input.smallSliding === true ? { smallSliding: true } : {}),
    ...(input.activeSteps !== undefined && input.activeSteps !== null ? { activeSteps: [...input.activeSteps] } : {}),
    ...(input.noSlipRequired === true ? { noSlipRequired: true } : {}),
  };
}

const summaryOf = (doc: CadDocument, analysis: AnalysisCase, pair: ContactPair, formulation: ContactFormulation): string =>
  `'${pair.id}' (${pair.name}) slave '${pair.slave.entityId}' -> master '${pair.master.entityId}', ${formulation}, ${behaviourText(pair.behaviour)}, ${frictionText(doc, analysis, pair)}${pair.adjust?.kind === 'clearance' ? `, adjust ${pair.adjust.value}` : ''}${pair.activeSteps === undefined ? '' : `, active in ${pair.activeSteps.length} step(s)`} in '${analysis.id}'`;

const pairFields = {
  name: z.string().min(1).describe('Unique pair name in the case, e.g. "roller_block".'),
  slave: feaTargetSchema.describe('Slave side (facesNear points): the finer-meshed / softer / smaller surface.'),
  master: feaTargetSchema.describe('Master side (facesNear points): the coarser / stiffer / larger surface.'),
  formulation: formulationSchema.optional(),
  behaviour: behaviourSchema,
  friction: frictionSchema.optional(),
  adjust: adjustSchema.optional(),
  smallSliding: z.boolean().optional().describe('SMALL SLIDING (node_to_surface only): the slave-master pairing is fixed at the start.'),
  activeSteps: z
    .array(z.string())
    .optional()
    .describe('Step ids (add_analysis_step) the pair is active in; absent = all steps (*MODEL CHANGE).'),
  noSlipRequired: z
    .boolean()
    .optional()
    .describe('true: the design relies on this interface not slipping (check_contact reports CNT_SLIP).'),
};

/**
 * @affects doc.analysis.cases[analysisId].contact (created on the first pair, which fixes the formulation; adds 1 pair `cp-<step>.<k>`;
 *   affected: [analysisId, pairId])
 * @invariant one formulation per case; tied only surface_to_surface; smallSliding only node_to_surface; names unique; targets are face
 *   targets on parts of the case; activeSteps name existing steps
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; first pair without formulation ->
 *   CNT_FORMULATION_UNSET; other formulation -> CNT_MIXED_CONTACT_TYPES; tied / smallSliding mismatch -> CNT_BEHAVIOUR_FORMULATION_MISMATCH;
 *   bad values -> CNT_FRICTION_INVALID / CNT_BEHAVIOUR_INVALID / CNT_ADJUST_INVALID; same faces -> CNT_SELF_PAIR; bad target ->
 *   FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS; unknown step -> CNT_STEP_UNKNOWN; name taken -> CNT_PAIR_NAME_TAKEN
 */
export const addContactPair = defineCommand({
  name: 'add_contact_pair',
  description:
    'Add a structural contact pair (CalculiX *CONTACT PAIR) between a slave and a master face of a nonlinear_static analysis (two parts, ' +
    'or two faces of one part). The first pair fixes the formulation (node_to_surface | surface_to_surface | mortar) for the whole case ' +
    '(CalculiX rule; a different one is refused with CNT_MIXED_CONTACT_TYPES). behaviour: hard | linear { slope } | exponential { c0, p0 } ' +
    '| tied { slope, stickSlope } (surface_to_surface only; glued faces). friction { mu, stickSlope? }: absent stickSlope = CalculiX ' +
    'default E1/2, reported as a named default. adjust { kind: clearance, value } moves slave nodes within value (document length) onto ' +
    'the master. Slopes and stresses are in the analysis unit system. Returns the pair id in affected[1]. Then fea_mesh, check_contact, ' +
    'fea_solve, contact_report (pressures, areas, slip), check_contact again.',
  params: z.object({ analysisId: analysisIdSchema, ...pairFields }),
  run: (doc, params): CommandResult => {
    const command = 'add_contact_pair';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const settings = analysis.contact;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [params.analysisId], [path]);
    const formulation = params.formulation ?? settings?.formulation;
    if (formulation === undefined)
      return fail('CNT_FORMULATION_UNSET', 'the first pair of a case must state the formulation', 'formulation');
    if (settings !== undefined && formulation !== settings.formulation)
      return fail(
        'CNT_MIXED_CONTACT_TYPES',
        `the case uses ${settings.formulation}; ${formulation} cannot be mixed in (CalculiX rule)`,
        'formulation',
      );
    if (Object.values(settings?.pairs ?? {}).some((pair) => pair.name === params.name))
      return fail('CNT_PAIR_NAME_TAKEN', `a pair named '${params.name}' exists already`, 'name');
    const body: Body = {
      slave: toTarget(params.slave),
      master: toTarget(params.master),
      behaviour: toBehaviour(params.behaviour),
      ...optionalFields(params),
    };
    const bad = pairProblem(doc, analysis, body, formulation);
    if (bad !== null) return fail(bad.code, bad.message, bad.path);
    const pair: ContactPair = { id: nextId('cp'), name: params.name, ...body };
    const next: ContactSettings = {
      formulation,
      pairs: { ...settings?.pairs, [pair.id]: pair },
      pairOrder: [...(settings?.pairOrder ?? []), pair.id],
    };
    const warning = targetDistanceWarning(doc, pair.slave) + targetDistanceWarning(doc, pair.master);
    return changed(withContact(doc, analysis, next), `${command}: ${summaryOf(doc, analysis, pair, formulation)}.${warning}`, [
      params.analysisId,
      pair.id,
    ]);
  },
});

/**
 * @affects doc.analysis.cases[analysisId].contact.pairs[pairId] (replaces the given fields, id kept; formulation only while it is the only
 *   pair; affected: [analysisId, pairId])
 * @invariant the merged pair satisfies the add_contact_pair invariants; null clears friction / adjust / activeSteps
 * @failure unknown case / pair -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR / CNT_PAIR_NOT_FOUND; nothing given -> CNT_NOTHING_TO_UPDATE;
 *   formulation change with other pairs -> CNT_MIXED_CONTACT_TYPES; every add_contact_pair refusal on the merged pair
 */
export const updateContactPair = defineCommand({
  name: 'update_contact_pair',
  description:
    'Change a contact pair (id = affected[1] of add_contact_pair, or its unique name): give any of name, slave, master, behaviour, friction, ' +
    'adjust, smallSliding, activeSteps, noSlipRequired, formulation (only while it is the only pair of the case). null clears friction, ' +
    'adjust or activeSteps. The merged pair is validated like add_contact_pair. Re-mesh and re-solve afterwards (results become stale).',
  params: z.object({
    analysisId: analysisIdSchema,
    pair: z.string().describe('Pair id (affected[1] of add_contact_pair) or unique name.'),
    name: pairFields.name.optional(),
    slave: pairFields.slave.optional(),
    master: pairFields.master.optional(),
    formulation: formulationSchema.optional(),
    behaviour: behaviourSchema.optional(),
    friction: frictionSchema.nullable().optional().describe('New friction; null = frictionless.'),
    adjust: adjustSchema.nullable().optional().describe('New initial adjustment; null = none.'),
    smallSliding: pairFields.smallSliding,
    activeSteps: z.array(z.string()).nullable().optional().describe('New active step ids; null = all steps.'),
    noSlipRequired: pairFields.noSlipRequired,
  }),
  run: (doc, params): CommandResult => {
    const command = 'update_contact_pair';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const settings = analysis.contact;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [params.analysisId, params.pair], [path]);
    const current = findPair(settings, params.pair);
    if (settings === undefined || current === undefined)
      return fail('CNT_PAIR_NOT_FOUND', `no contact pair '${params.pair}' in '${params.analysisId}'`, 'pair');
    const { analysisId, pair: key, ...fields } = params;
    void analysisId;
    void key;
    if (Object.values(fields).every((value) => value === undefined))
      return fail('CNT_NOTHING_TO_UPDATE', 'give at least one field to change', 'name');
    const formulation = params.formulation ?? settings.formulation;
    if (formulation !== settings.formulation && settings.pairOrder.length > 1)
      return fail(
        'CNT_MIXED_CONTACT_TYPES',
        `the case has ${settings.pairOrder.length} pairs using ${settings.formulation}`,
        'formulation',
      );
    const name = params.name ?? current.name;
    if (Object.values(settings.pairs).some((pair) => pair.id !== current.id && pair.name === name))
      return fail('CNT_PAIR_NAME_TAKEN', `a pair named '${name}' exists already`, 'name');
    const body: Body = {
      slave: params.slave === undefined ? current.slave : toTarget(params.slave),
      master: params.master === undefined ? current.master : toTarget(params.master),
      behaviour: params.behaviour === undefined ? current.behaviour : toBehaviour(params.behaviour),
      ...optionalFields({
        friction: params.friction === undefined ? current.friction : params.friction,
        adjust: params.adjust === undefined ? current.adjust : params.adjust,
        smallSliding: params.smallSliding ?? current.smallSliding,
        activeSteps: params.activeSteps === undefined ? current.activeSteps : params.activeSteps,
        noSlipRequired: params.noSlipRequired ?? current.noSlipRequired,
      }),
    };
    const bad = pairProblem(doc, analysis, body, formulation);
    if (bad !== null) return fail(bad.code, bad.message, bad.path);
    const pair: ContactPair = { id: current.id, name, ...body };
    const next: ContactSettings = { ...settings, formulation, pairs: { ...settings.pairs, [pair.id]: pair } };
    return changed(withContact(doc, analysis, next), `${command}: ${summaryOf(doc, analysis, pair, formulation)} updated.`, [
      analysis.id,
      pair.id,
    ]);
  },
});

/**
 * @affects doc.analysis.cases[analysisId].contact (removes 1 pair; the last pair removes the contact settings and frees the formulation;
 *   affected: [analysisId, pairId])
 * @failure unknown case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; unknown pair -> CNT_PAIR_NOT_FOUND (refusals, unchanged doc)
 */
export const deleteContactPair = defineCommand({
  name: 'delete_contact_pair',
  description:
    'Remove a contact pair (id or unique name) from a nonlinear_static analysis. Removing the last pair removes the contact set-up, so the ' +
    'next add_contact_pair may choose another formulation. Re-mesh and re-solve afterwards.',
  annotations: { destructive: true },
  params: z.object({
    analysisId: analysisIdSchema,
    pair: z.string().describe('Pair id (affected[1] of add_contact_pair) or unique name.'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'delete_contact_pair';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const settings = analysis.contact;
    const pair = findPair(settings, params.pair);
    if (settings === undefined || pair === undefined)
      return refuseCnt(
        doc,
        command,
        'CNT_PAIR_NOT_FOUND',
        `no contact pair '${params.pair}' in '${params.analysisId}'`,
        [params.analysisId],
        ['pair'],
      );
    const order = settings.pairOrder.filter((id) => id !== pair.id);
    const next: ContactSettings | undefined =
      order.length === 0
        ? undefined
        : { ...settings, pairs: Object.fromEntries(Object.entries(settings.pairs).filter(([id]) => id !== pair.id)), pairOrder: order };
    return changed(
      withContact(doc, analysis, next),
      `${command}: '${pair.id}' (${pair.name}) removed from '${analysis.id}'; ${order.length} pair(s) left${order.length === 0 ? ' (contact set-up removed)' : ''}.`,
      [analysis.id, pair.id],
    );
  },
});
