/** add_contact / delete_contact: penalty contacts of an explicit case (RS1 RS-8c, PHY-19 TECHNICAL_SPEC §13.7). */

import type { ExplicitContact, ExplicitSpec } from '@core/model/explicit';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { DEFAULT_PENALTY_SCALE } from './defaults';
import { explicitCase, withSpec } from './model';

type Fail = (code: string, message: string, paths?: readonly string[]) => CommandResult;

function controlled(
  doc: CadDocument,
  analysisId: string,
  fail: Fail,
): CommandResult | { readonly analysisCase: AnalysisCase; readonly spec: ExplicitSpec } {
  const found = explicitCase(doc, analysisId);
  if ('code' in found) return fail(found.code, found.message);
  if (found.spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
  return { analysisCase: found.analysisCase, spec: found.spec };
}

/**
 * @affects doc.analysis.cases[analysisId].explicit.contacts (adds 1 contact; affected: [analysisId, contactId])
 * @invariant ids `ct-<step>.<k>`; the penalty scale is a named default (0.1, LS-DYNA SLSFAC) unless given; friction defaults to none
 * @failure unknown / non-explicit case / no controls -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE / EXP_CONTROLS_MISSING; an entity that is not
 *   a part of the case -> EXP_TARGET_NOT_IN_CASE; missing or extra side, duplicate name, negative friction, non-positive scale ->
 *   EXP_CONTACT_INVALID
 */
export const addContact = defineCommand({
  name: 'add_contact',
  description:
    'Add a penalty contact to an explicit_dynamics case (llull_explicit, CPU path): surface_to_surface checks the exterior faces of parts a ' +
    'and b both ways; nodes_to_surface checks the nodes of a against the faces of b (one way: use it for a body sliding on a surface, a = ' +
    'the sliding body); self checks the parts of a against themselves (folding, buckling). Penalty force k|penetration| with k = scale x ' +
    'bulk modulus x face area^2 / element volume (LS-DYNA form, scale 0.1 named default). Optional Coulomb friction {static, dynamic, ' +
    'decay}: mu = dynamic + (static - dynamic) exp(-decay x slip speed). Returns the contact id in affected[1].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Unique contact name, e.g. "impact".'),
    kind: z.enum(['surface_to_surface', 'nodes_to_surface', 'self']).describe('Pairing (see the description).'),
    a: z.array(z.string()).describe('Entity ids of side a (parts of the case); the sliding / impacting body of nodes_to_surface.'),
    b: z.array(z.string()).optional().describe('Entity ids of side b; required except for self.'),
    friction: z
      .object({
        static: z.number().describe('Static coefficient, >= 0.'),
        dynamic: z.number().optional().describe('Dynamic coefficient, >= 0; default = static.'),
        decay: z.number().optional().describe('Decay constant of mu(slip speed), >= 0, in time/length of the case units; default 0.'),
      })
      .optional()
      .describe('Coulomb friction; default none.'),
    penaltyScale: z
      .object({ value: z.number().describe('Scale, > 0.'), source: z.string().min(1).describe('Where the value comes from.') })
      .optional()
      .describe('Penalty scale f_si; default 0.1 (named, LS-DYNA SLSFAC).'),
  }),
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, paths = []) => refuseExplicit(doc, 'add_contact', code, message, [params.analysisId], paths);
    const found = controlled(doc, params.analysisId, fail);
    if ('document' in found) return found;
    const { analysisCase, spec } = found;
    const b = params.b ?? [];
    const outside = [...params.a, ...b].filter((id) => !Object.hasOwn(analysisCase.parts, id));
    if (outside.length > 0) return fail('EXP_TARGET_NOT_IN_CASE', `${outside.join(', ')} not part(s) of '${params.analysisId}'`, ['a']);
    if (params.a.length === 0 || (params.kind === 'self') !== (b.length === 0))
      return fail('EXP_CONTACT_INVALID', `${params.kind} needs a non-empty a${params.kind === 'self' ? ' and no b' : ' and b'}`, ['b']);
    const contacts = spec.contacts ?? {};
    if (Object.values(contacts).some((contact) => contact.name === params.name))
      return fail('EXP_CONTACT_INVALID', `a contact named '${params.name}' exists already`, ['name']);
    const friction = {
      static: params.friction?.static ?? 0,
      dynamic: params.friction?.dynamic ?? params.friction?.static ?? 0,
      decay: params.friction?.decay ?? 0,
    };
    if (!(friction.static >= 0 && friction.dynamic >= 0 && friction.decay >= 0))
      return fail('EXP_CONTACT_INVALID', 'friction coefficients and decay must be >= 0', ['friction']);
    if (params.penaltyScale !== undefined && !(params.penaltyScale.value > 0))
      return fail('EXP_CONTACT_INVALID', 'penaltyScale must be > 0', ['penaltyScale']);
    const contact: ExplicitContact = {
      name: params.name,
      kind: params.kind,
      a: params.a,
      b,
      friction,
      penaltyScale: params.penaltyScale === undefined ? DEFAULT_PENALTY_SCALE() : { ...params.penaltyScale, defaulted: false },
    };
    const id = nextId('ct');
    const next: ExplicitSpec = { ...spec, contacts: { ...contacts, [id]: contact }, contactOrder: [...(spec.contactOrder ?? []), id] };
    return changed(
      withSpec(doc, analysisCase, next),
      `add_contact: ${id} '${params.name}' ${params.kind} [${params.a.join(', ')}]${b.length > 0 ? ` / [${b.join(', ')}]` : ''}, friction ${friction.static} / ${friction.dynamic}, penalty scale ${contact.penaltyScale.value}${contact.penaltyScale.defaulted ? ' (default)' : ''} in ${params.analysisId}.`,
      [params.analysisId, id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].explicit.contacts (removes 1 contact)
 * @failure no controls -> EXP_CONTROLS_MISSING; unknown contact -> EXP_CONTACT_NOT_FOUND
 */
export const deleteContact = defineCommand({
  name: 'delete_contact',
  description: 'Remove a penalty contact (by id, affected[1] of add_contact) from an explicit_dynamics case.',
  params: z.object({ analysisId: analysisIdSchema, contactId: z.string().describe('Contact id, e.g. ct-12.1.') }),
  run: (doc, { analysisId, contactId }): CommandResult => {
    const fail: Fail = (code, message, paths = []) => refuseExplicit(doc, 'delete_contact', code, message, [analysisId], paths);
    const found = controlled(doc, analysisId, fail);
    if ('document' in found) return found;
    const { analysisCase, spec } = found;
    if (spec.contacts === undefined || !Object.hasOwn(spec.contacts, contactId))
      return fail('EXP_CONTACT_NOT_FOUND', `no contact '${contactId}' in '${analysisId}'`, ['contactId']);
    const contacts = Object.fromEntries(Object.entries(spec.contacts).filter(([id]) => id !== contactId));
    const order = (spec.contactOrder ?? []).filter((id) => id !== contactId);
    return changed(
      withSpec(doc, analysisCase, { ...spec, contacts, contactOrder: order }),
      `delete_contact: ${contactId} removed from ${analysisId}.`,
      [analysisId],
    );
  },
});
