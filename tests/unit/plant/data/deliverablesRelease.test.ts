/**
 * Plant 08 DAT-M6 and the 09 PLM release lock. `doc.plant.data.deliverables` is part of the definition (the release scope covers the `plant` slice), so a managed item whose
 * revision is released refuses a status change with PLM_LOCKED (revise the item first); while the revision is in work the change is allowed.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { getPlantData } from '@aec/plant/data/model';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { inWork, released } from '../../plm/fixtures';

const params = { deliverable: 'tag_register', revision: 'A', status: 'in_work' };

describe('set_deliverable_status and the PLM release lock', () => {
  it('a released revision refuses the status change (PLM_LOCKED); the document is unchanged', () => {
    expectRefusal(released(), 'set_deliverable_status', params, 'PLM_LOCKED');
  });

  it('an in-work revision accepts it', () => {
    const result = execute(inWork(), 'set_deliverable_status', params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(getPlantData(result.document).deliverables?.['tag_register']?.revisions).toHaveLength(1);
  });
});
