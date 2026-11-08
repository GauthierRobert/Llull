/** PHY-06 §5.1 deck sections of the contact pairs of a nonlinear_static case (pure): surfaces, interactions, pairs, per-step switches and output. */

import type { ContactBehaviour, ContactPair, ContactSettings } from '@core/model/contact';
import { safeName, type DeckContext, type DeckRefusal } from '../decks/context';
import { commentText, row } from '../decks/format';
import { pairValueProblem } from './pairRules';
import { pairTargetKey } from '../hash/targets';

/**
 * μ written on the `*FRICTION` card of a tied pair: CalculiX needs μ > 0 on the card and takes the tangential stiffness from the stick slope; a
 * tied pair does not slide. Pending a ccx run (VC-CNT-50).
 */
const TIED_FRICTION_COEFFICIENT = 1;

const TYPE: Readonly<Record<ContactSettings['formulation'], string>> = {
  node_to_surface: 'NODE TO SURFACE',
  surface_to_surface: 'SURFACE TO SURFACE',
  mortar: 'MORTAR',
};

/** Deck names of a pair: slave / master surfaces and the interaction. */
function pairNames(pair: ContactPair): { readonly slave: string; readonly master: string; readonly interaction: string } {
  const base = safeName(pair.id).toUpperCase();
  return { slave: `CS_${base}_S`, master: `CS_${base}_M`, interaction: `SI_${base}` };
}

/** Data line of a *SURFACE BEHAVIOR card with trailing absent values dropped (absent inner values left blank = CalculiX default). */
function cells(values: readonly (number | undefined)[]): string {
  const out = values.map((value) => (value === undefined ? '' : row(value)));
  while (out.length > 0 && out.at(-1) === '') out.pop();
  return out.join(', ');
}

/** `*SURFACE BEHAVIOR` lines; mortar + hard = no card (true hard contact in CalculiX). */
function behaviourLines(behaviour: ContactBehaviour, mortar: boolean): string[] {
  switch (behaviour.kind) {
    case 'hard':
      return mortar ? [] : ['*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=HARD'];
    case 'linear':
      return ['*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR', cells([behaviour.slope, behaviour.tensionAtLargeClearance, behaviour.c0])];
    case 'exponential':
      return ['*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=EXPONENTIAL', row(behaviour.c0, behaviour.p0)];
    case 'tied':
      return [
        '*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED',
        row(behaviour.slope),
        '*FRICTION',
        row(TIED_FRICTION_COEFFICIENT, behaviour.stickSlope),
      ];
  }
}

const refuse = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });

/**
 * Model-data cards of every pair: element-face `*SURFACE`s from the mesh face sets `CP_<id>_S|M`, `*SURFACE INTERACTION` with its
 * `*SURFACE BEHAVIOR` and `*FRICTION`, `*CONTACT PAIR, INTERACTION=…, TYPE=…[, SMALL SLIDING][, ADJUST=<analysis length>]`.
 * @invariant one TYPE for every pair (the case formulation); empty for a case without contact; pure and byte-deterministic
 * @failure a face set missing from the mesh -> FEA_TARGET_UNRESOLVED; an invalid stored pair -> its CNT_* code; activeSteps naming an unknown
 *   step -> CNT_STEP_UNKNOWN (ids: the pair)
 */
export function contactModelLines(ctx: DeckContext): string[] | DeckRefusal {
  const settings = ctx.analysis.contact;
  if (settings === undefined) return [];
  const steps = ctx.analysis.nonlinear?.steps ?? {};
  const lines: string[] = [];
  for (const pairId of settings.pairOrder) {
    const pair = settings.pairs[pairId];
    if (pair === undefined) continue;
    const bad = pairValueProblem(pair, settings.formulation);
    if (bad !== null) return refuse(bad.code, `contact pair '${pair.id}': ${bad.message}`, [pair.id]);
    const unknown = (pair.activeSteps ?? []).find((stepId) => !Object.hasOwn(steps, stepId));
    if (unknown !== undefined)
      return refuse('CNT_STEP_UNKNOWN', `contact pair '${pair.id}' is active in unknown step '${unknown}'`, [pair.id]);
    const names = pairNames(pair);
    lines.push(`** contact pair ${commentText(pair.id)} ${commentText(pair.name)}`);
    for (const [side, surface] of [
      ['S', names.slave],
      ['M', names.master],
    ] as const) {
      const faces = ctx.faces(pairTargetKey(pair.id, side));
      if (faces.length === 0)
        return refuse(
          'FEA_TARGET_UNRESOLVED',
          `contact pair '${pair.id}' (${pair.name}) has no ${side === 'S' ? 'slave' : 'master'} faces in the mesh`,
          [pair.id],
        );
      lines.push(`*SURFACE, NAME=${surface}, TYPE=ELEMENT`, ...faces.map(([element, face]) => row(element, `S${face}`)));
    }
    lines.push(`*SURFACE INTERACTION, NAME=${names.interaction}`, ...behaviourLines(pair.behaviour, settings.formulation === 'mortar'));
    if (pair.friction !== undefined)
      lines.push(
        '*FRICTION',
        pair.friction.stickSlope === undefined ? row(pair.friction.mu) : row(pair.friction.mu, pair.friction.stickSlope),
      );
    const small = pair.smallSliding === true ? ', SMALL SLIDING' : '';
    const adjust = pair.adjust?.kind === 'clearance' ? `, ADJUST=${row(pair.adjust.value * ctx.lengthToAnalysis)}` : '';
    lines.push(
      `*CONTACT PAIR, INTERACTION=${names.interaction}, TYPE=${TYPE[settings.formulation]}${small}${adjust}`,
      row(names.slave, names.master),
    );
  }
  return lines;
}

const activeIn = (pair: ContactPair, stepId: string | null): boolean =>
  stepId === null || pair.activeSteps === undefined || pair.activeSteps.includes(stepId);

/**
 * Step cards of the contact pairs in step `stepId` (previous step `previousStepId`, null before the first): `*MODEL CHANGE, TYPE=CONTACT PAIR,
 * ADD | REMOVE` for the pairs whose activity changes (a pair starts active, as defined in the model data), then the `*CONTACT FILE` request
 * (`CDIS, CSTR`: the frd CONTACT block the reader takes) at the output rate `rate`.
 * @invariant empty for a case without contact
 */
export function contactStepLines(
  ctx: DeckContext,
  stepId: string,
  previousStepId: string | null,
  rate: string,
): { readonly switches: string[]; readonly output: string[] } {
  const settings = ctx.analysis.contact;
  if (settings === undefined) return { switches: [], output: [] };
  const switches: string[] = [];
  for (const mode of ['REMOVE', 'ADD'] as const) {
    const changing = settings.pairOrder.flatMap((pairId) => {
      const pair = settings.pairs[pairId];
      if (pair === undefined) return [];
      const before = activeIn(pair, previousStepId);
      const now = activeIn(pair, stepId);
      return before !== now && now === (mode === 'ADD') ? [pair] : [];
    });
    if (changing.length === 0) continue;
    switches.push(`*MODEL CHANGE, TYPE=CONTACT PAIR, ${mode}`);
    for (const pair of changing) switches.push(row(pairNames(pair).slave, pairNames(pair).master));
  }
  return { switches, output: [`*CONTACT FILE${rate}`, 'CDIS, CSTR'] };
}
