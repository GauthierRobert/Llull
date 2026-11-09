/** A document with every part of the electroOptical slice populated (slice fuzz seed): paths, a coating assignment and a signed disposition. */

import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { signingContext } from '../../helpers/signedPlantDoc';
import { run, runPlan } from './fixtures';

export function electroOpticalDocument(): CadDocument {
  const { doc, aliases } = runPlan('eop_bonding_paths.plan.json', 'check_bonding');
  let next = run(doc, 'define_material_record', {
    id: 'seed_coating',
    designation: 'seed',
    productForm: 'coating',
    specs: [],
    licence: 'company-proprietary',
    exportMarking: { regime: 'none' },
  });
  next = run(next, 'assign_surface_coating', {
    entityId: aliases['structure'],
    coating: 'seed_coating',
    location: 'bonded_interface',
    electrical: 'conductive',
    source: { citation: 'seed' },
  });
  const disposed = execute(
    next,
    'dispose_bond_check',
    { pathId: aliases['p2'], decision: 'accepted', justification: 'seed', confirmation: { nonce: 'seed' } },
    signingContext,
  );
  if (disposed.error !== undefined) throw new Error(disposed.summary);
  return disposed.document;
}
