import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec3 } from '@core/model/vectors';
import type { InlineComponent, PipeRun } from '@aec/plant/types';
import { nextId } from '@lib/id';
import { withRunEntities } from '../derive';
import { envelopeDiameter } from '../insulation';
import { buildPath, unitVector } from '../legs';
import { getPiping, refuse, withPiping } from '../model';
import { deriveRun } from '../routeParts';
import { byRoute } from '../runSizes';
import { createSpecLookup, isMiss } from '../specLookup';
import { takeoffOf } from '../takeoff';
import { buildInline, inlineAt, inlineFields, isResolved, legsInput, portOrPoint, resolveEndpoint, viaInput } from './routeInput';

/**
 * @affects creates 1 pipe run (plant.piping) and its derived, read-only part entities `<runId>/<kind>-<k>` (pipe pieces, elbows, flanges, gaskets,
 *   valves, reducers)
 * @invariant stored = the points of intersection and the inline components only; parts, cut lengths and joints are derived from the line's spec;
 *   a straight closing leg is appended when the target port is on its axis; consecutive collinear legs merge; weld gap default 0 (data.weldGap)
 * @failure unknown line / port, port in use, size / rating / facing / end-type mismatch, port direction, closing leg, zero leg, angle with no
 *   spec elbow, leg too short, an inline component that does not fit, missing spec component -> RTE_* refusal, document unchanged
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
    'the tolerance). A SLOPED leg gives planLength (its horizontal length) and slope { value, unit percent|ratio|deg, fall } instead of length, along a ' +
    'horizontal direction: it falls (or rises) by planLength x s, so a 1 % fall over 8000 is 80 mm lower and 8000.39999 long; the elbow after it turns by ' +
    'the real angle (89.427 degrees into a vertical leg) and is the standard 90 elbow within the spec tolerance; a sloped first / last leg is judged on its ' +
    'plan direction against the port; the declared slope is stored per leg (check_piping RTE_ADVERSE_SLOPE / RTE_POCKET) and sloped legs report planLengthMm, ' +
    'dropMm (positive = descends along the flow) and slopeDeg in data.legs. via: extra points of intersection after the legs. When `to` is a port, a straight closing leg to it is added if the last point ' +
    'is on its axis (the last leg may omit length to run straight to it). inline: [{ type (valve or reducerConcentric), at: { leg, centreDistance }, ' +
    'dn2 (reducers), tag, stemDirection }] places valves and reducers while routing (leg = index in data.legs, the closing leg included); a reducer is how ' +
    'the run meets a `to` port of another size. Add them later with insert_inline_component. Open-end directions are normalised (zero is refused). ' +
    'Returns the run id (affected[0]); data = { runId, lineId, lineNumber, pis, closingLeg, mergedPoints, portDeviationDeg, legs (index, direction, lengthMm, ' +
    'cutLengthsMm, planLengthMm / dropMm / slopeDeg on sloped legs), turns (turnDeg, nominalDeg, deviationDeg, centreToEnd, fitting), insulation, ' +
    'envelopeDiameterMm (OD + 2 x the line insulation, null without), counts, pipePieces (id, leg, cutLengthMm), totalPipeMm, ' +
    'centrelineLengthMm, studs, warnings (RTE_WELD_SPACING, RTE_FITTING_TO_FITTING), unverified, unverifiedReasons, partIds, inlineIds, dn (start, end), spec, ' +
    'angleTolerance, weldGap, weldSpacing, pipe }; parts and joints are listed by piping_takeoff. A spec that is not ' +
    'approved or has non-grade-A rows reports unverified. Refusals: RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_LINE, RTE_UNKNOWN_PORT, RTE_PORT_IN_USE, RTE_SLOPE_INVALID (slope on a vertical leg, no planLength, over 100 %), ' +
    'RTE_INVALID_PORT (zero open-end direction), RTE_SIZE_MISMATCH (also a reducer without dn2), RTE_RATING_MISMATCH, RTE_FACING_MISMATCH, ' +
    'RTE_NO_CONNECTION_RULE, RTE_PORT_DIRECTION, RTE_CLOSING_LEG_IMPOSSIBLE (detail.offset), RTE_ZERO_LEG, RTE_NO_FITTING_FOR_ANGLE ' +
    '(detail.anglesDeg), RTE_SEGMENT_TOO_SHORT (detail.cutLengthMm), RTE_INLINE_DOES_NOT_FIT, RTE_SPEC_UNKNOWN, RTE_SPEC_NO_COMPONENT, ' +
    'RTE_SPEC_AMBIGUOUS. Next: piping_takeoff for the cut list; check_piping; add_branch / insert_inline_component; delete_pipe_run to redo.',
  params: z.object({
    lineId: z.string().describe('Pipe line id (affected[0] of create_pipeline).'),
    from: portOrPoint.describe('Start: { portId } or an open { point, direction? }.'),
    to: portOrPoint.optional().describe('End: { portId } (a closing leg is added) or an open { point }. Omit to end at the last leg.'),
    legs: legsInput,
    via: viaInput,
    angleToleranceDeg: z
      .number()
      .positive()
      .max(22.5)
      .optional()
      .describe('Overrides the spec tolerance for port directions and elbow angles, degrees, 22.5 at most (named in the result).'),
    inline: z
      .array(z.object({ ...inlineFields, at: inlineAt.describe('Where the centre sits: { leg, centreDistance }.') }))
      .optional()
      .describe('Valves and concentric reducers placed while routing (see insert_inline_component for the rules).'),
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
    const from = resolveEndpoint(doc, 'route_pipe', line, line.dn, params.from, 'from');
    if (!isResolved(from)) return from;
    const to = params.to === undefined ? undefined : resolveEndpoint(doc, 'route_pipe', line, null, params.to, 'to');
    if (to !== undefined && !isResolved(to)) return to;
    // The run ends at the size of its last reducer (the line size without one): the end port must have it.
    const reducers = (params.inline ?? [])
      .filter((item) => item.type === 'reducerConcentric' && item.dn2 !== undefined)
      .sort((a, b) =>
        byRoute({ leg: a.at.leg, centreDistance: a.at.centreDistance }, { leg: b.at.leg, centreDistance: b.at.centreDistance }),
      );
    const endSize = reducers.at(-1)?.dn2 ?? line.dn;
    if (to?.dn !== undefined && to.dn !== endSize)
      return refuse(
        doc,
        'route_pipe',
        'RTE_SIZE_MISMATCH',
        `port ${to.portId} is DN${to.dn}, line ${line.id} is DN${endSize}${reducers.length === 0 ? '' : ' after its reducers'}`,
        [to.portId ?? '', line.id],
        ['to.portId'],
      );
    const tolerance = params.angleToleranceDeg ?? lookup.elbowAngles().toleranceDeg;
    const path = buildPath(from.end, to?.end, params.legs ?? [], (params.via ?? []) as Vec3[], tolerance);
    if (!path.ok) return refuse(doc, 'route_pipe', path.code, path.message, [line.id], path.paths, path.detail);
    const inline: InlineComponent[] = [];
    for (const [index, item] of (params.inline ?? []).entries()) {
      const [a, b] = [path.points[item.at.leg], path.points[item.at.leg + 1]];
      if (a === undefined || b === undefined)
        return refuse(
          doc,
          'route_pipe',
          'RTE_INLINE_DOES_NOT_FIT',
          `inline.${index} names leg ${item.at.leg}, but the route has ${path.legs.length} leg(s)`,
          [line.id],
          [`inline.${index}.at.leg`],
        );
      const built = buildInline(doc, 'route_pipe', item, item.at, unitVector([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), `inline.${index}`);
      if ('document' in built) return built;
      inline.push(built);
    }
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
      ...(path.legSlopes.some((slope) => slope !== null) ? { legSlopes: path.legSlopes } : {}),
      ...(params.angleToleranceDeg === undefined ? {} : { angleToleranceDeg: params.angleToleranceDeg }),
      ...(inline.length === 0 ? {} : { inline }),
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
          `${inline.length === 0 ? '' : `${inline.length} inline component(s), `}${takeoff.pipePieces.length} pipe piece(s) totalling ${takeoff.totalPipeMm} mm, centreline ${takeoff.centrelineLengthMm} mm, ` +
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
          ...(leg.dropMm === undefined ? {} : { planLengthMm: leg.planLengthMm, dropMm: leg.dropMm, slopeDeg: leg.slopeDeg }),
        })),
        turns: takeoff.turns.map((turn) => ({
          index: turn.index,
          turnDeg: turn.turnDeg,
          nominalDeg: turn.nominalDeg,
          deviationDeg: turn.deviationDeg,
          centreToEnd: turn.centreToEnd,
          fitting: turn.typeKey,
        })),
        counts: takeoff.counts,
        pipePieces: takeoff.pipePieces.map((piece) => ({ id: piece.id, leg: piece.leg, cutLengthMm: piece.cutLengthMm })),
        totalPipeMm: takeoff.totalPipeMm,
        centrelineLengthMm: takeoff.centrelineLengthMm,
        studs: takeoff.studs,
        warnings: takeoff.warnings,
        unverified: takeoff.unverified,
        unverifiedReasons: takeoff.unverifiedReasons,
        insulation: line.insulation ?? null,
        envelopeDiameterMm: line.insulation === undefined ? null : envelopeDiameter(derived.pipe.outsideDiameterMm, line.insulation),
        partIds: derived.parts.map((part) => part.id),
        inlineIds: inline.map((item) => item.id),
        dn: derived.dn,
        spec: derived.spec,
        angleTolerance: derived.angleTolerance,
        weldGap: derived.weldGap,
        weldSpacing: derived.weldSpacing,
        pipe: derived.pipe,
      },
    };
  },
});
