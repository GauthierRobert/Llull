/**
 * TEMA designation parser (plant 03 EQP §5.7): exactly three letters, front head / shell / rear head. Pure.
 * @failure not three letters -> EQP_TEMA_INVALID path `temaType`; a letter outside its table -> EQP_TEMA_INVALID path `temaType.<index>`
 * @invariant every letter of the table parses (front D, shells K and X included); combinations llull does not build are refused by `exchangerParams`
 */

import { TEMA_FIXED_REARS, TEMA_LETTERS, type TemaPart } from '../data/temaTables';
import type { TemaDesignation } from '../plantData';

export interface TemaRefusal {
  readonly code: 'EQP_TEMA_INVALID';
  readonly message: string;
  readonly path: string;
}

const PARTS: readonly TemaPart[] = ['front', 'shell', 'rear'];
const PART_NAMES: Readonly<Record<TemaPart, string>> = { front: 'front head', shell: 'shell', rear: 'rear head' };

export function parseTema(text: string): { readonly tema: TemaDesignation } | TemaRefusal {
  const letters = text.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(letters))
    return {
      code: 'EQP_TEMA_INVALID',
      message: `TEMA type '${text}' must be exactly three letters (front head, shell, rear head), e.g. BEM, AES, AEU`,
      path: 'temaType',
    };
  for (const [index, part] of PARTS.entries()) {
    const letter = letters[index] as string;
    if (TEMA_LETTERS[part][letter] === undefined)
      return {
        code: 'EQP_TEMA_INVALID',
        message: `'${letter}' is not a TEMA ${PART_NAMES[part]} letter (${Object.keys(TEMA_LETTERS[part]).join(', ')})`,
        path: `temaType.${index}`,
      };
  }
  const [front, shell, rear] = letters.split('') as [string, string, string];
  const fixedTubesheet = TEMA_FIXED_REARS.includes(rear);
  return { tema: { front, shell, rear, fixedTubesheet, removableBundle: !fixedTubesheet } };
}
