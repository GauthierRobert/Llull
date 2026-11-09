/** Aerodynamic surfaces of a flying body (13 FLT M4): generate_aero_table sweeps the vortex-lattice query over angle of attack and pivot angle. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import { toMetres } from '@core/model/units';
import { canonicalJson } from '@lib/canonicalJson';
import { idOrNext } from '@lib/explicitId';
import { hashText } from '@lib/hash';
import type { AeroSurface } from '../flight/aeroModel';
import { assembleTable, aeroDesignHash, type LatticeRow } from '../flight/aeroTable';
import { flowSections, latticeRows, toFlow } from '../flight/aeroSweep';
import { flightOf, idTakenInDynamicsOrFlight, ISA_SEA_LEVEL_DENSITY } from '../flight/model';
import { dynamicsOf } from './bodies';

/** Profile drag coefficient of a surface without a stated polar (a clean thin wing section at moderate Reynolds number). */
const DEFAULT_PROFILE_DRAG = 0.01;
const DEFAULT_ALPHAS_DEG = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
const format = (value: number): string => value.toPrecision(4);

const surfaceSchema = z.object({
  name: z.string().describe('Surface name, e.g. "wing", "tail".'),
  sections: z
    .array(
      z.object({
        leadingEdge: vec3('Leading-edge point in the BODY axes, document units (the same units as momentCentre).'),
        chord: z.number().describe('Chord length, document units (>= 0; 0 only at a pointed tip).'),
        incidenceDeg: z.number().optional().describe('Section incidence (twist), degrees, nose up positive. Default 0.'),
      }),
    )
    .min(2)
    .max(200)
    .describe('Sections root to tip, at least 2 (leading edge, chord, incidence).'),
  mirror: z
    .boolean()
    .optional()
    .describe(
      'Add the mirror image about the body plane through the origin whose normal is the spanwise axis. Default true, except false for a surface on that plane or one spanning both sides; set false for a full-span wing placed off the plane.',
    ),
  spanwisePanels: z.number().int().optional().describe('Spanwise panels per side, 1..200. Default 12.'),
  chordwisePanels: z.number().int().optional().describe('Chordwise panels, 1..50. Default 4.'),
  naca: z.string().optional().describe('Section NACA designation: its thin-airfoil zero-lift angle is applied as a camber incidence.'),
  zeroLiftAngleDeg: z.number().optional().describe('Section zero-lift angle, degrees (overrides naca). Default 0 (flat plate).'),
  pivots: z
    .boolean()
    .optional()
    .describe('The surface turns with the pivot angle (a servo-pivoted wing, an all-moving tail). Default false.'),
});

/** Why `bodyId` cannot carry a surface (missing or fixed), or null. */
function bodyProblem(doc: CadDocument, bodyId: string): string | null {
  const bodies = dynamicsOf(doc).bodies;
  const body = Object.hasOwn(bodies, bodyId) ? bodies[bodyId] : undefined;
  if (body === undefined) return `body '${bodyId}' is not a rigid body (add_rigid_body first)`;
  return body.fixed ? `body '${bodyId}' is fixed to the ground; an aero surface needs a moving body` : null;
}

const increasing = (values: readonly number[]): boolean => values.every((value, i) => i === 0 || value > (values[i - 1] ?? Infinity));

/**
 * @affects adds 1 aero surface (table CL / CD / Cm over alpha and pivot) to doc.flight.aeroSurfaces (affected: [surfaceId]); data { table, polar, ... }
 * @invariant CL and Cm are the vortex-lattice values (inviscid, incompressible, linear in alpha); CD = cd0 + CDi; only alphas with |CL| <= clMax at every pivot angle stay
 * @invariant composes analyze_vortex_lattice through ctx.registry: one call (one factorisation) per pivot angle; no other plugin is imported
 * @invariant designHash = hash of the generation inputs and of the body record and its entities: a later change stales the table (run_flight warns FLT_AERO_TABLE_STALE)
 * @failure unknown / fixed body, taken id, bad angles or sections, no pivoting surface for a pivot sweep, servo limits outside the sweep, stall bound leaving fewer than 2 angles,
 *          vortex-lattice refusal (reported with its code), aerodynamics plugin missing -> no-op
 */
export const generateAeroTable = defineCommand({
  name: 'generate_aero_table',
  description:
    'Generate the aerodynamic table of lifting surfaces on a flying body from the vortex-lattice query (13 FLT, FR-FLT-03): CL, CD and Cm over the ' +
    'angle of attack and, for a servo-pivoted wing or all-moving tail, over the pivot angle. The surface then acts in run_flight: every step the air velocity ' +
    'at momentCentre (body velocity + ω × r, relative to the wind) gives alpha and q; the table is read bilinearly (held at its edge outside, with a ' +
    'FLT_AERO_OUTSIDE_TABLE warning) and the force acts at momentCentre (lift across the flow, drag along it) plus the pitching moment q·S·c·Cm. ' +
    'Geometry: `sections` per surface in BODY axes, document units; `forward` is the body axis the vehicle travels along ("+x" default), the flow frame ' +
    'is x downstream, y spanwise (z × x), z up, alpha nose up positive; Cm is about `momentCentre` (a body-fixed point; put it at the centre of ' +
    'gravity or at the wing hinge). Reference area and chord default to the first surface planform area and mean aerodynamic chord (given in document ' +
    'units, stored in m² / m). Viscous model (stated): CD = cd0 + CDi, CDi the induced drag from the lattice (Trefftz plane), cd0 constant ' +
    '`profileDrag.cd0` (default 0.01, the result is then `unverified`; give `profileDrag.source` for a graded polar). The lattice is inviscid so there is ' +
    'no stall: with `profileDrag.clMax` the table keeps only the run of angles of attack around zero where |CL| stays within it, and outside it the ' +
    'coefficients are held with a warning. Pivot sweep: `pivotsDeg` (strictly increasing, nose up positive, e.g. [-30, 0, 30]) turns the surfaces with ' +
    '`pivots: true` about the spanwise axis through `pivotPoint` (body axes, document units); `servo` gives the rate limit (deg/s) and optional ' +
    'limits of the pivot, driven by the `pivotDeg` field of define_flight_scenario set-points. The pivot changes the aerodynamics only: the mass, inertia and centre of mass of the body do not follow it and no hinge load is computed. Flow from the downstream side (|alpha| > 90°) gives no force and counts as outside the table. Not modelled: sideslip (the flow outside the x-z plane ' +
    'is ignored), rates dependence beyond the local velocity, control-surface (flap) deflection, stall, compressibility. Returns the surface id in affected[0]; data holds ' +
    'the table, the polar CL-CD at the pivot nearest 0, the lift slope per rad, the reference values and the provenance.',
  params: z.object({
    body: z.string().describe('Id of the free rigid body the surfaces ride on.'),
    surfaces: z
      .array(surfaceSchema)
      .min(1)
      .max(8)
      .describe('Lifting surfaces solved together (wing, tails): their mutual interference is in the table.'),
    momentCentre: vec3(
      'Body-fixed point, body axes, document units: where the aerodynamic force acts and the moment reference (CG or hinge).',
    ),
    forward: z.enum(['+x', '-x', '+y', '-y']).optional().describe('Body axis the vehicle travels along. Default "+x".'),
    alphasDeg: z
      .array(z.number())
      .min(2)
      .max(31)
      .optional()
      .describe('Angles of attack, deg, strictly increasing, each within -20..20 (the lattice limit). Default -10..10 step 2.'),
    pivotsDeg: z
      .array(z.number().min(-90).max(90))
      .min(1)
      .max(21)
      .optional()
      .describe('Pivot angles, deg, strictly increasing (nose up positive). Default [0] = no pivot.'),
    pivotPoint: vec3('A point on the spanwise pivot axis, body axes, document units. Required with more than one pivot angle.').optional(),
    servo: z
      .object({
        rateDegS: z.number().positive().describe('Servo slew limit, deg/s.'),
        minDeg: z.number().optional().describe('Lower travel limit, deg. Default the smallest pivot angle.'),
        maxDeg: z.number().optional().describe('Upper travel limit, deg. Default the largest pivot angle.'),
        neutralDeg: z
          .number()
          .optional()
          .describe('Pivot angle at t = 0 unless a set-point names one, deg. Default 0 clamped to the limits.'),
      })
      .optional()
      .describe('Pivot servo; required with more than one pivot angle.'),
    profileDrag: z
      .object({
        cd0: z.number().min(0).describe('Constant profile drag coefficient added to the induced drag, on the reference area.'),
        clMax: z
          .number()
          .positive()
          .optional()
          .describe('Section stall CL: angles of attack with |CL| above it are dropped from the table.'),
        source: z
          .string()
          .optional()
          .describe('Where the polar comes from (report, test, CFD run); with it the result is not flagged unverified.'),
      })
      .optional()
      .describe('Section polar model. Default cd0 0.01, no stall bound, unverified.'),
    referenceArea: z
      .number()
      .positive()
      .optional()
      .describe('Reference area S, document units². Default planform area of the first surface (both sides).'),
    referenceChord: z
      .number()
      .positive()
      .optional()
      .describe('Reference chord for Cm, document units. Default mean aerodynamic chord of the first surface.'),
    airDensity: z.number().positive().optional().describe('kg/m³; default 1.225 (ISA sea level).'),
    id: z.string().optional().describe('Optional explicit surface id (shares the id space of the dynamics records).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, 'generate_aero_table');
    const problem = bodyProblem(doc, params.body);
    if (problem !== null) return fail(problem);
    const alphas = params.alphasDeg ?? DEFAULT_ALPHAS_DEG;
    if (!increasing(alphas) || alphas.some((alpha) => !(Math.abs(alpha) <= 20)))
      return fail('alphasDeg must strictly increase and lie within -20..20 degrees');
    const pivots = params.pivotsDeg ?? [0];
    if (!increasing(pivots)) return fail('pivotsDeg must strictly increase');
    const sweeping = pivots.length > 1;
    if (sweeping && !params.surfaces.some((surface) => surface.pivots === true))
      return fail('a pivot sweep needs at least one surface with pivots: true');
    if (sweeping && (params.pivotPoint === undefined || params.servo === undefined))
      return fail('a pivot sweep needs pivotPoint and servo');
    if (!sweeping && params.servo !== undefined) return fail('servo needs pivotsDeg with more than one angle');
    const low = pivots[0] ?? 0;
    const high = pivots[pivots.length - 1] ?? 0;
    const servo = params.servo;
    const minDeg = servo?.minDeg ?? low;
    const maxDeg = servo?.maxDeg ?? high;
    if (servo !== undefined && !(low <= minDeg && minDeg <= maxDeg && maxDeg <= high))
      return fail(`servo limits [${minDeg}, ${maxDeg}] must be ordered and lie inside the pivot sweep [${low}, ${high}]`);
    const neutralDeg = Math.min(maxDeg, Math.max(minDeg, servo?.neutralDeg ?? 0));
    const id = idOrNext(params.id, 'aero');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    const lattice = ctx?.registry('analyze_vortex_lattice');
    if (lattice === undefined) return fail('analyze_vortex_lattice is not registered (the aerodynamics plugin is not installed)');
    const forward = params.forward ?? '+x';
    const pivotPoint = toFlow(params.pivotPoint ?? [0, 0, 0], forward);
    const referencePoint = toFlow(params.momentCentre, forward);
    const callFor = (pivotDeg: number, area?: number, chord?: number): Record<string, unknown> => ({
      surfaces: params.surfaces.map((surface) => ({
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
    // the reference area and chord come from the call nearest zero pivot (the un-pivoted planform) and are held for the others
    const smallestPivot = Math.min(...pivots.map(Math.abs));
    const zeroIndex = pivots.findIndex((pivot) => Math.abs(pivot) === smallestPivot);
    const call = (pivotDeg: number, area?: number, chord?: number): { rows: LatticeRow[]; data: Record<string, unknown> } | string => {
      const result = lattice.run(doc, callFor(pivotDeg, area, chord), ctx);
      const rows = latticeRows(result.data);
      return rows === null ? result.summary : { rows, data: result.data as Record<string, unknown> };
    };
    const first = call(pivots[zeroIndex] ?? 0, params.referenceArea, params.referenceChord);
    if (typeof first === 'string') return fail(`the vortex-lattice query refused: ${first}`);
    const reference = first.data['reference'] as { area: number; chord: number; span: number };
    const area = params.referenceArea ?? reference.area;
    const chord = params.referenceChord ?? reference.chord;
    const rowsByPivot: (readonly LatticeRow[])[] = [];
    for (let p = 0; p < pivots.length; p++) {
      const result = p === zeroIndex ? first : call(pivots[p] ?? 0, area, chord);
      if (typeof result === 'string') return fail(`the vortex-lattice query refused at pivot ${pivots[p]}°: ${result}`);
      rowsByPivot.push(result.rows);
    }
    const profile = params.profileDrag;
    const cd0 = profile?.cd0 ?? DEFAULT_PROFILE_DRAG;
    const clMax = profile?.clMax ?? null;
    const source = profile?.source !== undefined && profile.source.trim().length > 0 ? profile.source.trim() : null;
    const assembled = assembleTable(pivots, rowsByPivot, cd0, clMax);
    if (assembled === null)
      return codedRejection(
        doc,
        'generate_aero_table',
        'FLT_AERO_TABLE_EMPTY',
        `the stall bound clMax ${clMax ?? 'none'} leaves fewer than 2 angles of attack around zero lift in the sweep [${alphas.join(', ')}]`,
        'Raise clMax or use a finer / narrower alphasDeg sweep around zero lift.',
        [params.body],
      );
    const metres = toMetres(doc, 1);
    const { id: _ignored, ...inputs } = params;
    const inputsHash = hashText(canonicalJson(inputs));
    const panels = (first.data['lattice'] as { panels: number }).panels;
    const surface: AeroSurface = {
      id,
      bodyId: params.body,
      momentCentre: params.momentCentre,
      forward,
      refAreaM2: area * metres * metres,
      refChordM: chord * metres,
      refSpanM: reference.span * metres,
      airDensity: params.airDensity ?? ISA_SEA_LEVEL_DENSITY,
      table: assembled.table,
      validAlphaDeg: assembled.validAlphaDeg,
      profileDrag: { cd0, clMax, source },
      provenance: 'vlm+polar',
      unverified: source === null,
      servo: servo === undefined ? null : { rateDegS: servo.rateDegS, minDeg, maxDeg, neutralDeg },
      inputsHash,
      designHash: aeroDesignHash(doc, params.body, inputsHash),
      solver: { engine: String((first.data['solver'] as { engine?: string } | undefined)?.engine ?? 'ts'), panels, calls: pivots.length },
      defaulted: source === null ? ['profileDrag'] : [],
    };
    const flight = flightOf(doc);
    const table = assembled.table;
    const zeroColumn = zeroIndex;
    const polar = {
      pivotDeg: pivots[zeroIndex] ?? 0,
      alphaDeg: table.alphaDeg,
      cl: table.cl.map((row) => row[zeroColumn] ?? 0),
      cd: table.cd.map((row) => row[zeroColumn] ?? 0),
    };
    const data = {
      surfaceId: id,
      table,
      polar,
      liftSlopePerRad: first.data['liftSlopePerRad'],
      neutralPoint: first.data['neutralPoint'],
      reference: {
        areaM2: surface.refAreaM2,
        chordM: surface.refChordM,
        spanM: surface.refSpanM,
        momentCentre: params.momentCentre,
        forward,
      },
      validAlphaDeg: assembled.validAlphaDeg,
      droppedAlphaDeg: assembled.droppedAlphaDeg,
      profileDrag: surface.profileDrag,
      provenance: surface.provenance,
      unverified: surface.unverified,
      designHash: surface.designHash,
    };
    return {
      ...changed(
        { ...doc, flight: { ...flight, aeroSurfaces: { ...flight.aeroSurfaces, [id]: surface } } },
        `generate_aero_table: '${id}' on body '${params.body}' — ${table.alphaDeg.length} angles of attack [${table.alphaDeg[0]}, ${table.alphaDeg[table.alphaDeg.length - 1]}]° × ` +
          `${pivots.length} pivot angle(s) from ${pivots.length} vortex-lattice call(s) (${panels} panels), S ${format(surface.refAreaM2)} m², c ${format(surface.refChordM)} m, ` +
          `span ${format(surface.refSpanM)} m, CL_α ${String(first.data['liftSlopePerRad'])}/rad, CD = ${format(cd0)} + CDi` +
          `${clMax === null ? '' : `, stall bound CL ${clMax} (${assembled.droppedAlphaDeg.length} angle(s) dropped)`}; ` +
          `${source === null ? 'unverified: profile drag defaulted (give profileDrag.source)' : `profile drag from ${source}`}` +
          `${servo === undefined ? '' : `; pivot servo ${servo.rateDegS} deg/s in [${minDeg}, ${maxDeg}]°`}.`,
        [id],
      ),
      data,
    };
  },
});
