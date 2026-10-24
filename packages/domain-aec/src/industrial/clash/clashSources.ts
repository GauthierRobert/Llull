/**
 * Extension point of `check_clashes` for solids that are not building elements (02 RTE M3: spec-driven pipe runs and their insulation envelopes).
 * A domain registers a pure source once at module load; `check_clashes` asks every source for its bodies. The clash code stays unaware of the domain.
 * @invariant a source is pure and returns bodies in document units; with no source registered, `check_clashes` behaves as before
 */

import type { CadDocument } from '@core/model/types';
import type { OrientedBox } from './clashBoxes';

export interface ExternalBody {
  /** Id reported in `Clash.a` / `Clash.b` (a pipe part id such as `run-4/pipe-2`). */
  readonly id: string;
  /** `solid`: the body itself, a hit is a hard clash. `envelope`: insulation around it, a hit is an `insulation` clash (unless the solid already clashes). */
  readonly kind: 'solid' | 'envelope';
  readonly box: OrientedBox;
  /** Bodies of one group (a run) never clash with each other. */
  readonly group: string;
  /** Groups and building element ids this body is connected to by design (an attached run, the equipment its nozzle sits on): no clash with them. */
  readonly connectedTo: readonly string[];
}

export type ClashSource = (doc: CadDocument) => readonly ExternalBody[];

const sources = new Set<ClashSource>();

/** Registers `source` (idempotent: the same function is kept once). */
export function registerClashSource(source: ClashSource): void {
  sources.add(source);
}

/** The bodies of every registered source for `doc`. */
export function externalBodies(doc: CadDocument): ExternalBody[] {
  return [...sources].flatMap((source) => [...source(doc)]);
}
