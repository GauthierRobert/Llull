/**
 * Solid parts of a pipe support in the pipe's frame: a steel block (shoe, guide, anchor) between the
 * pipe underside and the steel below, with side stops (guide, anchor) and a cap (anchor); a hanger is
 * a clamp on the pipe top and a rod up to the steel above. On a riser every type is a clamp collar
 * with a horizontal bracket to the steel beside the pipe.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { PipeElement, PipeSupportElement } from '@core/model/building';
import { fromMm } from '../model';
import { hangerRodDiameter, pipeSpanLimit } from './pipeSpans';
import { RISER_SLOPE, nearestOnRoute } from './routeSupport';

type SupportPart =
  | {
      readonly kind: 'box';
      readonly name: string;
      readonly label: string;
      /** Offset of the part centre across the pipe (left positive), and its height z relative to the level. */
      readonly across: number;
      readonly z: number;
      /** [along the pipe, across, height]. */
      readonly size: readonly [number, number, number];
    }
  | {
      readonly kind: 'cylinder';
      readonly name: string;
      readonly label: string;
      readonly across: number;
      readonly z: number;
      readonly radius: number;
      readonly height: number;
    };

interface SupportShape {
  /** Plan direction of the pipe at the support, radians. */
  readonly angle: number;
  readonly parts: SupportPart[];
}

/** Plan direction of the pipe at `position` (level-relative); 0 for a vertical segment. */
export function pipeAngle(pipe: PipeElement, position: PipeSupportElement['position']): number {
  const snap = nearestOnRoute(pipe.points, position);
  const [dx, dy] = [snap?.direction[0] ?? 1, snap?.direction[1] ?? 0];
  return Math.hypot(dx, dy) < 1e-6 ? 0 : Math.atan2(dy, dx);
}

/** Clamp collar and bracket of a support on a riser; the frame is turned so `across` points to the steel. */
function riserShape(
  support: PipeSupportElement,
  diameter: number,
  mm: (value: number) => number,
): SupportShape {
  const label = `Pipe support ${support.mark} ${support.type}`;
  const [z, collar] = [support.position[2], diameter + mm(40)];
  const arm =
    support.memberId !== null && support.standoff !== undefined ? support.standoff - mm(20) : 0;
  const parts: SupportPart[] = [
    {
      kind: 'box',
      name: 'clamp',
      label: `${label} clamp`,
      across: 0,
      z,
      size: [collar, collar, mm(80)],
    },
  ];
  if (arm > mm(5)) {
    parts.push({
      kind: 'box',
      name: 'bracket',
      label: `${label} bracket`,
      across: collar / 2 + arm / 2,
      z,
      size: [mm(60), arm, mm(40)],
    });
  }
  return { angle: (support.standoffAngle ?? Math.PI / 2) - Math.PI / 2, parts };
}

/** Parts of `support` on `pipe`; z values are relative to the support's level. */
export function supportShape(
  doc: Pick<CadDocument, 'units'>,
  support: PipeSupportElement,
  pipe: PipeElement,
): SupportShape {
  const mm = (value: number): number => fromMm(doc, value);
  const diameter = pipe.diameter;
  const [top, underside] = [support.position[2] + diameter / 2, support.position[2] - diameter / 2];
  const label = `Pipe support ${support.mark} ${support.type}`;
  const box = (
    name: string,
    text: string,
    across: number,
    z: number,
    size: readonly [number, number, number],
  ): SupportPart => ({ kind: 'box', name, label: `${label} ${text}`, across, z, size });
  const snap = nearestOnRoute(pipe.points, support.position);
  if (snap && Math.abs(snap.direction[2]) > RISER_SLOPE) return riserShape(support, diameter, mm);
  const angle = pipeAngle(pipe, support.position);
  if (support.type === 'hanger') {
    const parts: SupportPart[] = [box('clamp', 'clamp', 0, top + mm(5), [mm(40), mm(60), mm(10)])];
    if (support.rodLength > 0) {
      const rodDn = pipeSpanLimit(pipe.dn, diameter / mm(1)).dn;
      parts.push({
        kind: 'cylinder',
        name: 'rod',
        label: `${label} rod`,
        across: 0,
        z: top + support.rodLength / 2,
        radius: mm(hangerRodDiameter(rodDn)) / 2,
        height: support.rodLength,
      });
    }
    return { angle, parts };
  }
  const stops = support.type === 'guide' || support.type === 'anchor';
  const length = Math.max(mm(150), diameter);
  const width = Math.max(mm(100), stops ? diameter + mm(30) : diameter / 2);
  const pedestal =
    support.pedestalHeight > 0 ? support.pedestalHeight : support.memberId === null ? mm(100) : 0;
  const height = Math.max(pedestal, mm(20));
  const parts: SupportPart[] = [
    box('block', 'block', 0, underside - height / 2, [length, width, height]),
  ];
  if (stops) {
    const stopHeight = diameter / 2 + mm(15);
    for (const side of [1, -1]) {
      parts.push(
        box(
          side > 0 ? 'stop-left' : 'stop-right',
          'side stop',
          side * (diameter / 2 + mm(10)),
          underside + stopHeight / 2,
          [length, mm(10), stopHeight],
        ),
      );
    }
  }
  if (support.type === 'anchor') {
    parts.push(box('cap', 'cap', 0, top + mm(5), [mm(30), diameter + mm(40), mm(10)]));
  }
  return { angle, parts };
}
