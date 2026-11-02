/**
 * TEMA designation parser (plant 03 EQP §5.7): exactly three letters, front head / shell / rear head. Pure.
 * @failure not three letters -> EQP_TEMA_INVALID path `temaType`; a letter outside its table -> EQP_TEMA_INVALID path `temaType.<index>`
 * @invariant a valid letter llull does not model (front D, shell K and X) still parses: the designation is returned with `unsupported` set
 *   (EQP_TEMA_UNSUPPORTED, path `temaType.<index>`), so the designation table stays complete (VC-EQP-11 parses AKT)
 */

import { TEMA_FIXED_REARS, TEMA_LETTERS, TEMA_UNSUPPORTED, type TemaPart } from '../data/temaTables';
import type { TemaDesignation } from '../plantData';

export interface TemaRefusal {
  readonly code: 'EQP_TEMA_INVALID' | 'EQP_TEMA_UNSUPPORTED';
  readonly message: string;
  readonly path: string;
}

const PARTS: readonly TemaPart[] = ['front', 'shell', 'rear'];
const PART_NAMES: Readonly<Record<TemaPart, string>> = { front: 'front head', shell: 'shell', rear: 'rear head' };

export function parseTema(text: string): { readonly tema: TemaDesignation; readonly unsupported: TemaRefusal | null } | TemaRefusal {
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
  const unsupportedIndex = PARTS.findIndex((part, index) => TEMA_UNSUPPORTED[part].includes(letters[index] as string));
  const unsupportedPart = PARTS[unsupportedIndex];
  const unsupportedLetter = letters[unsupportedIndex] as string;
  const unsupported: TemaRefusal | null =
    unsupportedPart === undefined
      ? null
      : {
          code: 'EQP_TEMA_UNSUPPORTED',
          message: `TEMA ${PART_NAMES[unsupportedPart]} letter '${unsupportedLetter}' (${TEMA_LETTERS[unsupportedPart][unsupportedLetter]}) is valid but not modelled yet`,
          path: `temaType.${unsupportedIndex}`,
        };
  const [front, shell, rear] = letters.split('') as [string, string, string];
  const fixedTubesheet = TEMA_FIXED_REARS.includes(rear);
  return { tema: { front, shell, rear, fixedTubesheet, removableBundle: !fixedTubesheet }, unsupported };
}
