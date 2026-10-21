/** Analytic flat pattern of a native sheet-metal part (§5.2): walk the flat/bend tree, add BA at every bend, merge into one outline. */

import type { Vec2 } from '@core/model/types';
import type { SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { polygonArea } from '@lib/polygon';
import { add2, scale2 } from '@lib/vec2';
import { type BendQuantities, type JoggleQuantities, bendQuantities, hemQuantities, joggleQuantities } from './sheetMath';
import { IDENTITY, type Rigid2, applyRigid, circlePolygon, composeRigid, lineBasis } from './geometry2d';
import { developedHoleRadius, lipGeometry } from './formGeometry';
import { childBends, flatOf, formsOf, hemsOf, joggleNodes } from './graph';
import { mergePolygons } from './outline';
import { type ResolvedK, resolveK } from './rules';

export interface UnfoldedBend {
  readonly id: string;
  readonly angle: number;
  readonly direction: 'up' | 'down';
  readonly insideRadius: number;
  readonly k: ResolvedK;
  readonly quantities: BendQuantities;
  /** Bend line (centre of the bend zone) in pattern coordinates. */
  readonly line: readonly [Vec2, Vec2];
  readonly width: number;
}

export interface UnfoldedHem {
  readonly id: string;
  readonly bend: string;
  readonly hemType: 'closed' | 'open';
  readonly gap: number;
  readonly leg: number;
  readonly bendAllowance: number;
  /** Developed length of the bend plus the return leg. */
  readonly developedLength: number;
}

/** A formed feature that is not part of the developed outline: listed for the forming note (positions in pattern coordinates). */
export type UnfoldedForm =
  | {
      readonly kind: 'bead';
      readonly id: string;
      readonly start: Vec2;
      readonly end: Vec2;
      readonly radius: number;
      readonly depth: number;
      readonly endShape: 'round' | 'open';
      readonly direction: 'up' | 'down';
    }
  | {
      readonly kind: 'flanged_hole';
      readonly id: string;
      readonly center: Vec2;
      readonly physicalRadius: number;
      readonly developedRadius: number;
      readonly flangeHeight: number;
      readonly angle: number;
      readonly direction: 'up' | 'down';
    };

export interface UnfoldedJoggle {
  readonly id: string;
  readonly quantities: JoggleQuantities;
}

export interface UnfoldedCutout {
  readonly points: Vec2[];
  readonly circle?: { readonly center: Vec2; readonly radius: number };
  /** Developed (stretch-flange) hole of a flanged hole: approximate and unverified. */
  readonly approximate?: boolean;
}

export interface FlatPatternGeometry {
  readonly outline: Vec2[];
  readonly cutouts: UnfoldedCutout[];
  readonly bends: UnfoldedBend[];
  readonly joggles: UnfoldedJoggle[];
  readonly hems: UnfoldedHem[];
  readonly forms: UnfoldedForm[];
  /** [x extent, y extent] of the outline in pattern coordinates (root flat frame). */
  readonly extents: readonly [number, number];
  readonly min: Vec2;
  readonly area: number;
}

/**
 * Flat pattern of `part` in the coordinates of its root flat.
 * @failure root flat missing or no closed boundary -> null
 */
export function unfoldPart(part: SheetMetalPart, rule: SheetMetalRule): FlatPatternGeometry | null {
  const polygons: Vec2[][] = [];
  const cutouts: UnfoldedCutout[] = [];
  const bends: UnfoldedBend[] = [];
  const hems: UnfoldedHem[] = [];
  const forms: UnfoldedForm[] = [];
  const hemNodes = hemsOf(part);
  const thickness = rule.thickness;
  const visit = (flatId: string, placement: Rigid2): void => {
    const flat = flatOf(part, flatId);
    if (flat === undefined) return;
    polygons.push(flat.outline.map((point) => applyRigid(placement, point)));
    for (const node of formsOf(part))
      if (node.on === flatId && node.form.kind === 'bead')
        forms.push({
          kind: 'bead',
          id: node.id,
          start: applyRigid(placement, node.form.start),
          end: applyRigid(placement, node.form.end),
          radius: node.form.radius,
          depth: node.form.depth,
          endShape: node.form.endShape,
          direction: node.form.direction,
        });
    for (const cutout of flat.cutouts) {
      const formNode = cutout.form === undefined ? undefined : part.nodes[cutout.form];
      const lip = formNode?.type === 'form' && formNode.form.kind === 'flanged_hole' ? lipGeometry(formNode.form, thickness) : null;
      if (formNode?.type === 'form' && formNode.form.kind === 'flanged_hole' && lip !== null && cutout.circle !== undefined) {
        const hole = formNode.form;
        const radius = developedHoleRadius(lip, hole, resolveK(rule, hole.lipRadius).value, thickness);
        const center = applyRigid(placement, cutout.circle.center);
        cutouts.push({ points: circlePolygon(center, radius), circle: { center, radius }, approximate: true });
        forms.push({
          kind: 'flanged_hole',
          id: formNode.id,
          center,
          physicalRadius: lip.cutRadius,
          developedRadius: radius,
          flangeHeight: hole.flangeHeight,
          angle: hole.angle,
          direction: hole.direction,
        });
        continue;
      }
      cutouts.push({
        points: cutout.points.map((point) => applyRigid(placement, point)),
        ...(cutout.circle !== undefined
          ? { circle: { center: applyRigid(placement, cutout.circle.center), radius: cutout.circle.radius } }
          : {}),
      });
    }
    for (const bend of childBends(part, flatId)) {
      const k = resolveK(rule, bend.insideRadius, bend.kOverride);
      const quantities = bendQuantities({
        theta: Math.abs(bend.angle),
        insideRadius: bend.insideRadius,
        thickness: rule.thickness,
        k: k.value,
      });
      const hem = hemNodes.find((node) => node.bend === bend.id);
      const hemQ = hem === undefined ? null : hemQuantities({ thickness, gap: hem.gap, k: k.value, leg: hem.length });
      if (hem !== undefined && hemQ !== null)
        hems.push({
          id: hem.id,
          bend: bend.id,
          hemType: hem.hemType,
          gap: hem.gap,
          leg: hem.length,
          bendAllowance: hemQ.bendAllowance.value,
          developedLength: hemQ.developed.value,
        });
      const allowance = hemQ?.bendAllowance.value ?? quantities.ba.value;
      const [p, q] = bend.lineInFrom;
      const { direction, outward, length } = lineBasis(p, q);
      const shift = scale2(outward, allowance);
      const zone = [p, q, add2(q, shift), add2(p, shift)].map((point) => applyRigid(placement, point));
      polygons.push(zone);
      const middle = scale2(outward, allowance / 2);
      bends.push({
        id: bend.id,
        angle: bend.angle,
        direction: bend.angle > 0 ? 'up' : 'down',
        insideRadius: bend.insideRadius,
        k,
        quantities,
        line: [applyRigid(placement, add2(p, middle)), applyRigid(placement, add2(q, middle))],
        width: length,
      });
      visit(bend.to, composeRigid(placement, add2(p, shift), direction));
    }
  };
  visit(part.root, IDENTITY);
  const merged = mergePolygons(polygons);
  if (merged === null) return null;
  const xs = merged.outer.map((point) => point[0]);
  const ys = merged.outer.map((point) => point[1]);
  const min: Vec2 = [Math.min(...xs), Math.min(...ys)];
  const holeArea = cutouts.reduce(
    (sum, cutout) => sum + (cutout.circle !== undefined ? Math.PI * cutout.circle.radius ** 2 : polygonArea(cutout.points)),
    0,
  );
  const joggles = joggleNodes(part).flatMap((node): UnfoldedJoggle[] => {
    const k = resolveK(rule, node.insideRadius).value;
    const quantities = joggleQuantities({
      thickness: rule.thickness,
      insideRadius: node.insideRadius,
      k,
      phi: node.angle,
      offset: node.offset,
    });
    return quantities === null ? [] : [{ id: node.id, quantities }];
  });
  return {
    outline: merged.outer,
    cutouts: [...cutouts, ...merged.holes.map((points): UnfoldedCutout => ({ points }))],
    bends,
    joggles,
    hems,
    forms,
    extents: [Math.max(...xs) - min[0], Math.max(...ys) - min[1]],
    min,
    area: polygonArea(merged.outer) - holeArea - merged.holes.reduce((sum, hole) => sum + polygonArea(hole), 0),
  };
}
