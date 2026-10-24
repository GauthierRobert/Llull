import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec3 } from '@core/model/vectors';
import type { BranchPoint, PipeRun } from '@aec/plant/types';
import { add3, scale3, sub3 } from '@lib/vec3';
import { nextId } from '@lib/id';
import type { DerivedBranch, RunDerivation } from '../deriveTypes';
import { angleBetweenDeg, buildPath, legVector, unitVector } from '../legs';
import { getPiping, locateOnRun, refuse, runPoints } from '../model';
import { refuseDerivation, rederive, withRuns } from '../runUpdate';
import { createSpecLookup, isMiss } from '../specLookup';
import { takeoffOf } from '../takeoff';
import { isResolved, legsInput, portOrPoint, resolveEndpoint, viaInput } from './routeInput';

const pieceRows = (runId: string, derivation: RunDerivation): Array<Record<string, unknown>> =>
  takeoffOf([{ runId, derivation }]).pipePieces.map((piece) => ({
    id: piece.id,
    runId,
    dn: piece.dn,
    leg: piece.leg,
    cutLengthMm: piece.cutLengthMm,
  }));

/**
 * @affects adds 1 branch point to the header run (run.branches) and creates 1 branch run (its start references the branch point); derives the
 *   branch fitting (tee, reducing tee, olet, stub-in) from the header spec's branch table and re-derives the header
 * @invariant the fitting comes from the branch table of the header line's spec for (header size at the point, branch size), reported in data.fitting;
 *   a tee splits the header leg (header cuts C each side), an olet leaves it whole, the branch pipe starts M (tee) / A (olet) from the header axis
 * @failure unknown run / line / port, port in use or of another size, no branch-table cell, branch not perpendicular to the header, point not on the
 *   centreline, branch inside a fitting, missing spec row -> RTE_* refusal, document unchanged
 */
export const addBranch = defineCommand({
  name: 'add_branch',
  description:
    'Take a branch off a routed pipe run (the header), spec-driven: the fitting is the branch-table cell of the header line spec for (header size at ' +
    'that point, branch DN): equal tee, reducing tee, weldolet / sockolet / threadolet or a stub-in (reported in data.fitting with the table cell). A ' +
    'tee splits the header leg (header pieces shortened by the catalogue centre-to-end C); an olet sits on the header pipe, which stays whole; the ' +
    'branch pipe starts from the fitting outlet (tee M, olet A from the header centreline). at: { point: [x, y, z] } on the header centreline (within ' +
    '0.01 mm) or { leg, distance } (distance from the leg start, mm). The branch leaves perpendicular to the header (within the spec angle ' +
    'tolerance): give legs [{ direction, length }] (a leg may be sloped: planLength + slope as in route_pipe, e.g. a drain falling away from the header) and optionally via, and/or `to` (a free port of size dn, or an open point; with `to` and no legs the ' +
    'branch runs straight to it). The branch is a new run of the same line (or of lineId) at size dn; its first piece is cut after the fitting. Returns the ' +
    'branch run id (affected[0]) and the branch point id (affected[1]); data = { branchRunId, branchId, headerRunId, fitting (tee, reducingTee, weldolet ' +
    '..., stubIn), fittingCode (T, RT, W, S, TH, SI, SIR), partId, headerDn, branchDn, leg, distance, position, direction, branchStartMm, ' +
    'branchStartSource, runCentreToEndMm, reviewRequired, pipePieces (header and branch cuts), legs, warnings, unverified }. A stub-in reports ' +
    'RTE_STUB_IN_REVIEW in check_piping (reinforcement is checked outside llull). Refusals: RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_RUN, RTE_UNKNOWN_LINE, ' +
    'RTE_UNKNOWN_PORT, RTE_PORT_IN_USE, RTE_SIZE_MISMATCH, RTE_BRANCH_NO_TABLE_ROW, RTE_BRANCH_ON_FITTING (also an olet or stub-in whose footprint overlaps another one on the same header leg), RTE_NO_FITTING_FOR_ANGLE (not ' +
    'perpendicular), RTE_NO_CONNECTION_RULE, RTE_SPEC_NO_COMPONENT, RTE_SEGMENT_TOO_SHORT, RTE_CLOSING_LEG_IMPOSSIBLE, RTE_ZERO_LEG. Next: ' +
    'piping_takeoff, piping_connectivity, check_piping.',
  params: z.object({
    runId: z.string().describe('Header run id (affected[0] of route_pipe / auto_route_pipe / add_branch).'),
    at: z
      .union([
        z.object({ point: vec3('A point [x, y, z] on the header centreline, within 0.01 mm.') }),
        z.object({
          leg: z.number().int().min(0).describe('Header leg index.'),
          distance: z.number().positive().describe('Distance of the branch point from the leg start, mm.'),
        }),
      ])
      .describe('Where the branch leaves the header: { point } on the centreline or { leg, distance }.'),
    dn: z.number().int().positive().describe('Nominal size DN of the branch pipe.'),
    to: portOrPoint.optional().describe('Branch end: a free port of size dn, or an open point. Omit to end at the last leg.'),
    legs: legsInput,
    via: viaInput,
    lineId: z.string().optional().describe('Line of the branch run (default: the header line).'),
    angleToleranceDeg: z
      .number()
      .positive()
      .max(22.5)
      .optional()
      .describe(
        'Overrides the spec angle tolerance for the perpendicular check, the port directions and the branch elbows, degrees, 22.5 at most.',
      ),
  }),
  run: (doc, params): CommandResult => {
    if (doc.units !== 'mm')
      return refuse(
        doc,
        'add_branch',
        'RTE_UNITS_UNSUPPORTED',
        `plant lengths and catalogue dimensions are mm; this document is in ${doc.units}`,
      );
    const piping = getPiping(doc);
    const header = piping.runs[params.runId];
    if (header === undefined) return refuse(doc, 'add_branch', 'RTE_UNKNOWN_RUN', `no pipe run "${params.runId}"`, [], ['runId']);
    const headerLine = piping.lines[header.lineId];
    const branchLine = params.lineId === undefined ? headerLine : piping.lines[params.lineId];
    if (headerLine === undefined)
      return refuse(
        doc,
        'add_branch',
        'RTE_UNKNOWN_LINE',
        `run ${header.id} names the missing line "${header.lineId}"`,
        [header.id],
        ['runId'],
      );
    if (branchLine === undefined) return refuse(doc, 'add_branch', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    const lookup = createSpecLookup(doc, headerLine.spec);
    if (isMiss(lookup)) return refuse(doc, 'add_branch', lookup.miss, lookup.detail, [headerLine.id, ...lookup.ids], ['runId']);
    const places = runPoints(header);
    const where = 'leg' in params.at ? { leg: params.at.leg, distance: params.at.distance } : locateOnRun(header, params.at.point);
    const [from, to] = where === null ? [undefined, undefined] : [places[where.leg], places[where.leg + 1]];
    if (where === null || from === undefined || to === undefined)
      return refuse(
        doc,
        'add_branch',
        'RTE_BRANCH_ON_FITTING',
        'point' in params.at
          ? `point [${params.at.point.join(', ')}] is not on the centreline of run ${header.id}`
          : `run ${header.id} has no leg ${params.at.leg}`,
        [header.id],
        ['at'],
      );
    const along = unitVector(sub3(to, from));
    const position: Vec3 = add3(from, scale3(along, where.distance));
    const target = params.to === undefined ? undefined : resolveEndpoint(doc, 'add_branch', branchLine, params.dn, params.to, 'to');
    if (target !== undefined && !isResolved(target)) return target;
    const aim: Vec3 | undefined =
      params.legs?.[0] !== undefined ? legVector(params.legs[0].direction) : (params.via?.[0] ?? target?.end.point);
    const direction = aim === undefined ? null : params.legs?.[0] !== undefined ? unitVector(aim) : unitVector(sub3(aim, position));
    if (direction === null || !(Math.hypot(...direction) > 0))
      return refuse(
        doc,
        'add_branch',
        'RTE_ZERO_LEG',
        'give legs, via points or a target (to) so the branch has a direction',
        [header.id],
        ['legs'],
      );
    const tolerance = params.angleToleranceDeg ?? lookup.elbowAngles().toleranceDeg;
    const angle = angleBetweenDeg(direction, along);
    if (Math.abs(angle - 90) > tolerance)
      return refuse(
        doc,
        'add_branch',
        'RTE_NO_FITTING_FOR_ANGLE',
        `the branch leaves ${+angle.toFixed(4)} deg from the header axis; tees and olets take branches perpendicular within ${tolerance} deg`,
        [header.id],
        ['legs.0.direction'],
        { angleDeg: angle, anglesDeg: [90], toleranceDeg: tolerance },
      );
    const path = buildPath({ point: position, direction }, target?.end, params.legs ?? [], (params.via ?? []) as Vec3[], tolerance);
    if (!path.ok) return refuse(doc, 'add_branch', path.code, path.message, [header.id], path.paths, path.detail);
    const branchRunId = nextId('run');
    const branchId = nextId('branch');
    const point: BranchPoint = { id: branchId, leg: where.leg, distance: where.distance, branchRunId };
    const branch: PipeRun = {
      id: branchRunId,
      lineId: branchLine.id,
      dn: params.dn,
      start: { point: position, direction, ref: { kind: 'branch', runId: header.id, branchId } },
      end: {
        point: path.points.at(-1) as Vec3,
        ...(target?.end.direction === undefined ? {} : { direction: target.end.direction }),
        ...(target?.ref === undefined ? {} : { ref: target.ref }),
      },
      pis: path.points.slice(1, -1),
      ...(path.legSlopes.some((slope) => slope !== null) ? { legSlopes: path.legSlopes } : {}),
      ...(params.angleToleranceDeg === undefined ? {} : { angleToleranceDeg: params.angleToleranceDeg }),
    };
    const nextHeader: PipeRun = { ...header, branches: [...(header.branches ?? []), point] };
    const result = rederive(withRuns(doc, [nextHeader, branch]), [header.id, branchRunId]);
    if (!result.ok) return refuseDerivation(doc, 'add_branch', result, branchRunId);
    const [headerDerived, branchDerived] = [
      result.derivations[header.id] as RunDerivation,
      result.derivations[branchRunId] as RunDerivation,
    ];
    const fit = headerDerived.branches.find((candidate) => candidate.id === branchId) as DerivedBranch;
    const warnings = [...headerDerived.warnings, ...branchDerived.warnings];
    const reasons = [...new Set([...headerDerived.unverifiedReasons, ...branchDerived.unverifiedReasons])];
    return {
      ...changed(
        result.document,
        `add_branch: ${fit.typeKey} (table cell ${fit.fittingCode}) DN${fit.headerDn} x DN${params.dn} on run ${header.id} leg ${where.leg} at ${+where.distance.toFixed(4)} mm; ` +
          `branch run ${branchRunId} starts ${+fit.branchStartMm.toFixed(4)} mm from the header axis (${fit.branchStartSource}); ` +
          `header pieces ${JSON.stringify(headerDerived.legs[where.leg]?.cutLengthsMm.map((cut) => +cut.toFixed(4)))}, branch pieces ${JSON.stringify(branchDerived.legs.flatMap((leg) => leg.cutLengthsMm.map((cut) => +cut.toFixed(4))))}; ` +
          `${warnings.length} warning(s)${reasons.length > 0 ? `; unverified: ${reasons.join('; ')}` : ''}${fit.reviewRequired ? '; RTE_STUB_IN_REVIEW: reinforcement needs a review' : ''}.`,
        [branchRunId, branchId],
      ),
      data: {
        branchRunId,
        branchId,
        headerRunId: header.id,
        fitting: fit.typeKey,
        fittingCode: fit.fittingCode,
        partId: fit.partId,
        headerDn: fit.headerDn,
        branchDn: params.dn,
        leg: where.leg,
        distance: where.distance,
        position,
        direction,
        branchStartMm: fit.branchStartMm,
        branchStartSource: fit.branchStartSource,
        runCentreToEndMm: fit.runCentreToEndMm,
        reviewRequired: fit.reviewRequired,
        pipePieces: [...pieceRows(header.id, headerDerived), ...pieceRows(branchRunId, branchDerived)],
        legs: branchDerived.legs.map((leg) => ({
          index: leg.index,
          direction: leg.direction,
          lengthMm: leg.lengthMm,
          cutLengthsMm: leg.cutLengthsMm,
        })),
        warnings,
        unverified: reasons.length > 0,
        unverifiedReasons: reasons,
      },
    };
  },
});
