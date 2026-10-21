/** Tied face-to-face thermal contact conductance (PHY-03 TR-THM-15): `*SURFACE`, `*SURFACE INTERACTION`, `*GAP CONDUCTANCE`, `*CONTACT PAIR`. */

import type { ThermalContact } from '@core/model/analysis';
import { siToSystem } from './thermalUnits';
import { safeName, type DeckContext, type DeckRefusal } from '../decks/context';
import { commentText, row } from '../decks/format';
import { stressPerMpa } from '../decks/units';
import type { Blocks } from './deckLoads';
import { siOf } from './quantities';

const refusal = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });

/** Deck names of a contact: master surface, slave surface, interaction (upper case, derived from the contact id). */
const contactNames = (contact: ThermalContact): { readonly master: string; readonly slave: string; readonly interaction: string } => {
  const base = safeName(contact.id).toUpperCase();
  return { master: `KM_${base}`, slave: `KS_${base}`, interaction: `KI_${base}` };
};

/**
 * Contact cards of one thermal contact: element-face surfaces from the mesh face sets `K_<id>_M` / `K_<id>_S`, a tied interaction and its gap
 * conductance. CalculiX generates the tied springs between the two (non-conforming) face meshes whatever the clearance, and the conductance
 * acts per area between them. A table row is `conductance, pressure, temperature` (unit-system conductance, pressure; temperature on the case
 * scale; the heat step has no contact pressure, so it is evaluated at 0 pressure and the mean temperature of the two sides).
 * @failure a face set missing from the mesh -> FEA_TARGET_UNRESOLVED (ids: the contact)
 */
export function contactBlocks(ctx: DeckContext, contact: ThermalContact): Blocks {
  const names = contactNames(contact);
  const lines = [`** ${commentText(contact.id)} ${commentText(contact.name)} (tied thermal contact)`];
  for (const [suffix, surface] of [
    ['M', names.master],
    ['S', names.slave],
  ] as const) {
    const faces = ctx.faces(`K_${contact.id}_${suffix}`);
    if (faces.length === 0)
      return refusal(
        'FEA_TARGET_UNRESOLVED',
        `thermal contact '${contact.id}' (${contact.name}) has no ${suffix === 'M' ? 'master' : 'slave'} faces in the mesh`,
        [contact.id],
      );
    lines.push(`*SURFACE, NAME=${surface}, TYPE=ELEMENT`, ...faces.map(([element, face]) => row(element, `S${face}`)));
  }
  const conductance = contact.conductance;
  const data =
    'points' in conductance
      ? conductance.points.map(([value, pressureMpa, temperature]) =>
          row(siToSystem('film', value, ctx.unitSystem), pressureMpa * stressPerMpa(ctx.unitSystem), temperature),
        )
      : [row(siToSystem('film', siOf('film', conductance), ctx.unitSystem), 0)];
  lines.push(
    `*SURFACE INTERACTION, NAME=${names.interaction}`,
    '*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED',
    '*GAP CONDUCTANCE',
    ...data,
    `*CONTACT PAIR, INTERACTION=${names.interaction}, TYPE=SURFACE TO SURFACE`,
    row(names.slave, names.master),
  );
  return { lines };
}
