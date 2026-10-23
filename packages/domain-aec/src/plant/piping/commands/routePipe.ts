import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeLine, PipeRun, PortRef } from '@aec/plant/types';
import { nextId } from '@lib/id';
import { withRunEntities } from '../derive';
import { buildPath, COMPASS_NAMES, type PathEnd } from '../legs';
import { getPiping, refuse, withPiping } from '../model';
import { portOccupant, resolvePortId } from '../ports';
import { deriveRun } from '../routeParts';
import { createSpecLookup, isMiss } from '../specLookup';
import { takeoffOf } from '../takeoff';

const portOrPoint = z.union([
  z.object({ portId: z.string().min(1).describe('Port id: a tie-in id, "<tag>:<mark>" of an equipment nozzle, or "<runId>:start|end".') }),
  z.object({
    point: vec3('Open end [x, y, z], document units (mm).'),
    direction: vec3('Direction the pipe leaves (start) or arrives along reversed (end) [dx, dy, dz]; optional.').optional(),
  }),
]);

type Endpoint = z.infer<typeof portOrPoint>;

interface ResolvedEndpoint {
  readonly end: PathEnd;
  readonly ref?: PortRef;
}

function resolveEndpoint(doc: CadDocument, line: PipeLine, endpoint: Endpoint, side: 'from' | 'to'): ResolvedEndpoint | CommandResult {
  if (!('portId' in endpoint)) {
    return { end: { point: endpoint.point, ...(endpoint.direction === undefined ? {} : { direction: endpoint.direction }) } };
  }
  const resolved = resolvePortId(doc, endpoint.portId);
  if (!resolved.ok) return refuse(doc, 'route_pipe', 'RTE_UNKNOWN_PORT', resolved.message, [], [`${side}.portId`]);
  const { port } = resolved;
  const occupant = portOccupant(doc, port.ref);
  if (occupant !== undefined)
    return refuse(
      doc,
      'route_pipe',
      'RTE_PORT_IN_USE',
      `port ${port.id} is already connected (${occupant})`,
      [port.id, occupant],
      [`${side}.portId`],
    );
  if (port.spec.dn !== line.dn)
    return refuse(
      doc,
      'route_pipe',
      'RTE_SIZE_MISMATCH',
      `port ${port.id} is DN${port.spec.dn}, line ${line.id} is DN${line.dn}`,
      [port.id, line.id],
      [`${side}.portId`],
    );
  return { end: { point: port.spec.position, direction: port.spec.direction }, ref: port.ref };
}

const isResolved = (value: ResolvedEndpoint | CommandResult): value is ResolvedEndpoint => 'end' in value;

/**
 * @affects creates 1 pipe run (plant.piping) and its derived, read-only part entities `<runId>/<kind>-<k>` (pipe pieces, elbows, flanges, gaskets)
 * @invariant stored = the points of intersection only; parts, cut lengths and joints are derived from the line's spec; a straight closing leg
 *   is appended when the target port is on its axis; consecutive collinear legs merge; weld gap default 0 (named in data.weldGap)
 * @failure unknown line / port, port in use, size / rating / facing / end-type mismatch, port direction, closing leg, zero leg, angle with no
 *   spec elbow, leg too short, missing spec component -> RTE_* refusal, document unchanged
 */
export const routePipe = defineCommand({
  name: 'route_pipe',
  description:
    'Route a pipe line by compass legs from a start port, spec-driven: every turn gets the elbow of the line spec (angle within the spec ' +
    'tolerance, catalogue centre-to-end, never a formula), a flanged (FL) port gets a weld-neck flange + gasket + bolt set, and every straight ' +
    'piece gets its cut length (leg length minus the centre-to-ends, flange sets and weld gaps at its ends). Lengths in document units (mm; the ' +
    'document must be in mm). from/to: { portId } (tie-in id from add_tie_in_point, "<tag>:<mark>" of an equipment nozzle such as "V-101:N1" ' +
    'from add_nozzle / equipment_ports, or "<runId>:start|end" to continue a run) or an open { point, direction? }. legs: [{ direction ' +
    '"+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z" or [dx,dy,dz], length }] from the start; the first leg must leave along the start port direction (within ' +
    'the tolerance). via: extra points of intersection after the legs. When `to` is a port, a straight closing leg to it is added if the last point ' +
    'is on its axis (the last leg may omit length to run straight to it). Returns the run id (affected[0]); data = { runId, legs, closingLeg, ' +
    'pis, legs (cutLengthsMm), turns (angle, nominal, deviationDeg, centreToEnd), counts, pipePieces (cutLengthMm per piece), totalPipeMm, ' +
    'centrelineLengthMm, warnings (RTE_WELD_SPACING, RTE_FITTING_TO_FITTING), partIds, angleTolerance, weldGap, unverified }; parts and joints are ' +
    'listed by piping_takeoff. A spec that is not ' +
    'approved or has non-grade-A rows reports unverified. Refusals: RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_LINE, RTE_UNKNOWN_PORT, RTE_PORT_IN_USE, ' +
    'RTE_SIZE_MISMATCH, RTE_RATING_MISMATCH, RTE_FACING_MISMATCH, RTE_NO_CONNECTION_RULE, RTE_PORT_DIRECTION, RTE_CLOSING_LEG_IMPOSSIBLE ' +
    '(detail.offset), RTE_ZERO_LEG, RTE_NO_FITTING_FOR_ANGLE (detail.anglesDeg), RTE_SEGMENT_TOO_SHORT (detail.cutLengthMm), ' +
    'RTE_SPEC_UNKNOWN, RTE_SPEC_NO_COMPONENT, RTE_SPEC_AMBIGUOUS. Next: piping_takeoff for the cut list; delete_pipe_run to redo.',
  params: z.object({
    lineId: z.string().describe('Pipe line id (affected[0] of create_pipeline).'),
    from: portOrPoint.describe('Start: { portId } or an open { point, direction? }.'),
    to: portOrPoint.optional().describe('End: { portId } (a closing leg is added) or an open { point }. Omit to end at the last leg.'),
    legs: z
      .array(
        z.object({
          direction: z
            .union([z.enum(COMPASS_NAMES), vec3('Direction vector [dx, dy, dz]; normalised.')])
            .describe('"+X", "-X", "+Y", "-Y", "+Z", "-Z" or a vector.'),
          length: z
            .number()
            .optional()
            .describe('Length along the direction, document units, > 0. May be omitted on the last leg when `to` is a port.'),
        }),
      )
      .optional()
      .describe('Legs from the start point, in order.'),
    via: z.array(vec3('Point of intersection [x, y, z].')).optional().describe('Points of intersection added after the legs.'),
    angleToleranceDeg: z
      .number()
      .positive()
      .optional()
      .describe('Overrides the spec tolerance for port directions and elbow angles, degrees (named in the result).'),
  }),
  run: (doc, params): CommandResult => {
    if (doc.units !== 'mm')
      return refuse(
        doc,
        'route_pipe',
        'RTE_UNITS_UNSUPPORTED',
        `plant lengths and catalogue dimensions are mm; this document is in ${doc.units}`,
      );
    const piping = getPiping(doc);
    const line = piping.lines[params.lineId];
    if (line === undefined) return refuse(doc, 'route_pipe', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    const lookup = createSpecLookup(doc, line.spec);
    if (isMiss(lookup)) return refuse(doc, 'route_pipe', lookup.miss, lookup.detail, [line.id, ...lookup.ids], ['lineId']);
    const from = resolveEndpoint(doc, line, params.from, 'from');
    if (!isResolved(from)) return from;
    const to = params.to === undefined ? undefined : resolveEndpoint(doc, line, params.to, 'to');
    if (to !== undefined && !isResolved(to)) return to;
    const tolerance = params.angleToleranceDeg ?? lookup.elbowAngles().toleranceDeg;
    const path = buildPath(from.end, to?.end, params.legs ?? [], (params.via ?? []) as Vec3[], tolerance);
    if (!path.ok) return refuse(doc, 'route_pipe', path.code, path.message, [line.id], path.paths, path.detail);
    const id = nextId('run');
    const run: PipeRun = {
      id,
      lineId: line.id,
      start: {
        point: path.points[0] as Vec3,
        ...(from.end.direction === undefined ? {} : { direction: from.end.direction }),
        ...(from.ref === undefined ? {} : { ref: from.ref }),
      },
      end: {
        point: path.points.at(-1) as Vec3,
        ...(to?.end.direction === undefined ? {} : { direction: to.end.direction }),
        ...(to?.ref === undefined ? {} : { ref: to.ref }),
      },
      pis: path.points.slice(1, -1),
      ...(params.angleToleranceDeg === undefined ? {} : { angleToleranceDeg: params.angleToleranceDeg }),
    };
    const stored = withPiping(doc, { ...piping, runs: { ...piping.runs, [id]: run }, runOrder: [...piping.runOrder, id] });
    const derived = deriveRun(stored, run);
    if (!derived.ok) return refuse(doc, 'route_pipe', derived.code, derived.message, [...derived.ids], [...derived.paths], derived.detail);
    const takeoff = takeoffOf([{ runId: id, derivation: derived }]);
    const worst = derived.turns.reduce((max, turn) => Math.max(max, turn.deviationDeg), 0);
    return {
      ...changed(
        withRunEntities(stored, id),
        `route_pipe: run ${id} on line ${line.lineNumber}: ${path.legs.length} leg(s)${path.closingLeg === null ? '' : ` (closing leg ${String(path.closingLeg.direction)} ${+path.closingLeg.length.toFixed(3)} mm)`}, ` +
          `${derived.turns.length} elbow(s) (max deviation ${+worst.toFixed(4)} deg, tolerance ${derived.angleTolerance.valueDeg} deg ${derived.angleTolerance.source}), ` +
          `${takeoff.pipePieces.length} pipe piece(s) totalling ${takeoff.totalPipeMm} mm, centreline ${takeoff.centrelineLengthMm} mm, ` +
          `${derived.warnings.length} warning(s)${derived.unverified ? `; unverified: ${derived.unverifiedReasons.join('; ')}` : ''}.`,
        [id],
      ),
      data: {
        runId: id,
        lineId: line.id,
        lineNumber: line.lineNumber,
        pis: run.pis,
        closingLeg: path.closingLeg,
        mergedPoints: path.merged,
        portDeviationDeg: { start: path.startDeviationDeg, end: path.endDeviationDeg },
        // Compact on purpose (a mutating step's data over 4000 characters is dropped from build_project reports): parts and joints are in piping_takeoff.
        legs: takeoff.legs.map((leg) => ({
          index: leg.index,
          direction: leg.direction,
          lengthMm: leg.lengthMm,
          cutLengthsMm: leg.cutLengthsMm,
        })),
        turns: takeoff.turns.map((turn) => ({
          index: turn.index,
          turnDeg: turn.turnDeg,
          nominalDeg: turn.nominalDeg,
          deviationDeg: turn.deviationDeg,
          centreToEnd: turn.centreToEnd,
        })),
        counts: takeoff.counts,
        pipePieces: takeoff.pipePieces.map((piece) => ({ id: piece.id, leg: piece.leg, cutLengthMm: piece.cutLengthMm })),
        totalPipeMm: takeoff.totalPipeMm,
        centrelineLengthMm: takeoff.centrelineLengthMm,
        studs: takeoff.studs,
        warnings: takeoff.warnings,
        unverified: takeoff.unverified,
        unverifiedReasons: takeoff.unverifiedReasons,
        partIds: derived.parts.map((part) => part.id),
        spec: derived.spec,
        angleTolerance: derived.angleTolerance,
        weldGap: derived.weldGap,
        weldSpacing: derived.weldSpacing,
        pipe: derived.pipe,
      },
    };
  },
});
