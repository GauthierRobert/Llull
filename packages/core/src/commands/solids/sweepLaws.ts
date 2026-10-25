/** Law, orientation and station-blend params of `sweep_profile` (SWG): zod fields, parsing into the model, and the coded refusals. */

import type { CadDocument, SweepEntity } from '../../model/types';
import type { ScalarLaw } from '../../lib/law/types';
import { evaluateSweep } from '../../geometry/sweepEval/evaluate';
import { sectionSymmetryOrder, symmetryTurns } from '../../geometry/sweepEval/symmetry';
import { lawFunction } from '../../lib/law/evaluate';
import { parseLaw, type LawInput } from '../../lib/law/parse';
import { tableRejection } from '../noop';
import { axisCrossing, helixOverlap, parseOrientation, type OrientationContext, type OrientationInput } from './sweepOrientation';
import { z } from '../schema';
import type { CommandResult } from '../types';

const REMEDIATION: Readonly<Record<string, string>> = {
  SWG_PATH_INVALID: 'give exactly one of path (>= 2 points) or pathId (a curve entity)',
  SWG_PATH_NOT_G1: 'use bendRadius to round the corners, or smooth: true',
  SWG_LAW_INVALID: 'fix the law: finite numbers, tables with t strictly increasing from 0 to 1, expressions in t, s, L',
  SWG_LAW_NONPOSITIVE: 'keep scale, area and stretch strictly positive over the whole path',
  SWG_LAW_EXCLUSIVE: 'give one of scale / area, and one of twist / twistTurns',
  SWG_CLOSED_TWIST_NOT_PERIODIC: 'use a whole number of turns (a multiple of 2π / symmetry order) on a closed path',
  SWG_FRAME_DEGENERATE: 'use orientation minimal, or another direction; frenet needs a path that bends everywhere',
  SWG_SELF_INTERSECTION_LOCAL: 'use a smaller section / scale or a larger bend radius',
  SWG_SELF_INTERSECTION_GLOBAL: 'use a larger pitch or a smaller section so neighbouring turns do not touch',
  SWG_GUIDE_COUNT: 'give 1 or 2 rail curves in guideIds',
  SWG_GUIDE_PLANE_NO_INTERSECTION: 'extend the rail so every section plane along the path crosses it',
  SWG_GUIDE_ANCHOR_UNDEFINED:
    'give anchors: one [x, y] section-coordinate point per rail, or put the section outline through the rail at the start',
  SWG_SURFACE_TOO_FAR: 'project the path onto the reference surface first, or raise orientation.tolerance',
  SWG_PARAM_INVALID: 'give the parameters exactly as the command description states',
};

/** Coded refusal of `sweep_profile`: unchanged document, `SWG_*` code, paths, one-line fix. */
export const refuseSweep = tableRejection(REMEDIATION);

/** What a law runs over and in what unit its values are: the sweeps' (path fraction or arc length, radians / factors) or add_helix's (turn fraction, document units). */
export interface LawSpec {
  /** The independent variable t and what it spans. */
  readonly parameter: string;
  /** The unit of the values. */
  readonly unit: string;
  /** Whether `table` points and expressions may use arc length (a sweep's lawParameter arc_length). */
  readonly arcLength: boolean;
}

const SWEEP_LAW: LawSpec = {
  parameter: 't in [0, 1] (the arc-length fraction along the path)',
  unit: 'the unit of the law (radians for twist, a factor for scale)',
  arcLength: true,
};

type LawShape = {
  type: z.ZodEnum<{ constant: 'constant'; linear: 'linear'; s_curve: 's_curve'; table: 'table'; expression: 'expression' }>;
  value: z.ZodOptional<z.ZodNumber>;
  start: z.ZodOptional<z.ZodNumber>;
  end: z.ZodOptional<z.ZodNumber>;
  points: z.ZodOptional<z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber]>>>;
  startSlope: z.ZodOptional<z.ZodNumber>;
  endSlope: z.ZodOptional<z.ZodNumber>;
  expression: z.ZodOptional<z.ZodString>;
};

const lawShape = (spec: LawSpec): LawShape => ({
  type: z
    .enum(['constant', 'linear', 's_curve', 'table', 'expression'])
    .describe('Law kind: constant, linear, s_curve (smoothstep), table or expression.'),
  value: z.number().describe(`constant: the value, in ${spec.unit}.`).optional(),
  start: z.number().describe('linear / s_curve: value at the path start (t = 0).').optional(),
  end: z.number().describe('linear / s_curve: value at the path end (t = 1).').optional(),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .describe(
      `table: [t, value] pairs (t ${spec.arcLength ? 'a fraction of the path 0..1, or arc length in document units with lawParameter arc_length' : spec.parameter}; value in ${spec.unit}), t strictly increasing from 0 to the end; a smooth shape-preserving cubic (no overshoot) passes through them.`,
    )
    .optional(),
  startSlope: z
    .number()
    .describe('table: optional derivative at t = 0 (default: a shape-preserving one-sided estimate from the first points).')
    .optional(),
  endSlope: z
    .number()
    .describe('table: optional derivative at t = 1 (default: a shape-preserving one-sided estimate from the last points).')
    .optional(),
  expression: z
    .string()
    .describe(
      spec.arcLength
        ? 'expression: formula of t (0..1 along the path), s (arc length from the start) and L (path length); radians, e.g. "1 + 0.25*sin(2*pi*t)".'
        : `expression: formula of t (${spec.parameter}) in ${spec.unit}, e.g. "10 + 2*t".`,
    )
    .optional(),
});

/** Zod object of a scalar law with a per-parameter description (`what` names the quantity and its unit). */
export const lawField = (what: string, spec: LawSpec = SWEEP_LAW): z.ZodOptional<z.ZodObject<LawShape>> =>
  z
    .object(lawShape(spec))
    .describe(
      `${what}. A law over ${spec.parameter}: { type: "linear", start, end } | "s_curve" (smoothstep) | "constant" { value } | "table" { points } | "expression" { expression }.`,
    )
    .optional();

/** Laws of a request, parsed; the first incomplete one gives a refusal message. */
export interface ParsedLaws {
  readonly twist?: ScalarLaw;
  readonly scale?: ScalarLaw;
  readonly area?: ScalarLaw;
  readonly stretch?: { readonly x?: ScalarLaw; readonly y?: ScalarLaw };
}

export function parseLaws(
  inputs: Readonly<Record<'twist' | 'scale' | 'area' | 'stretchX' | 'stretchY', LawInput | undefined>>,
): ParsedLaws | { readonly code: 'SWG_LAW_INVALID'; readonly message: string; readonly path: string } {
  const parsed: Record<string, ScalarLaw> = {};
  const paths = { twist: 'twist', scale: 'scale', area: 'area', stretchX: 'stretch.x', stretchY: 'stretch.y' } as const;
  for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
    const input = inputs[key];
    if (input === undefined) continue;
    const law = parseLaw(input);
    if (typeof law === 'string') return { code: 'SWG_LAW_INVALID', message: `${paths[key]}: ${law}`, path: paths[key] };
    parsed[key] = law;
  }
  const stretch = {
    ...(parsed.stretchX === undefined ? {} : { x: parsed.stretchX }),
    ...(parsed.stretchY === undefined ? {} : { y: parsed.stretchY }),
  };
  return {
    ...(parsed.twist === undefined ? {} : { twist: parsed.twist }),
    ...(parsed.scale === undefined ? {} : { scale: parsed.scale }),
    ...(parsed.area === undefined ? {} : { area: parsed.area }),
    ...(Object.keys(stretch).length === 0 ? {} : { stretch }),
  };
}

/**
 * A table law given over the arc length (points [length, value], length 0..L) as the same law over the arc-length fraction; other laws unchanged.
 * @failure a table that does not run from 0 to the path length -> reason
 */
export function fractionLaw(input: LawInput | undefined, length: number): LawInput | undefined | string {
  if (input?.type !== 'table' || !Array.isArray(input.points)) return input;
  const points = input.points as ReadonlyArray<readonly [number, number]>;
  const last = points[points.length - 1]?.[0];
  if (points[0]?.[0] !== 0 || typeof last !== 'number' || Math.abs(last - length) > 1e-9 * Math.max(1, length))
    return `a table over arc length must run from 0 to the path length ${length} (got ${String(points[0]?.[0])}..${String(last)})`;
  const scaled = (slope: unknown): unknown => (typeof slope === 'number' ? slope * length : slope);
  return {
    ...input,
    points: points.map(([t, value]) => [t / length, value] as const),
    ...(input.startSlope === undefined ? {} : { startSlope: scaled(input.startSlope) }),
    ...(input.endSlope === undefined ? {} : { endSlope: scaled(input.endSlope) }),
  };
}

/** Raw law / orientation params of `sweep_profile`. */
interface DesignInput {
  readonly twistInput: LawInput | undefined;
  readonly twistTurns: number | undefined;
  readonly scaleInput: LawInput | undefined;
  readonly areaInput: LawInput | undefined;
  readonly stretch: { readonly x?: LawInput | undefined; readonly y?: LawInput | undefined } | undefined;
  readonly orientationInput: OrientationInput | undefined;
  readonly orientationContext: OrientationContext;
  readonly stationBlend: 'smooth' | 'linear' | undefined;
  readonly stations: ReadonlyArray<unknown> | undefined;
  /** Path length when the laws are given over arc length (`lawParameter: 'arc_length'`): table laws are converted to fractions. */
  readonly arcLength?: number | undefined;
}

type Refusal = { readonly code: string; readonly message: string; readonly path: string };

/** The law / orientation / blend fields to store on the sweep, or the first coded refusal. */
export function designedFields(input: DesignInput): { readonly refusal: Refusal } | { readonly fields: Partial<SweepEntity> } {
  const refuse = (code: string, message: string, path: string): { refusal: Refusal } => ({ refusal: { code, message, path } });
  if (input.scaleInput !== undefined && input.areaInput !== undefined)
    return refuse('SWG_LAW_EXCLUSIVE', 'give scale or area, not both', 'scale');
  if (input.twistInput !== undefined && input.twistTurns !== undefined)
    return refuse('SWG_LAW_EXCLUSIVE', 'give twist or twistTurns, not both', 'twist');
  if (input.areaInput !== undefined && input.stations !== undefined)
    return refuse('SWG_LAW_EXCLUSIVE', 'an area law needs a constant section, not stations', 'area');
  if (input.stationBlend !== undefined && input.stations === undefined)
    return refuse('SWG_LAW_INVALID', 'stationBlend needs stations', 'stationBlend');
  const converted: Record<'twist' | 'scale' | 'area' | 'stretchX' | 'stretchY', LawInput | undefined> = {
    twist: input.twistTurns === undefined ? input.twistInput : { type: 'linear', start: 0, end: 2 * Math.PI * input.twistTurns },
    scale: input.scaleInput,
    area: input.areaInput,
    stretchX: input.stretch?.x,
    stretchY: input.stretch?.y,
  };
  if (input.arcLength !== undefined) {
    const paths = { twist: 'twist', scale: 'scale', area: 'area', stretchX: 'stretch.x', stretchY: 'stretch.y' } as const;
    for (const key of Object.keys(converted) as Array<keyof typeof converted>) {
      const made = fractionLaw(converted[key], input.arcLength);
      if (typeof made === 'string') return refuse('SWG_LAW_INVALID', `${paths[key]}: ${made}`, paths[key]);
      converted[key] = made;
    }
  }
  const laws = parseLaws(converted);
  if ('code' in laws) return refuse(laws.code, laws.message, laws.path);
  const orientation = parseOrientation(input.orientationInput, input.orientationContext);
  if (typeof orientation === 'string') return refuse('SWG_FRAME_DEGENERATE', orientation, 'orientation');
  return {
    fields: {
      ...laws,
      ...(orientation === undefined ? {} : { orientation }),
      ...(input.stationBlend === undefined ? {} : { stationBlend: input.stationBlend }),
    },
  };
}

/** Laws, frames and (closed paths) twist periodicity of a built sweep: a refusal, or the largest section scale along the path (1 without laws). */
export function sweepDesign(doc: CadDocument, entity: SweepEntity, closed: boolean): CommandResult | { readonly maxScale: number } {
  const evaluation = evaluateSweep(entity);
  if (!('frames' in evaluation)) {
    const path = 'param' in evaluation ? evaluation.param : 'orientation';
    return refuseSweep(doc, 'sweep_profile', evaluation.code, evaluation.message, [], [path]);
  }
  if (closed && entity.twist !== undefined && Number.isFinite(sectionSymmetryOrder(entity.section))) {
    const f = lawFunction(entity.twist);
    const total = f(1, evaluation.length) - f(0, evaluation.length);
    const step = (2 * Math.PI) / sectionSymmetryOrder(entity.section);
    const turns = symmetryTurns(entity.section, total);
    if (Math.abs(turns - Math.round(turns)) > 1e-6)
      return refuseSweep(
        doc,
        'sweep_profile',
        'SWG_CLOSED_TWIST_NOT_PERIODIC',
        `total twist ${total.toFixed(6)} rad on a closed path is not a multiple of ${step.toFixed(6)} rad (2π / section symmetry order)`,
        [],
        ['twist'],
      );
  }
  if (closed) {
    const open = [
      ['scale', entity.scale],
      ['area', entity.area],
      ['stretch.x', entity.stretch?.x],
      ['stretch.y', entity.stretch?.y],
    ] as const;
    for (const [param, law] of open) {
      if (law === undefined) continue;
      const f = lawFunction(law);
      const [first, last] = [f(0, evaluation.length), f(1, evaluation.length)];
      if (Math.abs(last - first) > 1e-9 * Math.max(1, Math.abs(first)))
        return refuseSweep(
          doc,
          'sweep_profile',
          'SWG_LAW_INVALID',
          `${param} must return to its start value on a closed path (f(0)=${first}, f(1)=${last})`,
          [],
          [param],
        );
    }
  }
  const maxScale = evaluation.transforms === null ? 1 : Math.max(...evaluation.transforms.map((t) => Math.max(t.sx, t.sy)));
  const crossing = axisCrossing(entity, evaluation.frames, evaluation.transforms);
  if (crossing !== null) return refuseSweep(doc, 'sweep_profile', 'SWG_SELF_INTERSECTION_LOCAL', crossing, [], ['section']);
  const overlap = helixOverlap(entity, evaluation.transforms);
  if (overlap !== null) return refuseSweep(doc, 'sweep_profile', 'SWG_SELF_INTERSECTION_GLOBAL', overlap, [], ['pitch']);
  return { maxScale };
}
