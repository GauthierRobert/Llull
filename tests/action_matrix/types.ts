/** Shared types of the action matrix (SC-Q2): one row per design x command x target. */

export type KernelColumn = 'manifold' | 'occt';

/** ok: the doc changed and the result is sound. refused: clean no-op. unsupported: the kernel lacks the op. error: a finding. */
export type Outcome = 'ok' | 'refused' | 'unsupported' | 'error';

/** What made an `error` row (never allowed in the baseline). */
export type ErrorKind = 'throw' | 'nonfinite' | 'invalid_solid' | 'purity' | 'refused_changed';

export interface MatrixRow {
  /** `design|command|target`. */
  readonly key: string;
  readonly design: string;
  readonly command: string;
  readonly target: string;
  readonly outcome: Outcome;
  readonly errorKind?: ErrorKind;
  /** First line of the command summary (or the error reason). */
  readonly detail: string;
  /** Volume of the first affected 3D entity, as the IEEE-754 bit pattern (hex) for the bit-for-bit determinism comparison. */
  readonly volumeBits: string | null;
  /** The same volume as a number, for reports. */
  readonly volume: number | null;
  /** Ids of the affected entities (deterministic per document), compared by the determinism mode. */
  readonly affected: readonly string[];
}

export interface DesignCost {
  readonly design: string;
  readonly ms: number;
  readonly actions: number;
}

export interface Design {
  readonly id: string;
  readonly corpus: 'oracle' | 'golden' | 'quality';
  readonly actions: readonly unknown[];
}

export interface MatrixOptions {
  readonly kernel: KernelColumn;
  readonly seed: number;
  /** Run a design only when its stable hash falls in 1-in-N (1 = every design). */
  readonly designSample: number;
  /** Run an action only when its stable hash falls in 1-in-N (1 = every action). */
  readonly actionSample: number;
  /** Deterministic cap on the actions of one design (stable hash order). */
  readonly maxActionsPerDesign: number;
  readonly shard?: { readonly index: number; readonly count: number };
  /** Design id -> measured ms from an earlier full run, to balance shards. */
  readonly costs?: Readonly<Record<string, number>>;
}

export interface MatrixReport {
  readonly kernel: KernelColumn;
  readonly rows: readonly MatrixRow[];
  readonly costs: readonly DesignCost[];
  /** Designs run completely (no action sampling), so the baseline may be replaced for them. */
  readonly fullDesigns: readonly string[];
}
