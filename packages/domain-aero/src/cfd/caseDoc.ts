/** Access to the plugin's document slice (`CadDocument.cfd`) and the canonical hash of a case. */

import type { CadDocument } from '@core/model/types';
import type { CfdCase, CfdDocumentSlice } from '@aero/cfd/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

const EMPTY: CfdDocumentSlice = { cases: {}, results: {} };

export const cfdSlice = (doc: CadDocument): CfdDocumentSlice => doc.cfd ?? EMPTY;

/** `doc` with `patch` merged into its cfd slice. */
export const withCfd = (doc: CadDocument, patch: Partial<CfdDocumentSlice>): CadDocument => ({
  ...doc,
  cfd: { ...cfdSlice(doc), ...patch },
});

export const caseOf = (doc: CadDocument, caseId: string): CfdCase | undefined => {
  const cases = cfdSlice(doc).cases;
  return Object.hasOwn(cases, caseId) ? cases[caseId] : undefined;
};

/** Case ids in creation order (insertion order of the record). */
export const caseIds = (doc: CadDocument): string[] => Object.keys(cfdSlice(doc).cases);

/** sha256 of the canonical JSON of the case: a result is stale when this differs from the recorded `caseHash`. */
export const caseHashOf = (cfdCase: CfdCase): string => sha256Hex(canonicalJson(cfdCase));
