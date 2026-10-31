/** Explicit P&ID <-> 3D pairs (`PidModel.links`). */

import type { PidModel } from '../model';

/** The model without the links of `ids`; the `links` key disappears when none is left. Returns the same object when nothing changes. */
export function dropLinks(pid: PidModel, ids: Iterable<string>): PidModel {
  const links = pid.links;
  if (links === undefined) return pid;
  const gone = new Set(ids);
  const kept = Object.entries(links).filter(([id]) => !gone.has(id));
  if (kept.length === Object.keys(links).length) return pid;
  const base = Object.fromEntries(Object.entries(pid).filter(([key]) => key !== 'links')) as unknown as PidModel;
  return kept.length === 0 ? base : { ...base, links: Object.fromEntries(kept) };
}
