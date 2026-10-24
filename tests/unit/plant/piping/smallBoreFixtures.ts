/** Fixtures of the 02 RTE V1 small-bore tests: the pack's socket-weld (SW800) and threaded (THD800) specs on the small-bore catalogue stub. */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { rteJson } from './rteFixtures';

/** An empty mm document holding the small-bore catalogue stub and the spec `specFile` (SW800 or THD800). */
export function smallBoreDocument(specFile: 'spec_sw800.json' | 'spec_thd800.json'): CadDocument {
  const mm = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  const withCatalog = apply(mm, 'import_piping_catalog', { catalog: rteJson('catalog_stub_small_bore.json') });
  return apply(withCatalog, 'import_pipe_spec', { spec: rteJson(specFile) });
}
