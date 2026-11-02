/** Shared helpers of the P&ID <-> 3D check: tag normaliser, safe item lookup, and the 3D-side shapes the comparisons read. */

import type { PipeElement } from '@aec/building/types';
import type { PidItem, PidModel } from '../model';
import type { ModelObject } from './pairing';

export type Norm = (text: string) => string;

export const normaliser = (normaliseTags: boolean): Norm =>
  normaliseTags ? (text) => text.toUpperCase().replace(/[\s_-]+/g, '') : (text) => text.trim();

export const itemAt = (pid: PidModel, id: string): PidItem | undefined => (Object.hasOwn(pid.items, id) ? pid.items[id] : undefined);
export const text = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

export interface Labelled extends ModelObject {
  readonly label: string;
}

/** A tagged inline component of a 02 RTE routed run (valve, reducer): `ids` holds the stored component id. */
export interface Inline3d extends Labelled {
  readonly componentId: string;
  /** Catalogue component type (`valveGate`, `reducerConcentric`, ...). */
  readonly type: string;
  readonly runId: string;
  readonly lineId: string;
}

/** One 3D line: the legacy pipe runs sharing a line number and / or the 02 RTE routed line of that number, with what the comparisons read. */
export interface Run extends Labelled {
  /** Normalised line number; absent for a pipe without one (it joins only through a link). */
  readonly key: string | undefined;
  readonly pipes: readonly PipeElement[];
  /** Every DN along the line (legacy `dn`, routed run size, reducer outlets). */
  readonly dns: readonly number[];
  /** Spec ids bound to the line: `PipeElement.spec.specId` of legacy pipes, `PipeLine.spec` of routed lines. */
  readonly specs: readonly string[];
  /** `TAG` or `TAG:NOZZLE` text of the first start and the last end. */
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** Tagged inline components of the main (non-branch) routed runs in route order. */
  readonly sequence: readonly Inline3d[];
}
