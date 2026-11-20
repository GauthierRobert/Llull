/** insert_fastener_row (08 MAT FR-MAT-18, M7): a straight row of stacks with pitch and edge-distance rules. */

import { round6 } from '@lib/compactNumber';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { add3, len3, scale3, sub3 } from '@lib/vec3';
import { nextId } from '@lib/id';
import { refuse, remediationFor } from './codes';
import { holeFields } from './insertCommands';
import { type HoleMode, holeDiameterDoc, placeStack } from './placeStack';
import { type SelectionParams, quantity, sharedFields } from './selectionParams';
import { type SelectionOutcome, runSelection } from './selection';
import { docToInches, quantityToDoc, toTicks } from './units';
import { appendAll } from '@lib/appendAll';

const MAX_ROW = 500;

const rowSchema = z.object({
  ...sharedFields,
  stackIds: z
    .array(z.string())
    .describe('Ids of the 3D solids (plates) every fastener of the row passes through; measured at each position along axis.'),
  from: vec3('Axis point [x, y, z] (document units) of the first fastener.'),
  to: vec3('Axis point [x, y, z] (document units) the row runs towards; the last fastener is exactly here.'),
  pitch: quantity(
    'Requested spacing between fastener axes as { value, unit }; the row is divided into round(length / pitch) equal intervals so the last fastener lands on `to` (actual pitch in data.pitchIn). Give this OR count',
  ).optional(),
  count: z.number().int().describe('Number of fasteners, spread evenly from `from` to `to` (1..500). Give this OR pitch.').optional(),
  edgeDistance: quantity(
    'Distance from the fastener axes to the nearest plate edge, as { value, unit }, known to the caller (it is checked against the minimum, not measured)',
  ).optional(),
  minPitch: quantity('Minimum pitch for non-rivet families as { value, unit }. Rivets default to 3 D (AC 43.13-1B 4-57(c)).').optional(),
  minEdgeDistance: quantity(
    'Minimum edge distance for non-rivet families as { value, unit }. Rivets default to 2 D (AC 43.13-1B 4-57(c)).',
  ).optional(),
  allowViolations: z
    .boolean()
    .describe('Place the row although pitch or edge distance is below the minimum, reporting warnings. Default false: refuse.')
    .optional(),
  ...holeFields,
});

interface Violation {
  readonly code: 'FAST_PITCH' | 'FAST_EDGE_DISTANCE';
  readonly message: string;
  readonly valueIn: number;
  readonly minIn: number;
}

const inches = (q: { value: number; unit: string }): number => (toTicks(q.value, q.unit, 'in') ?? 0) / 1e6;

type RowParams = z.infer<typeof rowSchema>;
type Selector = (current: CadDocument, point: Vec3, stackIds: readonly string[]) => SelectionOutcome;

/** Row geometry: fastener count, spacing and positions, or the refusal of an invalid line / pitch / count. */
function layoutOf(
  doc: CadDocument,
  params: RowParams,
): { readonly failure: CommandResult } | { readonly count: number; readonly stepDoc: number; readonly points: Vec3[] } {
  const line = sub3(params.to, params.from);
  const length = len3(line);
  if (
    length === 0 ||
    (params.pitch === undefined) === (params.count === undefined) ||
    (params.count !== undefined && (params.count < 1 || params.count > MAX_ROW))
  )
    return {
      failure: refuse(
        doc,
        'insert_fastener_row',
        'FAST_ROW_INVALID',
        'from and to must differ and exactly one of pitch / count (1..500) is required',
        [],
        ['from', 'to', 'pitch', 'count'],
      ),
    };
  const pitchDoc = params.pitch === undefined ? null : quantityToDoc(doc, params.pitch.value, params.pitch.unit);
  if (params.pitch !== undefined && (pitchDoc === null || !(pitchDoc > 0)))
    return { failure: refuse(doc, 'insert_fastener_row', 'FAST_ROW_INVALID', 'pitch must be a positive length', [], ['pitch']) };
  const count = params.count ?? Math.max(1, Math.round(length / (pitchDoc ?? length))) + 1;
  if (count > MAX_ROW)
    return {
      failure: refuse(
        doc,
        'insert_fastener_row',
        'FAST_ROW_INVALID',
        `row would place ${count} fasteners (limit ${MAX_ROW})`,
        [],
        ['pitch', 'count'],
      ),
    };
  const stepDoc = count === 1 ? 0 : length / (count - 1);
  const direction = scale3(line, 1 / length);
  const points: Vec3[] = Array.from({ length: count }, (_, k) => add3(params.from, scale3(direction, k * stepDoc)));
  return { count, stepDoc, points };
}

/** The selection of one stack position with the row's shared selection params. */
function selectorFor(params: RowParams): Selector {
  const shared = Object.fromEntries(
    Object.keys(sharedFields).flatMap((key) =>
      key in params && (params as Record<string, unknown>)[key] !== undefined ? [[key, (params as Record<string, unknown>)[key]]] : [],
    ),
  );
  return (current, point, stackIds) => runSelection(current, { ...shared, stackIds: [...stackIds], axisPoint: point } as SelectionParams);
}

/** Pitch and edge-distance checks against the minima (rivet rows: the selection's 3 D / 2 D). */
function rowViolations(
  doc: CadDocument,
  params: RowParams,
  isRivet: boolean,
  selectionData: Record<string, unknown>,
  count: number,
  stepDoc: number,
): { violations: Violation[]; minPitchIn: number | null; minEdgeIn: number | null; pitchIn: number | null } {
  const minPitchIn = isRivet ? (selectionData['minPitchIn'] as number) : params.minPitch === undefined ? null : inches(params.minPitch);
  const minEdgeIn = isRivet
    ? (selectionData['minEdgeDistanceIn'] as number)
    : params.minEdgeDistance === undefined
      ? null
      : inches(params.minEdgeDistance);
  const violations: Violation[] = [];
  const pitchIn = count > 1 ? round6(docToInches(doc, stepDoc)) : null;
  if (pitchIn !== null && minPitchIn !== null && pitchIn < minPitchIn - 1e-9)
    violations.push({
      code: 'FAST_PITCH',
      message: `pitch ${pitchIn} in is below the minimum ${minPitchIn} in${isRivet ? ' (3 D)' : ''}`,
      valueIn: pitchIn,
      minIn: minPitchIn,
    });
  const edgeIn = params.edgeDistance === undefined ? null : inches(params.edgeDistance);
  if (edgeIn !== null && minEdgeIn !== null && edgeIn < minEdgeIn - 1e-9)
    violations.push({
      code: 'FAST_EDGE_DISTANCE',
      message: `edge distance ${edgeIn} in is below the minimum ${minEdgeIn} in${isRivet ? ' (2 D)' : ''}`,
      valueIn: edgeIn,
      minIn: minEdgeIn,
    });
  return { violations, minPitchIn, minEdgeIn, pitchIn };
}

interface RowPlacement {
  readonly params: RowParams;
  readonly points: readonly Vec3[];
  readonly select: Selector;
  readonly mode: HoleMode;
  readonly diameter: number;
  readonly rowId: string;
}

/** Places one stack per point (later positions follow plates replaced by earlier cuts); all or nothing. */
function placeRow(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  { params, points, select, mode, diameter, rowId }: RowPlacement,
):
  | { readonly failure: CommandResult }
  | { readonly current: CadDocument; readonly affected: string[]; readonly stackIds: string[]; readonly representative: Set<string> } {
  let current = doc;
  let plateIds: string[] = [...params.stackIds];
  const affected: string[] = [];
  const stackIds: string[] = [];
  const representative = new Set<string>();
  for (const point of points) {
    const outcome = select(current, point, plateIds);
    if (!outcome.ok || outcome.resolved === null)
      return {
        failure: {
          ...refuse(
            doc,
            'insert_fastener_row',
            outcome.failure?.code ?? 'FAST_STACK_OUT_OF_RANGE',
            `position ${stackIds.length + 1}: ${outcome.failure?.message ?? 'selection failed'}`,
            outcome.failure?.ids ?? [],
          ),
          data: outcome.data,
        },
      };
    const placed = placeStack(current, ctx, outcome.resolved, mode, diameter, rowId);
    if (!placed.ok)
      return { failure: refuse(doc, 'insert_fastener_row', placed.code, `position ${stackIds.length + 1}: ${placed.message}`, placed.ids) };
    current = placed.document;
    plateIds = plateIds.map((id) => placed.replaced[id] ?? id);
    appendAll(affected, placed.affected);
    stackIds.push(placed.stack.id);
    placed.representative.forEach((partNumber) => representative.add(partNumber));
  }
  return { current, affected, stackIds, representative };
}

/**
 * @affects plates (cut), components, instances and fasteners.stacks for every position; one feature step
 * @invariant stacks of one row share rowId; plate ids replaced by an earlier cut are followed by the later positions
 * @failure pitch/edge below the minimum without allowViolations -> FAST_PITCH / FAST_EDGE_DISTANCE; any position fails -> nothing is placed
 */
export const insertFastenerRow = defineCommand({
  name: 'insert_fastener_row',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Insert a straight row of identical fastener stacks (insert_fastener_stack at each position) along from -> to with either pitch {value, unit} or count. ' +
    'Rivet rows are checked against the minimum pitch 3 D and edge distance 2 D (AC 43.13-1B 4-57(c)); other families use minPitch / minEdgeDistance when given. ' +
    'edgeDistance is the distance from the row to the plate edge as the caller knows it. A violation refuses the row (FAST_PITCH / FAST_EDGE_DISTANCE, listed in ' +
    'data.violations) unless allowViolations is true, which places it with warnings. Selection params as in select_fastener; needs stackIds. With pitch, the pitch is adjusted (count = round(length/pitch)+1) so the last fastener lands on `to`. Returns data.rowId, data.stackIds, data.count, data.pitchIn (actual) and data.requestedPitchIn.',
  params: rowSchema,
  run: (doc, params, ctx): CommandResult => {
    const layout = layoutOf(doc, params);
    if ('failure' in layout) return layout.failure;
    const { count, stepDoc, points } = layout;
    const select = selectorFor(params);
    const first = select(doc, points[0] as Vec3, params.stackIds);
    if (!first.ok || first.resolved === null)
      return {
        ...refuse(
          doc,
          'insert_fastener_row',
          first.failure?.code ?? 'FAST_STACK_OUT_OF_RANGE',
          first.failure?.message ?? 'selection failed',
          first.failure?.ids ?? [],
        ),
        data: first.data,
      };

    const { violations, minPitchIn, minEdgeIn, pitchIn } = rowViolations(
      doc,
      params,
      first.resolved.mode === 'rivet',
      first.data,
      count,
      stepDoc,
    );
    if (violations.length > 0 && params.allowViolations !== true) {
      const code = (violations[0] as Violation).code;
      return {
        ...refuse(
          doc,
          'insert_fastener_row',
          code,
          violations.map((violation) => violation.message).join('; '),
          [],
          violations.map((v) => (v.code === 'FAST_PITCH' ? 'pitch' : 'edgeDistance')),
        ),
        data: {
          violations: violations.map((violation) => ({ ...violation, remediation: remediationFor(violation.code) })),
          minPitchIn,
          minEdgeDistanceIn: minEdgeIn,
        },
      };
    }

    const requestedIn = params.pitch === undefined ? null : inches(params.pitch);
    const mode: HoleMode = params.holeMode ?? 'cut_close_tolerance';
    const diameter = holeDiameterDoc(doc, first.resolved, mode, params.holeDiameter);
    if (typeof diameter !== 'number')
      return { ...refuse(doc, 'insert_fastener_row', diameter.code, diameter.message, diameter.ids), data: first.data };
    const rowId = nextId('frow');
    const placement = placeRow(doc, ctx, { params, points, select, mode, diameter, rowId });
    if ('failure' in placement) return placement.failure;
    const { current, affected, stackIds, representative } = placement;
    const warnings = [
      ...violations.map((violation) => ({ code: violation.code, message: violation.message, remediation: remediationFor(violation.code) })),
      ...[...representative].map((partNumber) => ({
        code: 'FAST_GEOMETRY_REPRESENTATIVE',
        message: `${partNumber} uses placeholder proportions; excluded from mass`,
      })),
    ];
    return {
      ...changed(
        current,
        `Inserted fastener row ${rowId}: ${count} × ${first.resolved.partNumber} at ${pitchIn === null ? 'one position' : `${pitchIn} in pitch${params.pitch === undefined ? '' : ` (adjusted from requested ${requestedIn} in so the last lands on 'to')`}`}, stacks [${stackIds.join(', ')}]; ${affected.length} entities created/replaced.${warnings.length > 0 ? ` ${warnings.length} warning(s): ${warnings.map((w) => w.code).join(', ')}.` : ''}`,
        affected,
      ),
      data: { rowId, stackIds, count, pitchIn, requestedPitchIn: requestedIn, minPitchIn, minEdgeDistanceIn: minEdgeIn, warnings },
    };
  },
});
