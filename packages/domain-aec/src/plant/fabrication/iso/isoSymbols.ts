/**
 * Symbols of an isometric (plant 05 ISO §5.8, TR-ISO-10): strokes by component family (elbow arc, tee dot, flange double bar at the flange face, reducer trapezoid,
 * valve bow-tie with stem, cap bar, instrument circle) and by joint class (shop weld dot, site weld cross, field-fit weld cross in a circle), drawn at the
 * pipe line weight, not scaled to the bore. Positions come from the layout (paper mm, y up). Pure.
 */

import type { Vec2 } from '@core/model/vectors';
import { nodeKey, type JointClass, type JointNode } from '../joints';
import type { PipingNetwork } from '../model';
import type { IsoGraph, WalkStep } from './isoGraph';
import type { IsoLayout } from './isoLayout';
import type { IsoPrimitive } from './isoRender';

const unitOf = (a: Vec2, b: Vec2): Vec2 => {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
};
const mix = (p: Vec2, direction: Vec2, distance: number): Vec2 => [p[0] + direction[0] * distance, p[1] + direction[1] * distance];

const line = (a: Vec2, b: Vec2): IsoPrimitive => ({ t: 'line', layer: 'ISO-SYMB', a, b });

/** The joint marker at `at`. */
function jointSymbol(kind: JointClass, at: Vec2): IsoPrimitive[] {
  if (kind === 'shop') return [{ t: 'circle', layer: 'ISO-SYMB', c: at, r: 0.9, fill: true }];
  if (kind !== 'site' && kind !== 'field_fit') return [];
  const cross = [
    line([at[0] - 1.8, at[1] - 1.8], [at[0] + 1.8, at[1] + 1.8]),
    line([at[0] - 1.8, at[1] + 1.8], [at[0] + 1.8, at[1] - 1.8]),
  ];
  return kind === 'site' ? cross : [{ t: 'circle', layer: 'ISO-SYMB', c: at, r: 2.2 }, ...cross];
}

export interface SymbolInput {
  readonly network: PipingNetwork;
  readonly graph: IsoGraph;
  readonly layout: IsoLayout;
  readonly joints: readonly JointNode[];
  /** Joint class by node key with the set_weld_type overrides applied. */
  readonly classes: ReadonlyMap<string, JointClass>;
}

function stepSymbol(step: WalkStep, index: number, input: SymbolInput): IsoPrimitive[] {
  const { layout, network } = input;
  const a = layout.starts[index] as Vec2;
  const b = layout.ends[index] as Vec2;
  const u = unitOf(a, b);
  const normal: Vec2 = [-u[1], u[0]];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const middle = mix(a, u, length / 2);
  const component = network.components[step.segment.componentIndex];
  const bar = (at: Vec2, half: number): IsoPrimitive => line(mix(at, normal, half), mix(at, normal, -half));
  switch (step.segment.type) {
    case 'FLANGE':
    case 'FLANGE-BLIND': {
      const faceAtStart = nodeKey(step.start) === nodeKey(component?.ends.find((end) => end.endType === 'FL')?.xyz ?? step.end);
      const face = faceAtStart ? a : b;
      const inward = faceAtStart ? u : ([-u[0], -u[1]] as Vec2);
      return [bar(face, 3.2), bar(mix(face, inward, Math.min(1.4, length / 2)), 3.2)];
    }
    case 'VALVE': {
      const half = Math.min(length / 2, 4.5);
      const [p, q] = [mix(middle, u, -half), mix(middle, u, half)];
      return [
        { t: 'poly', layer: 'ISO-SYMB', points: [mix(p, normal, 2.2), mix(p, normal, -2.2), middle], closed: true },
        { t: 'poly', layer: 'ISO-SYMB', points: [mix(q, normal, 2.2), mix(q, normal, -2.2), middle], closed: true },
        line(middle, mix(middle, normal, 5)),
      ];
    }
    case 'REDUCER-CONCENTRIC':
    case 'REDUCER-ECCENTRIC':
      return [
        {
          t: 'poly',
          layer: 'ISO-SYMB',
          points: [mix(a, normal, 2.4), mix(b, normal, 1.2), mix(b, normal, -1.2), mix(a, normal, -2.4)],
          closed: true,
        },
      ];
    case 'CAP':
      return [bar(b, 2.4)];
    case 'INSTRUMENT':
      return [{ t: 'circle', layer: 'ISO-SYMB', c: middle, r: 2 }];
    case 'TEE':
      return step.segment.part === 'leg1' ? [{ t: 'circle', layer: 'ISO-SYMB', c: b, r: 0.8, fill: true }] : [];
    case 'OLET':
      return [{ t: 'circle', layer: 'ISO-SYMB', c: a, r: 0.8, fill: true }];
    case 'ELBOW':
    case 'BEND': {
      if (step.segment.part !== 'leg1') return [];
      const second = input.graph.steps.find(
        (candidate) => candidate.segment.componentIndex === step.segment.componentIndex && candidate.segment.part === 'leg2',
      );
      const corner = layout.nodes.get(nodeKey(step.segment.b));
      const first = layout.nodes.get(nodeKey(step.segment.a));
      const last = second === undefined ? undefined : layout.nodes.get(nodeKey(second.segment.b));
      if (corner === undefined || first === undefined || last === undefined) return [];
      const reach = (point: Vec2): number => Math.min(2.6, Math.hypot(point[0] - corner[0], point[1] - corner[1]) / 2);
      const from = mix(corner, unitOf(corner, first), reach(first));
      const to = mix(corner, unitOf(corner, last), reach(last));
      const points = [0, 0.25, 0.5, 0.75, 1].map(
        (t): Vec2 => [
          (1 - t) * (1 - t) * from[0] + 2 * t * (1 - t) * corner[0] + t * t * to[0],
          (1 - t) * (1 - t) * from[1] + 2 * t * (1 - t) * corner[1] + t * t * to[1],
        ],
      );
      return [{ t: 'poly', layer: 'ISO-SYMB', points, closed: false }];
    }
    default:
      return [];
  }
}

/** Symbols of every step and every joint of the line. */
export function isoSymbols(input: SymbolInput): IsoPrimitive[] {
  const out = input.graph.steps.flatMap((step, index) => stepSymbol(step, index, input));
  for (const joint of input.joints) {
    const at = input.layout.nodes.get(joint.key);
    if (at !== undefined) out.push(...jointSymbol(input.classes.get(joint.key) ?? joint.joint, at));
  }
  return out;
}
