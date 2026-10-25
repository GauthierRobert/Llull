/** Reads the 05 ISO validation pack so the tests and the pack cannot drift (TECHNICAL_SPEC §9). */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation/data');

/** The authored fixture PCF (line L-101, DN100) with LF line ends whatever the checkout's autocrlf did. */
export const fixturePcf = (): string => readFileSync(path.join(DATA, 'iso-01-L101-dn100.pcf'), 'utf8').replace(/\r\n/g, '\n');

/** `text` with 1-based line `n` replaced by `replacement` (null = removed). */
export function withLine(text: string, n: number, replacement: string | null): string {
  const lines = text.split('\n');
  if (replacement === null) lines.splice(n - 1, 1);
  else lines[n - 1] = replacement;
  return lines.join('\n');
}
