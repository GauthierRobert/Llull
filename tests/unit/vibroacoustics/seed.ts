/** A document with every part of the vibroacoustics slice populated (slice fuzz seed): spectrum, exposure and a signed accepted review. */

import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { signingContext } from '../../helpers/signedPlantDoc';
import { exposedDocument } from './boxKernel';

export function vibroacousticsDocument(): CadDocument {
  const { doc } = exposedDocument();
  const reviewed = execute(
    doc,
    'dispose_acoustic_export',
    { exposure: 'enclosure_skin', decision: 'accepted', justification: 'seed', confirmation: { nonce: 'seed' } },
    signingContext,
  );
  if (reviewed.error !== undefined) throw new Error(reviewed.summary);
  return reviewed.document;
}
