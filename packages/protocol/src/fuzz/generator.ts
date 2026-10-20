/**
 * Seeded design generator of the robustness fuzz (SC-Q3). Pure and deterministic: (seed, options) -> the same `FuzzCase` everywhere.
 * A case starts from a box, an extruded profile or a revolved profile standing on z = 0, then applies 1..8 feature steps (joins, cuts,
 * fillets, chamfers, a shell, holes, patterns) through real registry commands. Sizes and placements lie on the 2.5 mm grid; blend sizes
 * (fillet radius, chamfer distance, shell thickness) are sub-grid by design.
 * Layout invariants that keep every subset of steps a valid plan (the minimiser relies on it): cuts come from the top and never reach
 * z = 0, so the bottom face stays planar and holes (drilled upward from it) always find it; every step references only `$body`.
 */

import { createPrng, floorToGrid, FUZZ_GRID_MM, type Prng } from './prng';
import { FUZZ_FEATURE_KINDS, type FuzzAction, type FuzzCase, type FuzzFeatureKind, type FuzzStep } from './types';

export const MAX_FUZZ_FEATURES = 8;
const BLEND_SIZES = [0.5, 1] as const;
const SHELL_THICKNESSES = [0.5, 1] as const;
const HOLE_DIAMETERS = [2.5, 5, 7.5] as const;

export interface FuzzOptions {
  /** Feature kinds to draw from (default: all). A kernel without fillets drops fillet / chamfer / shell. */
  readonly kinds?: readonly FuzzFeatureKind[];
  /** Upper bound of feature steps after the base (default 8). */
  readonly maxFeatures?: number;
}

interface Half {
  readonly hx: number;
  readonly hy: number;
}

interface Hole {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** What later steps need to know about the base: its height and the regions where tools land. */
interface Layout {
  readonly height: number;
  readonly outer: Half;
  /** Rectangle (centred on the axis) inside the top face. */
  readonly top: Half;
  /** Rectangle inside the bottom face (z = 0). */
  readonly bottom: Half;
  readonly holes: Hole[];
  shelled: boolean;
  /** Lowest z a cut from the top has reached (the base height while uncut): blind holes from below stay under it. */
  floor: number;
}

const fmt = (value: number): string => String(Math.round(value * 1000) / 1000);
const BODY = '$body';

/** An even number of grid steps (a multiple of 5 mm): a centred size whose two faces both land on the grid. */
const span = (prng: Prng, minHalfSteps: number, maxHalfSteps: number): number => 2 * prng.grid(minHalfSteps, maxHalfSteps);

/** A grid coordinate in [-half, half]. */
function coordinate(prng: Prng, half: number): number {
  const steps = Math.max(0, Math.floor(floorToGrid(half) / FUZZ_GRID_MM));
  return prng.int(-steps, steps) * FUZZ_GRID_MM;
}

const boxTool = (size: readonly [number, number, number], at: readonly [number, number, number]): FuzzAction => ({
  command: 'add_box',
  params: { size: [...size], anchor: 'base-center', position: [...at] },
  as: 'tool',
});

/** A cylinder standing on z = base; height is a multiple of 5 so its centre stays on the grid. */
const cylinderTool = (radius: number, height: number, at: readonly [number, number, number]): FuzzAction => ({
  command: 'add_cylinder',
  params: { radius, height, position: [at[0], at[1], at[2] + height / 2] },
  as: 'tool',
});

const combine = (op: 'union' | 'subtract', b: string): FuzzAction => ({ command: 'boolean', params: { op, a: BODY, b }, as: 'body' });

function baseStep(prng: Prng): { step: FuzzStep; layout: Layout } {
  const kind = prng.pick(['box', 'extrude', 'revolve'] as const);
  const units: FuzzAction = { command: 'set_units', params: { units: 'mm' } };
  const height = prng.grid(4, 12);
  if (kind === 'revolve') {
    const radius = prng.grid(5, 12);
    const topRadius = Math.max(10, radius - prng.grid(0, 3));
    const shoulder = prng.grid(1, height / FUZZ_GRID_MM - 1);
    const profile = [
      [0, 0],
      [radius, 0],
      [radius, shoulder],
      [topRadius, height],
      [0, height],
    ];
    const inscribed = (r: number): Half => ({ hx: Math.max(FUZZ_GRID_MM, floorToGrid(r / Math.SQRT2 - FUZZ_GRID_MM)), hy: 0 });
    const square = (r: number): Half => ({ hx: inscribed(r).hx, hy: inscribed(r).hx });
    return {
      step: {
        kind: 'base',
        effect: 'add',
        label: `revolve R${fmt(radius)}/R${fmt(topRadius)} H${fmt(height)} shoulder ${fmt(shoulder)}`,
        actions: [units, { command: 'revolve_profile', params: { profile, axis: 'z' }, as: 'body' }],
      },
      layout: {
        height,
        outer: { hx: radius, hy: radius },
        top: square(topRadius),
        bottom: square(radius),
        holes: [],
        shelled: false,
        // Outside the top radius the stock is only as tall as the shoulder.
        floor: shoulder,
      },
    };
  }
  const width = span(prng, 4, 12);
  const depth = span(prng, 4, 12);
  const outer = { hx: width / 2, hy: depth / 2 };
  if (kind === 'box') {
    const inner = { hx: outer.hx - FUZZ_GRID_MM, hy: outer.hy - FUZZ_GRID_MM };
    return {
      step: {
        kind: 'base',
        effect: 'add',
        label: `box ${fmt(width)}x${fmt(depth)}x${fmt(height)}`,
        actions: [
          units,
          { command: 'add_box', params: { size: [width, depth, height], anchor: 'base-center', position: [0, 0, 0] }, as: 'body' },
        ],
      },
      layout: { height, outer, top: inner, bottom: inner, holes: [], shelled: false, floor: height },
    };
  }
  const chamfer = Math.min(prng.pick([0, 2.5, 5] as const), floorToGrid(Math.min(width, depth) / 4));
  const [x, y, c] = [outer.hx, outer.hy, chamfer];
  const profile =
    c === 0
      ? [
          [-x, -y],
          [x, -y],
          [x, y],
          [-x, y],
        ]
      : [
          [-x + c, -y],
          [x - c, -y],
          [x, -y + c],
          [x, y - c],
          [x - c, y],
          [-x + c, y],
          [-x, y - c],
          [-x, -y + c],
        ];
  const inner = { hx: Math.max(FUZZ_GRID_MM, x - c - FUZZ_GRID_MM), hy: Math.max(FUZZ_GRID_MM, y - c - FUZZ_GRID_MM) };
  return {
    step: {
      kind: 'base',
      effect: 'add',
      label: `extrude ${fmt(width)}x${fmt(depth)} corner ${fmt(c)} depth ${fmt(height)}`,
      actions: [units, { command: 'extrude_profile', params: { profile, depth: height }, as: 'body' }],
    },
    layout: { height, outer, top: inner, bottom: inner, holes: [], shelled: false, floor: height },
  };
}

function joinStep(prng: Prng, layout: Layout): FuzzStep {
  const { height, top, outer } = layout;
  if (prng.next() < 0.3) {
    const along = prng.pick(['x', 'y'] as const);
    const sign = prng.pick([1, -1] as const);
    const thick = span(prng, 1, 3);
    const length = span(prng, 1, 4);
    const base = Math.min(prng.pick([0, 2.5] as const), height - FUZZ_GRID_MM);
    const tall = prng.grid(1, (height - base) / FUZZ_GRID_MM);
    const reach = (along === 'x' ? outer.hx : outer.hy) + thick / 2 - FUZZ_GRID_MM;
    const at: [number, number, number] = along === 'x' ? [sign * reach, 0, base] : [0, sign * reach, base];
    const size: [number, number, number] = along === 'x' ? [thick, length, tall] : [length, thick, tall];
    return {
      kind: 'join',
      effect: 'add',
      label: `join side box ${size.map(fmt).join('x')} at (${at.map(fmt).join(', ')})`,
      actions: [boxTool(size, at), combine('union', '$tool')],
    };
  }
  const sink = prng.pick([0, 2.5] as const);
  const [x, y] = [coordinate(prng, top.hx), coordinate(prng, top.hy)];
  if (prng.next() < 0.5) {
    const radius = prng.grid(1, 4);
    const tall = 5 * prng.int(1, 3);
    return {
      kind: 'join',
      effect: 'add',
      label: `join boss R${fmt(radius)} H${fmt(tall)} at (${fmt(x)}, ${fmt(y)}) sunk ${fmt(sink)}`,
      actions: [cylinderTool(radius, tall, [x, y, height - sink]), combine('union', '$tool')],
    };
  }
  const size: [number, number, number] = [span(prng, 1, 4), span(prng, 1, 4), prng.grid(1, 6)];
  return {
    kind: 'join',
    effect: 'add',
    label: `join block ${size.map(fmt).join('x')} at (${fmt(x)}, ${fmt(y)}) sunk ${fmt(sink)}`,
    actions: [boxTool(size, [x, y, height - sink]), combine('union', '$tool')],
  };
}

/** Pocket depth from the top: >= one grid step, leaving >= 5 mm above z = 0. */
const pocketDepth = (prng: Prng, height: number, maxSteps = 99): number =>
  prng.grid(1, Math.max(1, Math.min(maxSteps, height / FUZZ_GRID_MM - 2)));

function cutStep(prng: Prng, layout: Layout): FuzzStep {
  const { height, top, outer } = layout;
  const depth = pocketDepth(prng, height);
  const floor = height - depth;
  layout.floor = Math.min(layout.floor, floor);
  const shape = prng.pick(['block', 'round', 'slot'] as const);
  if (shape === 'slot') {
    const width = span(prng, 1, 2);
    const y = coordinate(prng, top.hy);
    const size: [number, number, number] = [2 * outer.hx + 10, width, depth + FUZZ_GRID_MM];
    return {
      kind: 'cut',
      effect: 'remove',
      label: `cut slot w${fmt(width)} depth ${fmt(depth)} at y=${fmt(y)}`,
      actions: [boxTool(size, [0, y, floor]), combine('subtract', '$tool')],
    };
  }
  const [x, y] = [coordinate(prng, top.hx), coordinate(prng, top.hy)];
  if (shape === 'round') {
    const radius = prng.grid(1, 4);
    const tall = 5 * Math.ceil((depth + FUZZ_GRID_MM) / 5);
    return {
      kind: 'cut',
      effect: 'remove',
      label: `cut round pocket R${fmt(radius)} depth ${fmt(depth)} at (${fmt(x)}, ${fmt(y)})`,
      actions: [cylinderTool(radius, tall, [x, y, floor]), combine('subtract', '$tool')],
    };
  }
  const size: [number, number, number] = [span(prng, 1, 4), span(prng, 1, 4), depth + FUZZ_GRID_MM];
  return {
    kind: 'cut',
    effect: 'remove',
    label: `cut pocket ${fmt(size[0])}x${fmt(size[1])} depth ${fmt(depth)} at (${fmt(x)}, ${fmt(y)})`,
    actions: [boxTool(size, [x, y, floor]), combine('subtract', '$tool')],
  };
}

function holeStep(prng: Prng, layout: Layout): FuzzStep | null {
  const diameter = prng.pick(HOLE_DIAMETERS);
  const r = diameter / 2;
  const wanted = prng.int(1, 3);
  const placed: Hole[] = [];
  for (let attempt = 0; attempt < 30 && placed.length < wanted; attempt++) {
    const candidate = { x: coordinate(prng, layout.bottom.hx - r), y: coordinate(prng, layout.bottom.hy - r), r };
    const clear = [...layout.holes, ...placed].every((h) => Math.hypot(h.x - candidate.x, h.y - candidate.y) >= h.r + r + FUZZ_GRID_MM);
    if (clear) placed.push(candidate);
  }
  const first = placed[0];
  if (first === undefined) return null;
  layout.holes.push(...placed);
  // A blind hole (118° drill point, tip ~0.6 d) must stop inside the stock: below every pocket floor, and never into a shell cavity.
  const deepest = floorToGrid(layout.floor - FUZZ_GRID_MM - 0.6 * diameter) / FUZZ_GRID_MM;
  const blind = prng.next() < 0.5 && !layout.shelled && deepest >= 1;
  const extent = blind ? { kind: 'blind', depth: prng.grid(1, deepest) } : { kind: 'through_all' };
  return {
    kind: 'hole',
    effect: 'remove',
    label: `${placed.length} hole(s) D${fmt(diameter)} ${blind ? `blind ${fmt(extent.depth ?? 0)}` : 'through'} from the bottom`,
    actions: [
      {
        command: 'add_hole',
        params: {
          target: BODY,
          face: { near: [first.x, first.y, 0] },
          points: placed.map((h) => [h.x, h.y]),
          pointsFrame: 'world_xy',
          hole: { kind: 'simple', diameter },
          extent,
        },
        as: 'body',
      },
    ],
  };
}

function patternStep(prng: Prng, layout: Layout): FuzzStep {
  const { height, top } = layout;
  const boss = prng.next() < 0.5;
  const radius = FUZZ_GRID_MM;
  const depth = pocketDepth(prng, height, 2);
  const at = (x: number, y: number): [number, number, number] =>
    boss ? [x, y, height - prng.pick([0, 2.5] as const)] : [x, y, height - depth];
  const op = boss ? 'union' : 'subtract';
  if (!boss) layout.floor = Math.min(layout.floor, height - depth);
  const polar = prng.next() < 0.5;
  let tool: FuzzAction;
  let array: FuzzAction;
  let count: number;
  let label: string;
  if (polar) {
    count = prng.int(3, 6);
    const rho = prng.grid(2, Math.max(2, Math.floor(Math.min(top.hx, top.hy) / FUZZ_GRID_MM)));
    tool = cylinderTool(radius, boss ? 5 : 10, at(rho, 0));
    array = { command: 'array_polar', params: { id: '$tool', count, center: [0, 0, 0] }, as: 'copies' };
    label = `polar pattern of ${count} ${boss ? 'bosses' : 'pockets'} on radius ${fmt(rho)}`;
  } else {
    count = prng.int(2, 4);
    const pitch = prng.grid(2, 4);
    const alongX = prng.next() < 0.5;
    const start = floorToGrid(-((count - 1) * pitch) / 2);
    const offset = alongX ? [pitch, 0, 0] : [0, pitch, 0];
    tool = cylinderTool(radius, boss ? 5 : 10, alongX ? at(start, coordinate(prng, top.hy)) : at(coordinate(prng, top.hx), start));
    array = { command: 'array_linear', params: { id: '$tool', count, offset }, as: 'copies' };
    label = `linear pattern of ${count} ${boss ? 'bosses' : 'pockets'} pitch ${fmt(pitch)} along ${alongX ? 'x' : 'y'}`;
  }
  const merges = Array.from({ length: count - 1 }, (_, k) => combine(op, `$copies[${k}]`));
  return { kind: 'pattern', effect: boss ? 'add' : 'remove', label, actions: [tool, array, combine(op, '$tool'), ...merges] };
}

function featureStep(kind: FuzzFeatureKind, prng: Prng, layout: Layout): FuzzStep | null {
  switch (kind) {
    case 'join':
      return joinStep(prng, layout);
    case 'cut':
      return cutStep(prng, layout);
    case 'hole':
      return holeStep(prng, layout);
    case 'pattern':
      return patternStep(prng, layout);
    case 'fillet': {
      const radius = prng.pick(BLEND_SIZES);
      return {
        kind,
        effect: 'any',
        label: `fillet all edges R${fmt(radius)}`,
        actions: [{ command: 'fillet_edge', params: { id: BODY, radius }, as: 'body' }],
      };
    }
    case 'chamfer': {
      const distance = prng.pick(BLEND_SIZES);
      return {
        kind,
        effect: 'any',
        label: `chamfer all edges ${fmt(distance)}`,
        actions: [{ command: 'chamfer_edge', params: { id: BODY, distance }, as: 'body' }],
      };
    }
    case 'shell': {
      if (layout.shelled) return null;
      layout.shelled = true;
      const thickness = prng.pick(SHELL_THICKNESSES);
      return {
        kind,
        effect: 'remove',
        label: `shell (sealed cavity) t${fmt(thickness)}`,
        actions: [{ command: 'shell_solid', params: { id: BODY, thickness }, as: 'body' }],
      };
    }
  }
}

/** The design of `seed`: a base step then 1..maxFeatures feature steps drawn from `options.kinds`. */
export function generateFuzzCase(seed: number, options: FuzzOptions = {}): FuzzCase {
  const prng = createPrng(seed);
  const kinds = options.kinds ?? FUZZ_FEATURE_KINDS;
  const { step, layout } = baseStep(prng);
  const steps: FuzzStep[] = [step];
  const [firstKind, ...otherKinds] = kinds;
  if (firstKind === undefined) return { seed, steps };
  const wanted = prng.int(1, Math.max(1, options.maxFeatures ?? MAX_FUZZ_FEATURES));
  for (let attempt = 0; steps.length - 1 < wanted && attempt < wanted * 4; attempt++) {
    const next = featureStep(prng.pick([firstKind, ...otherKinds]), prng, layout);
    if (next !== null) steps.push(next);
  }
  return { seed, steps };
}

/** One `build_project` plan of the steps, in order (aliases rebind, so `$body` always names the latest solid). */
export function fuzzPlan(steps: readonly FuzzStep[]): { actions: FuzzAction[] } {
  return { actions: steps.flatMap((step) => step.actions) };
}
