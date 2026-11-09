/** A document with every part of the corrosion slice populated (slice fuzz seed): environment, material groups, a plated surface system, an isolation and a signed acceptance. */

import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { signingContext } from '../../helpers/signedPlantDoc';
import { pair, run, withEnvironment } from './fixtures';

export function corrosionDocument(): CadDocument {
  const { doc, plate, block } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
  let next = withEnvironment(doc, 'normal');
  next = run(next, 'assign_surface_system', {
    entityIds: [block],
    layers: [{ class: 'conversion_coating' }, { class: 'metallic_plating', galvanicGroup: 'zinc' }],
  });
  const third = execute(next, 'add_box', { size: [1, 1, 1], position: [900, 900, 900] });
  next = run(third.document, 'declare_isolation', { pair: [plate, third.affected[0]], method: 'primer', note: 'seed' });
  const key = `galvanic:${plate}|${block}`;
  const accepted = execute(
    next,
    'accept_corrosion_item',
    { itemKey: key, decision: 'accepted', justification: 'seed', confirmation: { nonce: 'seed' } },
    signingContext,
  );
  if (accepted.error !== undefined) throw new Error(accepted.summary);
  return accepted.document;
}
