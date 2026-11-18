/** The parts and joints at the two ends of a run derivation: flange set on a port, blind flange, cap. */

import type { Vec3 } from '@core/model/vectors';
import { scale3 } from '@lib/vec3';
import { isFailure, type DerivationFailure } from './deriveTypes';
import { blindParts, capPart, flangeParts } from './routeEnds';
import type { RunCtx } from './routeRunCtx';

/** Flange set at the start port, then the start blind flange, then the start cap. */
export function addStartParts(c: RunCtx): void {
  const { start, startIds, startBlindId, startCapId, od } = c;
  const runId = c.env.run.id;
  const first = c.points[0] as Vec3;
  const dir = c.dirs[0] as Vec3;
  if (start.set !== null && start.port !== null && startIds !== null) {
    c.parts.push(...flangeParts(runId, startIds, start.set, start.port, first, dir, od, true));
    c.addJoint({
      kind: c.flangedKind,
      parts: [startIds.flange, start.portId as string],
      position: first,
      gapMm: start.set.gasketThickness,
      accessories: [startIds.gasket, startIds.bolts],
    });
  }
  const startBlind = startIds === null || startBlindId === null ? null : blindParts(runId, startIds, startBlindId, start, first, dir, od);
  if (startBlind !== null && startIds !== null) {
    c.parts.push(...startBlind.parts);
    c.addJoint({
      kind: c.flangedKind,
      parts: [startIds.flange, startBlindId as string],
      position: startBlind.mating,
      gapMm: startBlind.gapMm,
      accessories: [startIds.gasket, startIds.bolts],
    });
  }
  const startCap = startCapId === null ? null : capPart(runId, startCapId, start, first, dir, c.dnStart, od);
  if (startCap !== null) c.parts.push(startCap);
}

/** Flange set at the end port, then the end blind flange, then the end cap. */
export function addEndParts(c: RunCtx): DerivationFailure | undefined {
  const { end, endIds, endBlindId, endCapId, dnEnd } = c;
  const runId = c.env.run.id;
  const legCount = c.points.length - 1;
  const last = c.points[legCount] as Vec3;
  if (end.set !== null && end.port !== null && endIds !== null) {
    const endPipe = c.env.pipeAt(dnEnd);
    if (isFailure(endPipe)) return endPipe;
    const into = scale3(c.dirs[legCount - 1] as Vec3, -1);
    c.parts.push(...flangeParts(runId, endIds, end.set, end.port, last, into, endPipe.od, false));
    c.addJoint({
      kind: c.flangedKind,
      parts: [endIds.flange, end.portId as string],
      position: last,
      gapMm: end.set.gasketThickness,
      accessories: [endIds.gasket, endIds.bolts],
    });
  }
  if (endIds !== null && endBlindId !== null) {
    const endPipe = c.env.pipeAt(dnEnd);
    if (isFailure(endPipe)) return endPipe;
    const blind = blindParts(runId, endIds, endBlindId, end, last, scale3(c.dirs[legCount - 1] as Vec3, -1), endPipe.od);
    if (blind !== null) {
      c.parts.push(...blind.parts);
      c.addJoint({
        kind: c.flangedKind,
        parts: [endIds.flange, endBlindId],
        position: blind.mating,
        gapMm: blind.gapMm,
        accessories: [endIds.gasket, endIds.bolts],
      });
    }
  }
  if (endCapId !== null) {
    const endPipe = c.env.pipeAt(dnEnd);
    if (isFailure(endPipe)) return endPipe;
    const cap = capPart(runId, endCapId, end, last, scale3(c.dirs[legCount - 1] as Vec3, -1), dnEnd, endPipe.od);
    if (cap !== null) c.parts.push(cap);
  }
  return undefined;
}
