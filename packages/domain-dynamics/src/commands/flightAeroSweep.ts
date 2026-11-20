/** generate_aero_table phases: sweep validation, servo limits and the vortex-lattice calls (13 FLT M4). */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { CommandLookup, ExecutionContext } from '@core/commands/types';
import type { ForwardAxis } from '../flight/aeroModel';
import type { LatticeRow } from '../flight/aeroTable';
import { flowSections, latticeRows, toFlow, type BodySection } from '../flight/aeroSweep';
import { dynamicsOf } from './bodies';
import { minOf } from '@lib/arrayExtrema';

interface SurfaceInput {
  readonly name: string;
  readonly sections: readonly BodySection[];
  readonly mirror?: boolean | undefined;
  readonly spanwisePanels?: number | undefined;
  readonly chordwisePanels?: number | undefined;
  readonly naca?: string | undefined;
  readonly zeroLiftAngleDeg?: number | undefined;
  readonly pivots?: boolean | undefined;
}

export interface ServoInput {
  readonly rateDegS: number;
  readonly minDeg?: number | undefined;
  readonly maxDeg?: number | undefined;
  readonly neutralDeg?: number | undefined;
}

export interface SweepInput {
  readonly body: string;
  readonly alphas: readonly number[];
  readonly pivots: readonly number[];
  readonly surfaces: readonly SurfaceInput[];
  readonly pivotPoint: Vec3 | undefined;
  readonly servo: ServoInput | undefined;
}

/** Why `bodyId` cannot carry a surface (missing or fixed), or null. */
function bodyProblem(doc: CadDocument, bodyId: string): string | null {
  const bodies = dynamicsOf(doc).bodies;
  const body = Object.hasOwn(bodies, bodyId) ? bodies[bodyId] : undefined;
  if (body === undefined) return `body '${bodyId}' is not a rigid body (add_rigid_body first)`;
  return body.fixed ? `body '${bodyId}' is fixed to the ground; an aero surface needs a moving body` : null;
}

const increasing = (values: readonly number[]): boolean => values.every((value, i) => i === 0 || value > (values[i - 1] ?? Infinity));

/** Servo travel limits: the stated ones, else the ends of the pivot sweep. */
export function servoLimits(
  servo: ServoInput | undefined,
  pivots: readonly number[],
): { low: number; high: number; minDeg: number; maxDeg: number; neutralDeg: number } {
  const low = pivots[0] ?? 0;
  const high = pivots[pivots.length - 1] ?? 0;
  const minDeg = servo?.minDeg ?? low;
  const maxDeg = servo?.maxDeg ?? high;
  const neutralDeg = Math.min(maxDeg, Math.max(minDeg, servo?.neutralDeg ?? 0));
  return { low, high, minDeg, maxDeg, neutralDeg };
}

/** First refusal message of the body, angle sweeps and servo limits, or null. */
export function sweepProblem(doc: CadDocument, input: SweepInput): string | null {
  const { alphas, pivots, servo } = input;
  const problem = bodyProblem(doc, input.body);
  if (problem !== null) return problem;
  if (!increasing(alphas) || alphas.some((alpha) => !(Math.abs(alpha) <= 20)))
    return 'alphasDeg must strictly increase and lie within -20..20 degrees';
  if (!increasing(pivots)) return 'pivotsDeg must strictly increase';
  const sweeping = pivots.length > 1;
  if (sweeping && !input.surfaces.some((surface) => surface.pivots === true))
    return 'a pivot sweep needs at least one surface with pivots: true';
  if (sweeping && (input.pivotPoint === undefined || servo === undefined)) return 'a pivot sweep needs pivotPoint and servo';
  if (!sweeping && servo !== undefined) return 'servo needs pivotsDeg with more than one angle';
  const { low, high, minDeg, maxDeg } = servoLimits(servo, pivots);
  if (servo !== undefined && !(low <= minDeg && minDeg <= maxDeg && maxDeg <= high))
    return `servo limits [${minDeg}, ${maxDeg}] must be ordered and lie inside the pivot sweep [${low}, ${high}]`;
  return null;
}

interface LatticeReference {
  readonly area: number;
  readonly chord: number;
  readonly span: number;
}

export interface LatticeSweep {
  readonly first: { readonly rows: LatticeRow[]; readonly data: Record<string, unknown> };
  readonly rowsByPivot: (readonly LatticeRow[])[];
  readonly reference: LatticeReference;
  readonly area: number;
  readonly chord: number;
  readonly zeroIndex: number;
}

interface LatticeCall {
  readonly forward: ForwardAxis;
  readonly referenceArea: number | undefined;
  readonly referenceChord: number | undefined;
  readonly momentCentre: Vec3;
}

/** One vortex-lattice call per pivot angle; the reference area and chord come from the call nearest zero pivot and are held for the others. */
export function latticeSweep(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  lattice: NonNullable<ReturnType<CommandLookup>>,
  input: SweepInput,
  options: LatticeCall,
): LatticeSweep | { readonly refused: string } {
  const { alphas, pivots } = input;
  const { forward } = options;
  const pivotPoint = toFlow(input.pivotPoint ?? [0, 0, 0], forward);
  const referencePoint = toFlow(options.momentCentre, forward);
  const callFor = (pivotDeg: number, area?: number, chord?: number): Record<string, unknown> => ({
    surfaces: input.surfaces.map((surface) => ({
      name: surface.name,
      sections: flowSections(surface.sections, forward, surface.pivots === true ? { point: pivotPoint, deg: pivotDeg } : null),
      ...(surface.mirror === undefined ? {} : { mirror: surface.mirror }),
      ...(surface.spanwisePanels === undefined ? {} : { spanwisePanels: surface.spanwisePanels }),
      ...(surface.chordwisePanels === undefined ? {} : { chordwisePanels: surface.chordwisePanels }),
      ...(surface.naca === undefined ? {} : { naca: surface.naca }),
      ...(surface.zeroLiftAngleDeg === undefined ? {} : { zeroLiftAngleDeg: surface.zeroLiftAngleDeg }),
    })),
    alphasDeg: alphas,
    referencePoint,
    ...(area === undefined ? {} : { referenceArea: area }),
    ...(chord === undefined ? {} : { referenceChord: chord }),
  });
  const smallestPivot = minOf(pivots.map(Math.abs));
  const zeroIndex = pivots.findIndex((pivot) => Math.abs(pivot) === smallestPivot);
  const call = (pivotDeg: number, area?: number, chord?: number): { rows: LatticeRow[]; data: Record<string, unknown> } | string => {
    const result = lattice.run(doc, callFor(pivotDeg, area, chord), ctx);
    const rows = latticeRows(result.data);
    return rows === null ? result.summary : { rows, data: result.data as Record<string, unknown> };
  };
  const first = call(pivots[zeroIndex] ?? 0, options.referenceArea, options.referenceChord);
  if (typeof first === 'string') return { refused: `the vortex-lattice query refused: ${first}` };
  const reference = first.data['reference'] as LatticeReference;
  const area = options.referenceArea ?? reference.area;
  const chord = options.referenceChord ?? reference.chord;
  const rowsByPivot: (readonly LatticeRow[])[] = [];
  for (let p = 0; p < pivots.length; p++) {
    const result = p === zeroIndex ? first : call(pivots[p] ?? 0, area, chord);
    if (typeof result === 'string') return { refused: `the vortex-lattice query refused at pivot ${pivots[p]}°: ${result}` };
    rowsByPivot.push(result.rows);
  }
  return { first, rowsByPivot, reference, area, chord, zeroIndex };
}
