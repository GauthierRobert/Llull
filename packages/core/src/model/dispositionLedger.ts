/** Margin / thermal-limit dispositions a human really signed, kept across replay (the recorded step carries no signature). */

/** One signed disposition: the act, the case and row it applies to, the decision, the signature the port verified (kept for re-verification) and the document signed for. */
export interface DispositionLedgerEntry {
  readonly act: 'dispose_margin' | 'dispose_thermal_limit';
  readonly analysisId: string;
  /** The stored key of the row: the margin `rowKey` (dispose_margin) or the limit `rowId` (dispose_thermal_limit). */
  readonly rowKey: string;
  readonly decision: 'accepted' | 'rejected' | 'redesign';
  readonly justification: string;
  readonly resultsHash: string;
  readonly signer: string;
  readonly signatureId: string;
  readonly signature: unknown;
  readonly documentUid: string;
}
