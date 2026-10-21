/** add_thermal_contact / update_thermal_contact (PHY-03 V1): contact conductances between two parts, recorded as data. */

import type { FeaTarget, Q, ThermalContact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem, type ThermalCase } from './access';
import { refuseThermal } from './codes';
import { quantityProblem } from './quantities';

const conductanceSchema = z.union([
  quantitySchema,
  z.object({
    points: z
      .array(z.tuple([z.number(), z.number(), z.number()]))
      .describe('Rows [conductance W/(m^2*K), contact pressure MPa, temperature].'),
  }),
]);

type Conductance = Q | { readonly points: ReadonlyArray<readonly [number, number, number]> };

function conductanceProblem(conductance: Conductance): string | null {
  if ('points' in conductance) {
    if (conductance.points.length === 0) return 'the conductance table is empty';
    if (conductance.points.some((row) => !row.every(Number.isFinite) || !(row[0] > 0)))
      return 'conductance table rows must be finite with conductance > 0';
    return null;
  }
  return quantityProblem('film', conductance) ?? (conductance.value > 0 ? null : 'conductance must be > 0');
}

const sameFace = (a: FeaTarget, b: FeaTarget): boolean => a.entityId === b.entityId;

/** First problem of a contact definition (targets resolvable on two different parts, usable conductance), or null. */
function contactProblem(
  doc: CadDocument,
  found: ThermalCase,
  master: FeaTarget,
  slave: FeaTarget,
  conductance: Conductance,
): Problem | null {
  for (const [path, target] of [
    ['master', master],
    ['slave', slave],
  ] as const) {
    const bad = targetProblem(doc, found.analysisCase, target);
    if (bad !== null) return problem(bad.code, bad.message, [target.entityId], [path]);
    if ((target.facesNear ?? []).length === 0)
      return problem('FEA_TARGET_UNRESOLVED', `${path} needs facesNear`, [target.entityId], [path]);
  }
  if (sameFace(master, slave)) return problem('THM_CONTACT_INVALID', 'master and slave are on the same part', [master.entityId], ['slave']);
  const bad = conductanceProblem(conductance);
  if (bad === null) return null;
  return problem(
    'unit' in conductance && quantityProblem('film', conductance) !== null ? 'THM_UNITS_MISMATCH' : 'THM_CONTACT_INVALID',
    bad,
    [found.analysisCase.id],
    ['conductance'],
  );
}

/**
 * @affects doc.analysis.cases[analysisId].thermal.contacts (adds 1 contact, id `tc-<step>.<k>`; affected: [contactId])
 * @invariant master and slave are face targets on DIFFERENT parts; conductance > 0 (W/(m^2*K), or a table)
 * @failure same part / bad conductance -> THM_CONTACT_INVALID; wrong unit -> THM_UNITS_MISMATCH; bad targets (refusals, unchanged doc)
 * @note the deck writes a tied `*CONTACT PAIR` (surface to surface) with `*GAP CONDUCTANCE`; the two parts are meshed separately, so the face meshes need not match
 */
export const addThermalContact = defineCommand({
  name: 'add_thermal_contact',
  description:
    'Record a thermal contact conductance between a master face and a slave face of two different parts (bolted interface on a cold ' +
    'plate); returns the contact id in affected[0]. conductance: { value, unit "W/(m^2*K)" } or { points: [[W/(m^2*K), pressureMPa, T], ...] }. ' +
    'The deck ties the two faces thermally (CalculiX tied *CONTACT PAIR with *GAP CONDUCTANCE); the parts are meshed separately, so the ' +
    'two face meshes need not match. A table is evaluated at the mean temperature of the two faces (temperature on the case scale) and at ' +
    'zero contact pressure, so give the pressure column 0 unless it varies nothing. Check the result with analysis_report. Change it later ' +
    'with update_thermal_contact, remove it with delete_analysis_item.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "box to plate".'),
    master: feaTargetSchema.describe('Master face (facesNear points) on one part.'),
    slave: feaTargetSchema.describe('Slave face (facesNear points) on another part.'),
    conductance: conductanceSchema.describe('Interface conductance.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, name, conductance } = params;
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'add_thermal_contact', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const master = toTarget(params.master);
    const slave = toTarget(params.slave);
    const bad = contactProblem(doc, found, master, slave, conductance);
    if (bad !== null) return fail(bad);
    const contact: ThermalContact = { id: nextId('tc'), name, master, slave, conductance };
    const thermal = { ...found.thermal, contacts: { ...found.thermal.contacts, [contact.id]: contact } };
    return changed(
      withThermal(doc, found, thermal),
      `add_thermal_contact: '${contact.id}' (${name}) between '${master.entityId}' and '${slave.entityId}' in '${analysisId}' (tied contact conductance).`,
      [contact.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].thermal.contacts[contactId] (replaces the given fields; id kept; affected: [contactId])
 * @invariant the merged contact satisfies the add_thermal_contact invariants; at least one field is given
 * @failure unknown analysis / contact -> refusal (THM_CONTACT_NOT_FOUND); nothing to change, same part, bad conductance / unit / target (refusals, unchanged doc)
 */
export const updateThermalContact = defineCommand({
  name: 'update_thermal_contact',
  description:
    'Change a thermal contact of a heat_* analysis (id = affected[0] of add_thermal_contact): give any of name, master, slave, ' +
    'conductance; fields you omit keep their value. The merged contact is validated like add_thermal_contact (two different parts, ' +
    'facesNear on both, conductance > 0 in W/(m^2*K) or a table). Re-mesh and re-solve afterwards: the recorded results become stale.',
  params: z.object({
    analysisId: analysisIdSchema,
    contactId: z.string().describe('Contact id (affected[0] of add_thermal_contact).'),
    name: z.string().min(1).optional().describe('New display name.'),
    master: feaTargetSchema.optional().describe('New master face (facesNear points) on one part.'),
    slave: feaTargetSchema.optional().describe('New slave face (facesNear points) on another part.'),
    conductance: conductanceSchema.optional().describe('New interface conductance.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, contactId } = params;
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'update_thermal_contact', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const current = Object.hasOwn(found.thermal.contacts, contactId) ? found.thermal.contacts[contactId] : undefined;
    if (current === undefined)
      return fail(
        problem('THM_CONTACT_NOT_FOUND', `no thermal contact '${contactId}' in '${analysisId}'`, [analysisId, contactId], ['contactId']),
      );
    if (params.name === undefined && params.master === undefined && params.slave === undefined && params.conductance === undefined)
      return fail(
        problem('THM_CONTACT_INVALID', 'give at least one of name, master, slave, conductance', [analysisId, contactId], ['name']),
      );
    const next: ThermalContact = {
      id: current.id,
      name: params.name ?? current.name,
      master: params.master === undefined ? current.master : toTarget(params.master),
      slave: params.slave === undefined ? current.slave : toTarget(params.slave),
      conductance: params.conductance ?? current.conductance,
    };
    const bad = contactProblem(doc, found, next.master, next.slave, next.conductance);
    if (bad !== null) return fail(bad);
    const thermal = { ...found.thermal, contacts: { ...found.thermal.contacts, [contactId]: next } };
    return changed(
      withThermal(doc, found, thermal),
      `update_thermal_contact: '${contactId}' (${next.name}) between '${next.master.entityId}' and '${next.slave.entityId}' in '${analysisId}' updated.`,
      [contactId],
    );
  },
});
