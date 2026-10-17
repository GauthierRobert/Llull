/** Rectangular bend relief applied to a part graph: shared by `add_relief` and the automatic relief of `add_flange`. */

import type { FtrCode } from '@core/model/manufacturing';
import type { SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { bendOf, flatOf, nextNodeId, reliefNodes, withNodes } from './graph';
import { bendEnd, notchOutline } from './reliefGeometry';
import { fixed } from './result';

export interface ReliefFailure {
  readonly code: FtrCode;
  readonly why: string;
  readonly fix: string;
  readonly ids?: readonly string[];
  readonly paths?: readonly string[];
}

export interface ReliefApplied {
  readonly part: SheetMetalPart;
  readonly id: string;
  readonly width: number;
  readonly depth: number;
  /** Extra depth beyond R + T; `defaulted` when the rule's relief supplied (or omitted) it. */
  readonly depthExtra: { readonly value: number; readonly defaulted: boolean };
  readonly widthDefaulted: boolean;
  readonly depthDefaulted: boolean;
  readonly defaulted: boolean;
  readonly flat: string;
  readonly bend: string;
  readonly end: 'start' | 'end';
}

export const isReliefFailure = (outcome: ReliefApplied | ReliefFailure): outcome is ReliefFailure => 'code' in outcome;

/**
 * Relief notch at one end of a bend: width = widthRatio*T and depth = R + T + depthExtra from the rule unless given.
 * @failure unknown bend, relief already there, no width/depth and no rectangular rule relief, bend end not on a free edge stretch, notch not fitting -> ReliefFailure
 */
export function applyRelief(
  part: SheetMetalPart,
  rule: SheetMetalRule,
  bendId: string,
  endName: 'start' | 'end',
  given: { readonly width?: number | undefined; readonly depth?: number | undefined } = {},
): ReliefApplied | ReliefFailure {
  const bend = bendOf(part, bendId);
  if (bend === undefined)
    return {
      code: 'FTR_PARAM_INVALID',
      why: `no bend "${bendId}" in part ${part.id}`,
      fix: 'Use a bend id from flat_pattern data.bends[].id.',
      ids: [part.id],
      paths: ['bend'],
    };
  if (reliefNodes(part).some((node) => node.bend === bend.id && node.end === endName))
    return {
      code: 'FTR_RELIEF_INVALID',
      why: `bend ${bend.id} already has a relief at its ${endName}`,
      fix: 'Relieve the other end or edit nothing.',
      ids: [part.id, bend.id],
      paths: ['end'],
    };
  const ruleRelief = rule.relief;
  const defaulted = given.width === undefined || given.depth === undefined;
  if (defaulted && (ruleRelief === undefined || ruleRelief.type !== 'rectangular'))
    return {
      code: 'FTR_PARAM_INVALID',
      why: 'width/depth not given and the rule defines no rectangular relief',
      fix: 'Give width and depth, or create the rule with relief { type: "rectangular", widthRatio }.',
      paths: ['width', 'depth'],
    };
  const depthExtra = ruleRelief?.depthExtra ?? 0;
  const width = given.width ?? (ruleRelief?.widthRatio ?? 0) * rule.thickness;
  const depth = given.depth ?? bend.insideRadius + rule.thickness + depthExtra;
  if (!(width > 0) || !(depth > 0))
    return {
      code: 'FTR_PARAM_INVALID',
      why: `relief width ${width} and depth ${depth} must be > 0`,
      fix: 'Give positive lengths.',
      paths: ['width', 'depth'],
    };
  const parent = flatOf(part, bend.from);
  const end = parent === undefined ? null : bendEnd(parent.outline, bend.lineInFrom, endName);
  if (parent === undefined || end === null)
    return {
      code: 'FTR_RELIEF_INVALID',
      why: `bend ${bend.id} does not lie on an edge of its parent flat`,
      fix: 'A relief needs the bend on an outline edge.',
      ids: [part.id, bend.id],
    };
  if (end.free <= 1e-6)
    return {
      code: 'FTR_RELIEF_INVALID',
      why: `the bend ends at a corner of ${parent.id}: there is no free edge to relieve`,
      fix: 'Reliefs go where the flange stops short of the edge end.',
      ids: [part.id, bend.id],
      paths: ['end'],
    };
  const outline = notchOutline(parent.outline, end, endName, width, depth);
  if (outline === null)
    return {
      code: 'FTR_RELIEF_INVALID',
      why: `a ${fixed(width)} x ${fixed(depth)} notch does not fit on the free ${fixed(end.free)} of the edge`,
      fix: 'Reduce width/depth, or lengthen the free edge (widthStart / widthEnd of the flange).',
      ids: [part.id, bend.id],
    };
  const id = nextNodeId(part, 'r');
  return {
    part: withNodes(part, [
      { ...parent, outline },
      { id, type: 'relief', bend: bend.id, end: endName, width, depth },
    ]),
    id,
    width,
    depth,
    depthExtra: { value: depthExtra, defaulted: ruleRelief !== undefined && ruleRelief.depthExtra === undefined },
    widthDefaulted: given.width === undefined,
    depthDefaulted: given.depth === undefined,
    defaulted,
    flat: parent.id,
    bend: bend.id,
    end: endName,
  };
}

/** `data` of a relief result: width, depth and depthExtra as Named values (the extra is a Named default when the rule omitted it, AF-31). */
export function reliefData(applied: ReliefApplied, ruleName: string): Record<string, unknown> {
  const source = `rule ${ruleName} relief`;
  return {
    reliefId: applied.id,
    flat: applied.flat,
    bend: applied.bend,
    end: applied.end,
    width: {
      value: applied.width,
      source: applied.widthDefaulted ? `${source} widthRatio x thickness` : 'given',
      defaulted: applied.widthDefaulted,
      verification: 'verified',
    },
    depth: {
      value: applied.depth,
      source: applied.depthDefaulted ? `${source}: inside radius + thickness + depthExtra` : 'given',
      defaulted: applied.depthDefaulted,
      verification: 'verified',
    },
    depthExtra: {
      value: applied.depthExtra.value,
      source: applied.depthExtra.defaulted ? `${source} depthExtra omitted: 0` : source,
      defaulted: applied.depthExtra.defaulted,
      verification: 'verified',
    },
  };
}
