/** PHY-04 fit dispositions: the human decision on a fit_at_temperature row, with the proof a reader needs to re-verify it. */

/** A fit disposition: the decision, the verified signature (kept so a reader can re-verify it), the hash of the fit inputs and the document signed for. */
export interface FitDisposition {
  readonly decision: 'accepted' | 'rejected' | 'redesign';
  readonly justification: string;
  readonly inputsHash: string;
  readonly signer: string;
  readonly signatureId: string;
  readonly signature: unknown;
  readonly documentUid: string;
}
export type FitDispositions = Readonly<Record<string, FitDisposition>>;

/** A disposition kept in `AnalysisModel.fitLedger` across replay (the recorded step carries no signature): the record plus its row. */
export interface FitLedgerEntry extends FitDisposition {
  readonly rowKey: string;
}
