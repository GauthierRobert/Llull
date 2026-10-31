/** ISO-M2 test fixtures: the pack's L-101 line stored with import_pcf, and a few shaped variants. */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { fixturePcf } from './fabricationFixtures';

/** A document holding the L-101 fixture as an imported line. */
export const loadedL101 = (text: string = fixturePcf()): CadDocument => apply(createEmptyDocument(), 'import_pcf', { text });

/** `pcf:L-101:7` -> `7` (the reference numbers of expected.json). */
export const refNumber = (id: string): string => id.split(':').pop() ?? id;

export const refNumbers = (ids: readonly string[]): string[] => ids.map(refNumber);

/** The fixture with its site weld (SKEY WS) changed to `skey`. */
export const withWeldSkey = (skey: string): string => fixturePcf().replace('    SKEY WS', `    SKEY ${skey}`);

/** The fixture without its WELD record (component 3): one spool. */
export const withoutWeld = (): string => {
  const text = fixturePcf();
  const start = text.indexOf('WELD\n');
  const end = text.indexOf('PIPE\n', start);
  return text.slice(0, start) + text.slice(end);
};
