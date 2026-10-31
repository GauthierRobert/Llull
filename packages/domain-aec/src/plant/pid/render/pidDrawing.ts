/**
 * A P&ID sheet as drawing primitives (plant 04 PID §2: the 2D view and SVG are presentation over the same model). One glyph per item, its id the
 * item id; symbols come from the built-in library and are drawn at their default size, never stored.
 */

import type { DrawingPrimitive } from '@core/model/drawing';
import type { Vec2 } from '@core/model/vectors';
import type { PidConvention, PidItem, PidModel, PidSegment, PidSheet } from '../model';
import { equipmentSymbol } from '../symbols/equipment';
import { BUBBLE_R, INLINE_HALF, actuatorSymbol, connectorSymbol, flowArrowSymbol, instrumentSymbol, pipingSymbol } from '../symbols/piping';
import { label, placeSymbol } from './placeSymbol';

export const LAYERS = { equipment: 'PID-EQPT', pipe: 'PID-PIPE', instrument: 'PID-INST', signal: 'PID-SIGN', text: 'PID-TEXT' } as const;

export interface PidGlyph {
  readonly id: string;
  readonly kind: PidItem['kind'];
  readonly tag?: string;
  /** Main layer of the glyph (its text is on PID-TEXT). */
  readonly layer: string;
  readonly primitives: readonly DrawingPrimitive[];
}

export interface PidDrawing {
  readonly sheet: PidSheet;
  readonly convention: PidConvention;
  readonly glyphs: readonly PidGlyph[];
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const angleOf = (v: Vec2): number => (Math.atan2(v[1], v[0]) * 180) / Math.PI;

/** The middle of the longest leg of a route and that leg's direction (degrees). */
function longestLeg(route: readonly Vec2[]): { mid: Vec2; angleDeg: number; length: number } | undefined {
  let best: { mid: Vec2; angleDeg: number; length: number } | undefined;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1] as Vec2;
    const b = route[i] as Vec2;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (best === undefined || length > best.length)
      best = { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], angleDeg: angleOf(sub(b, a)), length };
  }
  return best;
}

function segmentGlyph(segment: PidSegment): PidGlyph {
  const primitives: DrawingPrimitive[] = [
    {
      type: 'polyline',
      layer: LAYERS.pipe,
      style: segment.primary ? 'visible' : 'thin',
      points: segment.route.map((p): Vec2 => [p[0], p[1]]),
    },
  ];
  const leg = longestLeg(segment.route);
  if (leg !== undefined && segment.flow !== 'none' && leg.length >= 12)
    primitives.push(
      ...placeSymbol(flowArrowSymbol, { at: leg.mid, angleDeg: leg.angleDeg + (segment.flow === 'reverse' ? 180 : 0), layer: LAYERS.pipe }),
    );
  return { id: segment.id, kind: 'segment', layer: LAYERS.pipe, primitives };
}

function inlineAngle(ports: readonly Vec2[], fallback: number): number {
  const a = ports[0];
  const b = ports[ports.length - 1];
  return a !== undefined && b !== undefined && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9 ? angleOf(sub(b, a)) : fallback;
}

function itemGlyph(pid: PidModel, item: PidItem, convention: PidConvention): PidGlyph {
  const base = { id: item.id, kind: item.kind, ...(item.tag === undefined ? {} : { tag: item.tag }) };
  switch (item.kind) {
    case 'equipment': {
      const symbol = equipmentSymbol(item.dexpiClass, convention);
      const below: Vec2 = [item.at[0], item.at[1] - symbol.halfHeight - 4];
      return {
        ...base,
        layer: LAYERS.equipment,
        primitives: [
          ...placeSymbol(symbol, { at: item.at, angleDeg: item.rotationDeg, layer: LAYERS.equipment }),
          ...(item.tag === undefined ? [] : [label(below, 3, item.tag)]),
        ],
      };
    }
    case 'nozzle': {
      const [x, y] = item.port;
      return {
        ...base,
        layer: LAYERS.equipment,
        primitives: [
          {
            type: 'polygon',
            layer: LAYERS.equipment,
            style: 'visible',
            points: [
              [x - 1.2, y - 1.2],
              [x + 1.2, y - 1.2],
              [x + 1.2, y + 1.2],
              [x - 1.2, y + 1.2],
            ],
          },
          label([x + 3, y + 3], 1.8, item.subTag),
        ],
      };
    }
    case 'line': {
      const first = pid.items[item.segmentIds[0] ?? ''];
      const leg = first?.kind === 'segment' ? longestLeg(first.route) : undefined;
      return {
        ...base,
        layer: LAYERS.pipe,
        primitives: item.lineNumber === undefined || leg === undefined ? [] : [label([leg.mid[0], leg.mid[1] + 3], 2.2, item.lineNumber)],
      };
    }
    case 'segment':
      return segmentGlyph(item);
    case 'inline': {
      const symbol = pipingSymbol(item.dexpiClass);
      const turned = inlineAngle(item.ports, item.rotationDeg);
      return {
        ...base,
        layer: LAYERS.pipe,
        primitives: [
          ...placeSymbol(symbol, { at: item.at, angleDeg: turned, flip: item.reversed === true, layer: LAYERS.pipe }),
          ...(item.tag === undefined ? [] : [label([item.at[0], item.at[1] - INLINE_HALF - 4], 2.2, item.tag)]),
        ],
      };
    }
    case 'instrument': {
      const symbol = instrumentSymbol(item.location, item.display);
      const letters = `${item.category}${item.functions}`;
      return {
        ...base,
        layer: LAYERS.instrument,
        primitives: [
          ...placeSymbol(symbol, { at: item.at, angleDeg: 0, layer: LAYERS.instrument }),
          label([item.at[0], item.at[1] + BUBBLE_R * 0.35], 2.4, letters === '' ? (item.tag ?? '') : letters),
          label([item.at[0], item.at[1] - BUBBLE_R * 0.5], 2.4, item.loopNumber),
        ],
      };
    }
    case 'signal': {
      const style =
        item.signalKind === 'measuring' || item.signalKind === 'capillary' ? 'thin' : item.signalKind === 'electric' ? 'hidden' : 'center';
      return {
        ...base,
        layer: LAYERS.signal,
        primitives: [{ type: 'polyline', layer: LAYERS.signal, style, points: item.route.map((p): Vec2 => [p[0], p[1]]) }],
      };
    }
    case 'actuating': {
      const valve = pid.items[item.valveId];
      const at: Vec2 = valve === undefined ? item.at : [valve.at[0], valve.at[1] + 3.2];
      return {
        ...base,
        layer: LAYERS.instrument,
        primitives: [
          ...placeSymbol(actuatorSymbol(item.actuator), { at, angleDeg: 0, layer: LAYERS.instrument }),
          ...(item.failAction === undefined ? [] : [label([at[0] + 7, at[1] + 8], 2, item.failAction)]),
        ],
      };
    }
    case 'opc': {
      const target = item.targetSheet === undefined ? undefined : pid.sheets[item.targetSheet]?.number;
      return {
        ...base,
        layer: LAYERS.pipe,
        primitives: [
          ...placeSymbol(connectorSymbol(item.direction), { at: item.at, angleDeg: item.rotationDeg, layer: LAYERS.pipe }),
          label([item.at[0], item.at[1] - 8], 2, target === undefined ? item.pairKey : `${item.pairKey} > ${target}`),
        ],
      };
    }
    case 'annotation':
      return {
        ...base,
        layer: LAYERS.pipe,
        primitives:
          item.dexpiClass === 'PipeFlowArrow'
            ? placeSymbol(flowArrowSymbol, { at: item.at, angleDeg: item.rotationDeg, layer: LAYERS.pipe })
            : [],
      };
    case 'loop':
      return { ...base, layer: LAYERS.instrument, primitives: [] };
  }
}

/** The glyphs of one sheet, in model order. */
export function buildPidDrawing(pid: PidModel, sheet: PidSheet, convention: PidConvention = pid.convention): PidDrawing {
  const glyphs = pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item !== undefined && item.sheetId === sheet.id ? [itemGlyph(pid, item, convention)] : [];
  });
  return { sheet, convention, glyphs };
}
