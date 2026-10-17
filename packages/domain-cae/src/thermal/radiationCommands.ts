/** add_cavity_radiation / add_thermal_contact (PHY-03 V1): cavity radiation groups and contact conductances, recorded as data. */

import type { CavityRadiation, FeaTarget, Q, ThermalContact } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { cavityNameProblem } from '../shared/names';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem } from './access';
import { refuseThermal } from './codes';
import { quantityProblem } from './quantities';

/**
 * @affects doc.analysis.cases[analysisId].thermal.cavities (adds 1 cavity, id `cv-<step>.<k>`; affected: [cavityId])
 * @invariant name 1-3 characters and unique; >= 2 faces, each with emissivity in [0, 1] on a part; environment open (temperature) or closed
 * @failure name too long / duplicate / < 2 faces -> THM_CAVITY_INVALID; emissivity outside [0, 1] -> THM_EMISSIVITY_INVALID; bad target;
 *   bad temperature -> THM_UNITS_MISMATCH (refusals, unchanged doc)
 */
export const addCavityRadiation = defineCommand({
  name: 'add_cavity_radiation',
  description:
    'Group faces into a radiation cavity of a heat_* analysis (CalculiX *RADIATE, CAVITY with view factors computed by the solver); ' +
    'returns the cavity id in affected[0]. name: 1-3 letters, digits or underscores, unique. faces: at least 2 { target (facesNear), emissivity 0-1 }. ' +
    'environmentTemperature { value, unit } makes the cavity OPEN (the remainder radiates to that temperature); omit it for a CLOSED ' +
    'cavity (view factors scaled to 1). Check the geometry first with compute_view_factors. Radiation is evaluated on absolute temperature.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z
      .string()
      .min(1)
      .describe('Cavity name, 1-3 letters, digits or underscores (CalculiX limit), unique in the analysis, e.g. "C1".'),
    environmentTemperature: quantitySchema
      .optional()
      .describe('Open cavity: temperature { value, unit } the unclosed part of the view radiates to. Omit for a closed cavity.'),
    faces: z
      .array(
        z.object({
          target: feaTargetSchema.describe('Radiating faces of a part (facesNear points).'),
          emissivity: z.number().describe('Hemispherical emissivity of these faces, 0 to 1.'),
        }),
      )
      .describe('At least 2 radiating face groups.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, name, environmentTemperature, faces } = params;
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'add_cavity_radiation', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const cavityError = (message: string, path = 'name'): CommandResult =>
      fail(problem('THM_CAVITY_INVALID', message, [analysisId], [path]));
    const nameProblem = cavityNameProblem(name);
    if (nameProblem !== null) return cavityError(nameProblem);
    if (Object.values(found.thermal.cavities).some((cavity) => cavity.name.toUpperCase() === name.toUpperCase()))
      return cavityError(`a cavity named '${name}' exists`);
    if (faces.length < 2) return cavityError('a cavity needs at least 2 faces', 'faces');
    for (const [index, face] of faces.entries()) {
      if (!Number.isFinite(face.emissivity) || face.emissivity < 0 || face.emissivity > 1)
        return fail(
          problem(
            'THM_EMISSIVITY_INVALID',
            `faces[${index}].emissivity ${face.emissivity} is outside [0, 1]`,
            [analysisId],
            [`faces[${index}].emissivity`],
          ),
        );
      const target = toTarget(face.target);
      const bad = targetProblem(doc, found.analysisCase, target);
      if (bad !== null) return fail(problem(bad.code, bad.message, [target.entityId], [`faces[${index}].target`]));
      if ((target.facesNear ?? []).length === 0)
        return fail(problem('FEA_TARGET_UNRESOLVED', `faces[${index}] needs facesNear`, [target.entityId], [`faces[${index}].target`]));
    }
    const environment = environmentTemperature === undefined ? null : quantityProblem('temperature', environmentTemperature);
    if (environment !== null) return fail(problem('THM_UNITS_MISMATCH', environment, [analysisId], ['environmentTemperature']));
    const cavity: CavityRadiation = {
      id: nextId('cv'),
      name,
      environment: environmentTemperature === undefined ? { kind: 'closed' } : { kind: 'open', temperature: environmentTemperature },
      faces: faces.map((face) => ({ target: toTarget(face.target), emissivity: face.emissivity })),
    };
    const thermal = { ...found.thermal, cavities: { ...found.thermal.cavities, [cavity.id]: cavity } };
    return changed(
      withThermal(doc, found, thermal),
      `add_cavity_radiation: '${cavity.id}' (${name}) ${cavity.environment.kind} cavity of ${faces.length} faces in '${analysisId}'.`,
      [cavity.id],
    );
  },
});

const conductanceSchema = z.union([
  quantitySchema,
  z.object({
    points: z
      .array(z.tuple([z.number(), z.number(), z.number()]))
      .describe('Rows [conductance W/(m^2*K), contact pressure MPa, temperature].'),
  }),
]);

function conductanceProblem(conductance: Q | { readonly points: ReadonlyArray<readonly [number, number, number]> }): string | null {
  if ('points' in conductance) {
    if (conductance.points.length === 0) return 'the conductance table is empty';
    if (conductance.points.some((row) => !row.every(Number.isFinite) || !(row[0] > 0)))
      return 'conductance table rows must be finite with conductance > 0';
    return null;
  }
  return quantityProblem('film', conductance) ?? (conductance.value > 0 ? null : 'conductance must be > 0');
}

const sameFace = (a: FeaTarget, b: FeaTarget): boolean => a.entityId === b.entityId;

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
    'zero contact pressure, so give the pressure column 0 unless it varies nothing. Check the result with thermal_report.',
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
    for (const [path, target] of [
      ['master', master],
      ['slave', slave],
    ] as const) {
      const bad = targetProblem(doc, found.analysisCase, target);
      if (bad !== null) return fail(problem(bad.code, bad.message, [target.entityId], [path]));
      if ((target.facesNear ?? []).length === 0)
        return fail(problem('FEA_TARGET_UNRESOLVED', `${path} needs facesNear`, [target.entityId], [path]));
    }
    if (sameFace(master, slave))
      return fail(problem('THM_CONTACT_INVALID', 'master and slave are on the same part', [master.entityId], ['slave']));
    const bad = conductanceProblem(conductance);
    if (bad !== null)
      return fail(
        problem(
          'unit' in conductance && quantityProblem('film', conductance) !== null ? 'THM_UNITS_MISMATCH' : 'THM_CONTACT_INVALID',
          bad,
          [analysisId],
          ['conductance'],
        ),
      );
    const contact: ThermalContact = { id: nextId('tc'), name, master, slave, conductance };
    const thermal = { ...found.thermal, contacts: { ...found.thermal.contacts, [contact.id]: contact } };
    return changed(
      withThermal(doc, found, thermal),
      `add_thermal_contact: '${contact.id}' (${name}) between '${master.entityId}' and '${slave.entityId}' in '${analysisId}' (tied contact conductance).`,
      [contact.id],
    );
  },
});
