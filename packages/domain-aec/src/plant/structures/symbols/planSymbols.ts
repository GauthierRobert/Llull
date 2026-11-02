/**
 * Plan symbols of the access elements (06 STA §6): platforms and gratings as outlines with a bearing-bar hatch, fixed ladders as a rectangle with
 * dividers (and the cage circle), steel stairs as an outline with tread lines, the climb arrow and "UP n R", railings as a line with post ticks and gates
 * as dashed-layer lines. Model space in millimetres, +y up, whatever the document units. Pure and deterministic.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { fromMm, MM_PER_UNIT } from '@core/model/units';
import { elementsOf } from '@aec/building/model';
import type { BuildingModel, GratingElement, LadderElement, RailingElement, SteelStairElement } from '@aec/building/types';
import { findProfile } from '../../../steel/profiles';
import { cumulativeLengths, guardedSegments, layoutRailing, pointAlong } from '../railing/railingLayout';
import { directionOf, layoutSteelStair } from '../stair/steelStairLayout';
import { stairSizes } from '../stair/steelStairMeasure';
import { hatchLines } from './hatch';

export type PlanLayer = 'S-PLAT' | 'S-GRAT' | 'S-LADR' | 'S-STAR' | 'S-RAIL' | 'S-GATE' | 'S-TEXT';

export type PlanPrimitive =
  | { readonly t: 'line'; readonly layer: PlanLayer; readonly a: Vec2; readonly b: Vec2 }
  | { readonly t: 'poly'; readonly layer: PlanLayer; readonly points: readonly Vec2[]; readonly closed: boolean }
  | { readonly t: 'circle'; readonly layer: PlanLayer; readonly c: Vec2; readonly r: number }
  | { readonly t: 'text'; readonly layer: PlanLayer; readonly at: Vec2; readonly size: number; readonly text: string };

/** Drawn sizes (named, not rules): text height, ladder symbol depth along the climb direction, grating hatch spacing and its cap per panel, post tick length. */
export const SYMBOL_SIZES_MM = {
  text: 150,
  ladderDepth: 300,
  hatchSpacing: 100,
  hatchLinesMax: 60,
  postTick: 120,
  arrowHead: 200,
} as const;

export interface PlanSymbols {
  readonly primitives: PlanPrimitive[];
  readonly counts: {
    readonly platforms: number;
    readonly gratingPanels: number;
    readonly ladders: number;
    readonly stairs: number;
    readonly railings: number;
  };
}

const scale = (point: readonly number[], factor: number): Vec2 => [(point[0] as number) * factor, (point[1] as number) * factor];

const onLevel = (levelId: string | undefined, element: { readonly levelId: string }): boolean =>
  levelId === undefined || element.levelId === levelId;

function gratingSymbol(grating: GratingElement, factor: number, owned: boolean): PlanPrimitive[] {
  const outline = grating.boundary.map((point) => scale(point, factor));
  const direction: Vec2 = [Math.cos(grating.bearingBarAngle), Math.sin(grating.bearingBarAngle)];
  return [
    { t: 'poly', layer: owned ? 'S-PLAT' : 'S-GRAT', points: outline, closed: true },
    ...hatchLines(outline, direction, SYMBOL_SIZES_MM.hatchSpacing, SYMBOL_SIZES_MM.hatchLinesMax).map(
      ([a, b]): PlanPrimitive => ({ t: 'line', layer: 'S-GRAT', a, b }),
    ),
  ];
}

function platformLabels(
  building: BuildingModel,
  panels: ReadonlyArray<GratingElement>,
  factor: number,
  levelId: string | undefined,
): PlanPrimitive[] {
  const labels: PlanPrimitive[] = [];
  for (const assembly of elementsOf(building, 'assembly')) {
    if ((assembly.kind !== 'platform' && assembly.kind !== 'circular_platform') || !onLevel(levelId, assembly)) continue;
    const own = panels.filter((panel) => panel.assemblyId === assembly.id);
    const first = own[0];
    const level = building.levels[assembly.levelId];
    if (first === undefined || level === undefined) continue;
    const points = own.flatMap((panel) => panel.boundary);
    const centre: Vec2 = [
      points.reduce((sum, p) => sum + p[0], 0) / points.length,
      points.reduce((sum, p) => sum + p[1], 0) / points.length,
    ];
    const top = Math.round((level.elevation + first.topOffset) * factor);
    labels.push({
      t: 'text',
      layer: 'S-TEXT',
      at: scale(centre, factor),
      size: SYMBOL_SIZES_MM.text,
      text: `${assembly.mark} EL ${top >= 0 ? '+' : ''}${top}`,
    });
  }
  return labels;
}

function ladderSymbol(ladder: LadderElement, factor: number): PlanPrimitive[] {
  const centre = scale(ladder.base, factor);
  const width = ladder.clearWidth * factor;
  const depth = SYMBOL_SIZES_MM.ladderDepth;
  const forward: Vec2 = [Math.cos(ladder.facing), Math.sin(ladder.facing)];
  const left: Vec2 = [-forward[1], forward[0]];
  const at = (along: number, across: number): Vec2 => [
    centre[0] + forward[0] * along + left[0] * across,
    centre[1] + forward[1] * along + left[1] * across,
  ];
  const corners = [at(-depth / 2, -width / 2), at(depth / 2, -width / 2), at(depth / 2, width / 2), at(-depth / 2, width / 2)];
  const dividers = [-1, 0, 1].map(
    (k): PlanPrimitive => ({ t: 'line', layer: 'S-LADR', a: at((k * depth) / 4, -width / 2), b: at((k * depth) / 4, width / 2) }),
  );
  const cage: PlanPrimitive[] =
    ladder.cage === undefined
      ? []
      : [{ t: 'circle', layer: 'S-LADR', c: at(-ladder.cage.diameter * factor * 0.5, 0), r: (ladder.cage.diameter * factor) / 2 }];
  return [
    { t: 'poly', layer: 'S-LADR', points: corners, closed: true },
    ...dividers,
    ...cage,
    { t: 'line', layer: 'S-LADR', a: at(depth / 2, 0), b: at(depth / 2 + SYMBOL_SIZES_MM.arrowHead, 0) },
    {
      t: 'text',
      layer: 'S-TEXT',
      at: at(-depth / 2 - SYMBOL_SIZES_MM.text, width / 2 + SYMBOL_SIZES_MM.text),
      size: SYMBOL_SIZES_MM.text,
      text: `${ladder.mark} H=${Math.round(ladder.climbHeight * factor)}`,
    },
  ];
}

function stairSymbol(doc: CadDocument, stair: SteelStairElement, factor: number): PlanPrimitive[] {
  const layout = layoutSteelStair(stair, stairSizes(doc, stair));
  const { forward, left } = directionOf(stair.angle);
  const half = stair.width / 2;
  const at = (station: number, across: number): Vec2 =>
    scale([stair.start[0] + forward[0] * station + left[0] * across, stair.start[1] + forward[1] * station + left[1] * across], factor);
  const run = layout.run;
  const primitives: PlanPrimitive[] = [
    { t: 'poly', layer: 'S-STAR', points: [at(0, -half), at(run, -half), at(run, half), at(0, half)], closed: true },
    ...layout.stations
      .slice(1, -1)
      .map((station): PlanPrimitive => ({ t: 'line', layer: 'S-STAR', a: at(station, -half), b: at(station, half) })),
    ...layout.landings.map(
      (plate): PlanPrimitive => ({
        t: 'poly',
        layer: 'S-STAR',
        points: plate.corners.map((corner) => scale(corner, factor)),
        closed: true,
      }),
    ),
  ];
  const head = SYMBOL_SIZES_MM.arrowHead;
  const tip = at(run * 0.9, 0);
  const back = at(run * 0.1, 0);
  const across = (distanceMm: number, side: number): Vec2 => {
    const base = at(run * 0.9 - fromMm(doc, head) * 0.5, 0);
    return [base[0] + (-forward[1] * side * distanceMm) / 2, base[1] + (forward[0] * side * distanceMm) / 2];
  };
  primitives.push(
    { t: 'line', layer: 'S-STAR', a: back, b: tip },
    { t: 'line', layer: 'S-STAR', a: tip, b: across(head, 1) },
    { t: 'line', layer: 'S-STAR', a: tip, b: across(head, -1) },
    {
      t: 'text',
      layer: 'S-TEXT',
      at: at(0, half + fromMm(doc, SYMBOL_SIZES_MM.text)),
      size: SYMBOL_SIZES_MM.text,
      text: `${stair.mark} UP ${stair.riserCount} R`,
    },
  );
  return primitives;
}

function railingSymbol(doc: CadDocument, railing: RailingElement, factor: number): PlanPrimitive[] {
  const guarded = guardedSegments(railing.path, railing.openings).map(
    ([a, b]): PlanPrimitive => ({ t: 'line', layer: 'S-RAIL', a: scale(a, factor), b: scale(b, factor) }),
  );
  const cumulative = cumulativeLengths(railing.path);
  const gates = railing.openings
    .filter((opening) => opening.gate)
    .map(
      (opening): PlanPrimitive => ({
        t: 'line',
        layer: 'S-GATE',
        a: scale(pointAlong(railing.path, cumulative, opening.from), factor),
        b: scale(pointAlong(railing.path, cumulative, opening.to), factor),
      }),
    );
  const rail = findProfile(railing.railProfile);
  const ticks: PlanPrimitive[] =
    rail === undefined
      ? []
      : layoutRailing(railing, fromMm(doc, rail.h)).posts.map((post): PlanPrimitive => {
          const [x, y] = scale(post, factor);
          const half = SYMBOL_SIZES_MM.postTick / 2;
          return {
            t: 'poly',
            layer: 'S-RAIL',
            points: [
              [x - half, y - half],
              [x + half, y - half],
              [x + half, y + half],
              [x - half, y + half],
            ],
            closed: true,
          };
        });
  return [...guarded, ...gates, ...ticks];
}

/** Symbols of the access elements of `building` (all levels, or the one named), in model order: gratings and platforms, ladders, steel stairs, railings. */
export function planSymbols(doc: CadDocument, building: BuildingModel, levelId?: string): PlanSymbols {
  const factor = MM_PER_UNIT[doc.units];
  const panels = elementsOf(building, 'grating').filter((panel) => onLevel(levelId, panel));
  const ladders = elementsOf(building, 'ladder').filter((ladder) => onLevel(levelId, ladder));
  const stairs = elementsOf(building, 'steelStair').filter((stair) => onLevel(levelId, stair));
  const railings = elementsOf(building, 'railing').filter((railing) => onLevel(levelId, railing));
  const platforms = elementsOf(building, 'assembly').filter(
    (assembly) => (assembly.kind === 'platform' || assembly.kind === 'circular_platform') && onLevel(levelId, assembly),
  );
  const primitives: PlanPrimitive[] = [
    ...panels.flatMap((panel) => gratingSymbol(panel, factor, panel.assemblyId !== undefined)),
    ...platformLabels(building, panels, factor, levelId),
    ...panels
      .filter((panel) => panel.assemblyId === undefined)
      .map(
        (panel): PlanPrimitive => ({
          t: 'text',
          layer: 'S-TEXT',
          at: scale(panel.boundary[0] as Vec2, factor),
          size: SYMBOL_SIZES_MM.text,
          text: panel.mark,
        }),
      ),
    ...ladders.flatMap((ladder) => ladderSymbol(ladder, factor)),
    ...stairs.flatMap((stair) => stairSymbol(doc, stair, factor)),
    ...railings.flatMap((railing) => railingSymbol(doc, railing, factor)),
  ];
  return {
    primitives,
    counts: {
      platforms: platforms.length,
      gratingPanels: panels.length,
      ladders: ladders.length,
      stairs: stairs.length,
      railings: railings.length,
    },
  };
}
