/**
 * Boolean volume identities on a random overlapping primitive pair (SC-Q3): V(A∪B) + V(A∩B) = V(A) + V(B) and V(A−B) = V(A) − V(A∩B),
 * within 0.2 %. Every volume is the kernel's (check_assembly part volume), so a faceting kernel is held to its own facets.
 */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { outcomeIsFailure, runCommandOutcome } from '../commandOutcome';
import { measureBodies } from './measure';
import { createPrng, floorToGrid, type Prng } from './prng';
import type { FuzzAction, FuzzFailure } from './types';

const IDENTITY_REL_TOLERANCE = 0.002;
/** Seed salt so a seed's pair does not reuse its design's random stream. */
const PAIR_SALT = 0x5bd1e995;

export interface BooleanPair {
  readonly seed: number;
  readonly label: string;
  /** set_units, then A bound as `a` and B as `b`. */
  readonly actions: readonly FuzzAction[];
}

export interface IdentityReport {
  readonly seed: number;
  readonly label: string;
  readonly ok: boolean;
  readonly volumes?: {
    readonly a: number;
    readonly b: number;
    readonly union: number;
    readonly intersect: number;
    readonly subtract: number;
  };
  readonly failure?: FuzzFailure;
}

interface Primitive {
  readonly action: FuzzAction;
  readonly half: readonly [number, number, number];
  readonly label: string;
}

function primitive(prng: Prng, alias: string, center: readonly [number, number, number]): Primitive {
  const kind = prng.pick(['box', 'cylinder', 'sphere'] as const);
  const position = [...center];
  if (kind === 'box') {
    const size: [number, number, number] = [prng.grid(2, 12), prng.grid(2, 12), prng.grid(2, 12)];
    return {
      action: { command: 'add_box', params: { size, position }, as: alias },
      half: [size[0] / 2, size[1] / 2, size[2] / 2],
      label: `box ${size.join('x')} at (${position.join(', ')})`,
    };
  }
  const radius = prng.grid(1, 6);
  if (kind === 'sphere')
    return {
      action: { command: 'add_sphere', params: { radius, position }, as: alias },
      half: [radius, radius, radius],
      label: `sphere R${radius} at (${position.join(', ')})`,
    };
  const height = 5 * prng.int(1, 6);
  return {
    action: { command: 'add_cylinder', params: { radius, height, position }, as: alias },
    half: [radius, radius, height / 2],
    label: `cylinder R${radius} H${height} at (${position.join(', ')})`,
  };
}

/** The pair of `seed`: A at the origin, B centred at a grid point inside A's bounding box (so they overlap). */
export function generateBooleanPair(seed: number): BooleanPair {
  const prng = createPrng((seed ^ PAIR_SALT) >>> 0);
  const a = primitive(prng, 'a', [0, 0, 0]);
  const inside = (half: number): number => {
    const steps = Math.floor(floorToGrid(half * 0.8) / 2.5);
    return prng.int(-steps, steps) * 2.5;
  };
  const b = primitive(prng, 'b', [inside(a.half[0]), inside(a.half[1]), inside(a.half[2])]);
  return {
    seed,
    label: `A = ${a.label}; B = ${b.label}`,
    actions: [{ command: 'set_units', params: { units: 'mm' } }, a.action, b.action],
  };
}

const fail = (pair: BooleanPair, check: FuzzFailure['check'], message: string): IdentityReport => ({
  seed: pair.seed,
  label: pair.label,
  ok: false,
  failure: { step: -1, kind: 'identity', check, message },
});

/** Volume of `op` on the pair document: 0 for an empty result (the kernel refuses an empty solid), undefined when it failed otherwise. */
function combined(doc: CadDocument, ids: readonly [string, string], op: 'union' | 'intersect' | 'subtract'): number | string {
  const { document, outcome } = runCommandOutcome(doc, 'boolean', { op, a: ids[0], b: ids[1] });
  if (outcomeIsFailure('boolean', outcome)) return /empty/i.test(outcome.summary) ? 0 : `boolean ${op} failed: ${outcome.summary}`;
  const bodies = measureBodies(document);
  const invalid = bodies.find((body) => body.invalid !== undefined);
  if (invalid !== undefined) return `boolean ${op} result ${invalid.id} is not a solid: ${invalid.invalid ?? ''}`;
  return bodies.reduce((sum, body) => sum + body.volume, 0);
}

/** Build the pair, then check both identities. */
export function runBooleanIdentity(pair: BooleanPair): IdentityReport {
  const built = runCommandOutcome(createEmptyDocument(), 'build_project', { actions: pair.actions });
  if (outcomeIsFailure('build_project', built.outcome)) return fail(pair, 'command_failed', built.outcome.summary);
  const measured = measureBodies(built.document);
  const [ma, mb] = measured;
  if (ma === undefined || mb === undefined) return fail(pair, 'not_solid', `expected 2 solids, found ${measured.length}`);
  const results = (['union', 'intersect', 'subtract'] as const).map((op) => combined(built.document, [ma.id, mb.id], op));
  const failed = results.find((value): value is string => typeof value === 'string');
  if (failed !== undefined) return fail(pair, 'command_failed', failed);
  const [union, intersect, subtract] = results as [number, number, number];
  const volumes = { a: ma.volume, b: mb.volume, union, intersect, subtract };
  const unionError = Math.abs(union + intersect - (ma.volume + mb.volume));
  if (unionError > IDENTITY_REL_TOLERANCE * (ma.volume + mb.volume))
    return { ...fail(pair, 'identity_union', `V(A∪B)+V(A∩B) = ${union + intersect} but V(A)+V(B) = ${ma.volume + mb.volume}`), volumes };
  const subtractError = Math.abs(subtract - (ma.volume - intersect));
  if (subtractError > IDENTITY_REL_TOLERANCE * ma.volume)
    return { ...fail(pair, 'identity_subtract', `V(A−B) = ${subtract} but V(A)−V(A∩B) = ${ma.volume - intersect}`), volumes };
  return { seed: pair.seed, label: pair.label, ok: true, volumes };
}
