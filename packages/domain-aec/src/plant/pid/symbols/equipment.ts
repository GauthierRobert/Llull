/**
 * Equipment symbols (plant 04 PID FR-PID-01, FR-PID-02): every class `proteusClasses.ts` maps. Drawn by llull from public conventions (not copied from
 * ISO 10628-2). `ISO-10628-2` = outline + internals; `ISA-5.1` = the outline alone with the class initial (the simplified block style).
 */

import type { Vec2 } from '@core/model/vectors';
import { halfExtents } from '../authoring/classes';
import type { PidConvention } from '../model';
import { capsule, circle, ellipse, line, poly, rect, text, type PidSymbol, type Shape } from './shapes';

interface Drawing {
  readonly outline: readonly Shape[];
  readonly detail: readonly Shape[];
}

const zigzag = (hx: number, hy: number, teeth: number): Vec2[] =>
  Array.from({ length: teeth * 2 + 1 }, (_, i) => [-hx + (2 * hx * i) / (teeth * 2), i % 2 === 0 ? -hy : hy] as Vec2);

const trays = (hx: number, ys: readonly number[]): Shape[] =>
  ys.map((y) =>
    line([
      [-hx, y],
      [hx, y],
    ]),
  );

function drawingOf(cls: string, hx: number, hy: number): Drawing {
  const r = Math.min(hx, hy);
  const box = rect(hx, hy);
  const round = poly(ellipse(0, 0, r, r));
  switch (cls) {
    case 'Tank':
      return {
        outline: [box],
        detail: [
          line([
            [-hx, hy * 0.7],
            [hx, hy * 0.7],
          ]),
        ],
      };
    case 'PressureVessel':
      return { outline: [capsule(hx, hy, hx)], detail: [] };
    case 'ProcessColumn':
      return { outline: [capsule(hx, hy, hx)], detail: trays(hx, [-hy * 0.5, 0, hy * 0.5]) };
    case 'ColumnSection':
      return { outline: [box], detail: trays(hx, [-hy * 0.4, hy * 0.4]) };
    case 'ColumnPackingsArrangement':
      return {
        outline: [box],
        detail: [
          line([
            [-hx, -hy],
            [hx, hy],
          ]),
          line([
            [-hx, hy],
            [hx, -hy],
          ]),
        ],
      };
    case 'CentrifugalPump':
      return {
        outline: [round],
        detail: [
          line([
            [0, r],
            [hx, r],
          ]),
          poly([
            [-r * 0.5, -r * 0.5],
            [r * 0.5, 0],
            [-r * 0.5, r * 0.5],
          ]),
        ],
      };
    case 'ReciprocatingPump':
      return {
        outline: [box],
        detail: [
          line([
            [-hx, 0],
            [hx, 0],
          ]),
          line([
            [0, -hy],
            [0, hy],
          ]),
        ],
      };
    case 'RotaryPump':
      return { outline: [round], detail: [circle([0, 0], r * 0.45)] };
    case 'Compressor':
      return {
        outline: [round],
        detail: [
          line([
            [-r * 0.7, r * 0.7],
            [r * 0.7, r * 0.3],
          ]),
          line([
            [-r * 0.7, -r * 0.7],
            [r * 0.7, -r * 0.3],
          ]),
        ],
      };
    case 'Blower':
    case 'Fan':
      return {
        outline: [round],
        detail: [0, 1, 2, 3].map((i) =>
          line([
            [0, 0],
            [r * 0.8 * Math.cos((Math.PI * i) / 2 + 0.4), r * 0.8 * Math.sin((Math.PI * i) / 2 + 0.4)],
          ]),
        ),
      };
    case 'PlateHeatExchanger':
      return {
        outline: [box],
        detail: [-0.6, -0.2, 0.2, 0.6].map((f) =>
          line([
            [hx * f, -hy],
            [hx * f, hy],
          ]),
        ),
      };
    case 'TubularHeatExchanger':
      return { outline: [box], detail: [line(zigzag(hx * 0.8, hy * 0.6, 3))] };
    case 'Filter':
      return {
        outline: [box],
        detail: [
          line([
            [-hx, -hy],
            [hx, hy],
          ]),
        ],
      };
    case 'Agitator':
      return {
        outline: [],
        detail: [
          line([
            [0, hy],
            [0, -hy * 0.6],
          ]),
          line([
            [-hx * 0.6, -hy * 0.6],
            [hx * 0.6, -hy * 0.6],
          ]),
        ],
      };
    case 'Mixer':
      return {
        outline: [round],
        detail: [
          line([
            [-r, 0],
            [r, 0],
          ]),
          line([
            [0, -r],
            [0, r],
          ]),
        ],
      };
    case 'Impeller':
      return {
        outline: [round],
        detail: [0, 1, 2].map((i) =>
          line([
            [0, 0],
            [r * Math.cos((2 * Math.PI * i) / 3), r * Math.sin((2 * Math.PI * i) / 3)],
          ]),
        ),
      };
    case 'Displacer':
      return { outline: [round], detail: [] };
    case 'TubeBundle':
      return { outline: [box], detail: [line(zigzag(hx * 0.8, hy * 0.6, 4))] };
    case 'Chamber':
      return { outline: [box], detail: [] };
    default:
      return { outline: [box], detail: [] };
  }
}

/** The equipment symbol for a class; an unknown class gets the generic box (the importer maps those to `Custom`). */
export function equipmentSymbol(cls: string, convention: PidConvention): PidSymbol {
  const [hx, hy] = halfExtents(cls);
  const drawing = drawingOf(cls, hx, hy);
  const initial = text([0, 0], Math.max(2.5, Math.min(hx, hy) * 0.45), cls.charAt(0));
  return {
    class: cls,
    name: cls.replace(/([a-z])([A-Z])/g, '$1 $2'),
    family: 'equipment',
    halfWidth: hx,
    halfHeight: hy,
    ports: [
      [-hx, 0],
      [hx, 0],
      [0, hy],
      [0, -hy],
    ],
    shapes: convention === 'ISO-10628-2' ? [...drawing.outline, ...drawing.detail] : [...drawing.outline, initial],
  };
}
