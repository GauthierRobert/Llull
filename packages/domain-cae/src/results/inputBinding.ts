/**
 * Binding of imported solver results to the set-up that produced the deck (05 §13): the decks carry `llull inputHash <first 16 hex of the input hash>` in a
 * title field the solver copies into its result file (CalculiX `*HEADING` -> `.frd` header; Nastran `SUBTITLE` -> the OP2 identification records). The marker is
 * found by a tolerant text scan, so the exact field layout of the result file does not matter.
 */

const PREFIX_LENGTH = 16;
const MARKER = /llull inputHash ([0-9a-f]{16})/gi;

/** Marker text written into the deck title (`*HEADING` data line / `SUBTITLE`). */
export const bindingMarker = (inputHash: string): string => `llull inputHash ${inputHash.slice(0, PREFIX_LENGTH)}`;

/** Distinct hash prefixes (lower case) of the markers in `text`; Nastran may upper-case titles, so the match ignores case. */
export function boundHashes(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MARKER)) found.add((match[1] ?? '').toLowerCase());
  return [...found];
}

/** Marker prefixes in the header of a CalculiX `.frd` (everything before the first node / result block). */
export function frdBoundHashes(text: string): string[] {
  const body = text.search(/^ {4}[23]C|^ 100C/m);
  return boundHashes(body < 0 ? text : text.slice(0, body));
}

export type Binding = { readonly kind: 'bound' } | { readonly kind: 'unbound' } | { readonly kind: 'mismatch'; readonly found: string };

/** `bound` when every marker equals the prefix of `inputHash`, `unbound` without markers, else the first differing one. */
export function bindingOf(found: readonly string[], inputHash: string): Binding {
  if (found.length === 0) return { kind: 'unbound' };
  const wrong = found.find((prefix) => prefix !== inputHash.slice(0, PREFIX_LENGTH).toLowerCase());
  return wrong === undefined ? { kind: 'bound' } : { kind: 'mismatch', found: wrong };
}

/** Message of the `FEA_RESULTS_INPUT_MISMATCH` refusal. */
export const mismatchMessage = (found: string): string =>
  `the results file was computed from set-up ${found}…, not the current analysis inputs: re-export the deck (fea_export) and solve it again`;

/** Warning recorded on an import without marker. */
export const UNBOUND_WARNING =
  'FEA_RESULTS_UNBOUND: the file carries no llull input-hash marker, so it cannot be proven to belong to the current set-up (only node ids were checked)';
