/** delete_analysis_item: removes one set-up record (constraint, load, probe, thermal BC / contact / limit / amplitude, explicit contact / motion / wall) of an analysis by id. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';
import { explicitCase, withSpec } from '../explicit/model';
import { isProblem, thermalCaseOf, withThermal, type ThermalCase } from '../thermal/access';
import { refuseThermal } from '../thermal/codes';

const NAME = 'delete_analysis_item';

const without = <T>(bag: Readonly<Record<string, T>>, id: string): Record<string, T> =>
  Object.fromEntries(Object.entries(bag).filter(([key]) => key !== id));

/** One family of removable records: `null` when `id` is not one of its records, else the result of removing it. */
type Remover = (doc: CadDocument, analysisCase: AnalysisCase, id: string) => CommandResult | null;

const done = (doc: CadDocument, kind: string, id: string, analysisId: string, affected: string[]): CommandResult =>
  changed(doc, `${NAME}: removed ${kind} '${id}' from '${analysisId}'.`, affected);

const mechanical: Remover = (doc, analysisCase, id) => {
  const analysisId = analysisCase.id;
  if (Object.hasOwn(analysisCase.constraints, id))
    return done(
      withCase(doc, {
        ...analysisCase,
        constraints: without(analysisCase.constraints, id),
        constraintOrder: analysisCase.constraintOrder.filter((other) => other !== id),
      }),
      'constraint',
      id,
      analysisId,
      [id],
    );
  if (Object.hasOwn(analysisCase.loads, id))
    return done(
      withCase(doc, {
        ...analysisCase,
        loads: without(analysisCase.loads, id),
        loadOrder: analysisCase.loadOrder.filter((other) => other !== id),
      }),
      'load',
      id,
      analysisId,
      [id],
    );
  if (Object.hasOwn(analysisCase.probes, id))
    return done(withCase(doc, { ...analysisCase, probes: without(analysisCase.probes, id) }), 'probe', id, analysisId, [id]);
  return null;
};

function thermalRemove(doc: CadDocument, found: ThermalCase, id: string): CommandResult | null {
  const { thermal } = found;
  const analysisId = found.analysisCase.id;
  if (Object.hasOwn(thermal.bcs, id))
    return done(
      withThermal(doc, found, { ...thermal, bcs: without(thermal.bcs, id), bcOrder: thermal.bcOrder.filter((other) => other !== id) }),
      'thermal BC',
      id,
      analysisId,
      [id],
    );
  if (Object.hasOwn(thermal.contacts, id))
    return done(withThermal(doc, found, { ...thermal, contacts: without(thermal.contacts, id) }), 'thermal contact', id, analysisId, [id]);
  if (Object.hasOwn(thermal.limits, id))
    return done(
      withThermal(doc, found, {
        ...thermal,
        limits: without(thermal.limits, id),
        limitOrder: thermal.limitOrder.filter((other) => other !== id),
        dispositions: Object.fromEntries(Object.entries(thermal.dispositions).filter(([row]) => !row.startsWith(`${id}:`))),
      }),
      'temperature limit',
      id,
      analysisId,
      [id],
    );
  if (!Object.hasOwn(thermal.amplitudes, id)) return null;
  const users = Object.values(thermal.bcs).filter((record) => record.amplitude === id);
  if (users.length > 0)
    return refuseThermal(doc, NAME, 'THM_AMPLITUDE_IN_USE', `amplitude '${id}' is used by ${users.map((user) => user.id).join(', ')}`, [
      id,
      ...users.map((user) => user.id),
    ]);
  return done(withThermal(doc, found, { ...thermal, amplitudes: without(thermal.amplitudes, id) }), 'amplitude', id, analysisId, [id]);
}

const thermalItems: Remover = (doc, analysisCase, id) => {
  const found = thermalCaseOf(doc, analysisCase.id);
  return isProblem(found) ? null : thermalRemove(doc, found, id);
};

const explicitItems: Remover = (doc, analysisCase, id) => {
  const found = explicitCase(doc, analysisCase.id);
  if ('code' in found || found.spec === undefined) return null;
  const { spec } = found;
  const analysisId = analysisCase.id;
  if (spec.contacts !== undefined && Object.hasOwn(spec.contacts, id))
    return done(
      withSpec(doc, found.analysisCase, {
        ...spec,
        contacts: without(spec.contacts, id),
        contactOrder: (spec.contactOrder ?? []).filter((other) => other !== id),
      }),
      'explicit contact',
      id,
      analysisId,
      [analysisId],
    );
  if (spec.imposedMotions !== undefined && Object.hasOwn(spec.imposedMotions, id))
    return done(
      withSpec(doc, found.analysisCase, {
        ...spec,
        imposedMotions: without(spec.imposedMotions, id),
        imposedMotionOrder: (spec.imposedMotionOrder ?? []).filter((other) => other !== id),
      }),
      'imposed motion',
      id,
      analysisId,
      [analysisId],
    );
  if (!Object.hasOwn(spec.rigidWalls, id)) return null;
  return done(
    withSpec(doc, found.analysisCase, {
      ...spec,
      rigidWalls: without(spec.rigidWalls, id),
      rigidWallOrder: spec.rigidWallOrder.filter((other) => other !== id),
    }),
    'rigid wall',
    id,
    analysisId,
    [analysisId],
  );
};

const REMOVERS: readonly Remover[] = [mechanical, thermalItems, explicitItems];

/**
 * @affects doc.analysis.cases[analysisId] (removes 1 record; affected: [itemId] for constraints, loads, probes and thermal records, [analysisId] for explicit records)
 * @invariant cascade per kind: a temperature limit also drops the dispositions of its rows; an amplitude still used by a thermal BC is refused (THM_AMPLITUDE_IN_USE)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; id is no record of the analysis -> FEA_ITEM_NOT_FOUND (unchanged doc)
 */
export const deleteAnalysisItem = defineCommand({
  name: NAME,
  description:
    'Remove one set-up record from an analysis by its id: a constraint (fc-), load (fl-), result probe (pr-), thermal BC (tb-), thermal contact (tc-), ' +
    'temperature limit (tl-, also drops its dispositions), thermal amplitude (am-, refused while a thermal BC uses it), explicit contact (ct-), ' +
    'imposed motion (im-) or rigid wall (rw-). The id is affected[0] of the add_* / define_* command that created it (affected[1] for explicit ' +
    'records). Results become stale; the recorded mesh stays. To remove the whole analysis use delete_analysis.',
  annotations: { destructive: true },
  params: z.object({
    analysisId: analysisIdSchema,
    itemId: z.string().describe('Id of the record to remove (fc-, fl-, pr-, tb-, tc-, tl-, am-, ct-, im- or rw- prefix, e.g. fl-3.1).'),
  }),
  run: (doc, { analysisId, itemId }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, NAME, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    for (const remover of REMOVERS) {
      const result = remover(doc, analysisCase, itemId);
      if (result !== null) return result;
    }
    return refuseCode(
      doc,
      NAME,
      'FEA_ITEM_NOT_FOUND',
      `no constraint, load, probe or thermal / explicit record '${itemId}' in '${analysisId}'`,
      [analysisId, itemId],
    );
  },
});
