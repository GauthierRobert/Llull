/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { getBuilding } from '../model';
import { round } from '../numeric';
import { toCsv } from '../scheduleBuild';
import { analyseSteelStructure } from './steelStructureAnalysis';

const ASSUMPTIONS: ReadonlyArray<string> = [
  'Loads: EN 1990 ULS 1.35 G + 1.5 Q; SLS G + Q. G = self weight (catalogue kg/m), floor dead load, equipment operating weight, pipes (steel wall + contents) and cable trays; Q = imposed floor load. No imposed-load reduction factors.',
  'Floor slabs (role floor): the slab area (openings removed) is rastered; each cell bears on the nearest beam in plan whose top of steel lies at the slab underside (-60 / +20 mm) — the 45° tributary rule (triangles on the short sides, trapezoids on the long sides of a rectangular bay), ties split. Imposed load is not applied under equipment footprints.',
  'Equipment: its footprint is rastered; the weight (kg × 9.80665) goes to the beams nearest each cell, proportional to footprint area per bay, through the floor slab under it, else directly onto beams whose top of steel is at its base. Equipment on grade is reported and not carried.',
  'Pipes and cable trays: a run rests on a beam where it crosses the beam in plan with its underside within 10 mm of the beam top of steel; each support takes the weight per metre over half the span to the neighbouring supports (end supports also the overhang to the run end). Pipe wall = standard wall (ASME B36.10M) of the outside diameter.',
  'Beams: simply supported between their end nodes; end reactions go to the column at the node, or to the beam they frame into. LTB is assumed restrained by the floor (grating) or the pipes / trays on the top flange; beams with neither are checked for LTB with C1 = 1.0 over the full span.',
  'Columns: braced, pin-ended beams (no connection eccentricity), axial load = sum of the beam reactions above the segment plus self weight, checked per segment between beam levels with Lcr = segment length about both axes (EN 1993-1-1 Tab. 6.2 curves; rolled I/H a/b or b/c, hot-finished hollow a).',
  'Bracing: equivalent horizontal forces φ × factored vertical load per floor level accumulate down the storeys, are applied in X and Y separately, shared equally by the bracing planes of the direction and by their braced bays. X-bracing is tension-only; chords of a braced bay take the panel shear as compression.',
  'Sections: area / inertia from the outline without root radii (about 4-5 % conservative), shear area h·tw, class 4 and angle / channel / cold-formed sections are reported as not analysed. γM0 = γM1 = 1.0; fy from the member grade (thickness ≤ 40 mm). Members with roof, wind or crane roles (rafter, purlin, rail, crane) are not analysed here.',
];

/**
 * @command check_steel_members
 * @pure read-only
 * @affects none; data = { ok, members: MemberRow[], totals, loads, storeys, warnings, csv }
 * @invariant every steel member of the model (or level filter) has exactly one row; utilisation 1.0 = at resistance
 * @failure negative loads / unknown level / no steel members -> no-op, no data
 */
export const checkSteelMembers = defineCommand({
  name: 'check_steel_members',
  annotations: { readOnly: true, idempotent: true },
  description:
    'General EN 1993-1-1 member verification of a steel structure built from add_steel_member (multi-storey ' +
    'process structures, pipe racks, platforms, halls), with the loads derived from the model: self weight, ' +
    'floor slabs (add_slab role floor) with dead + imposed load, equipment operating weight (add_equipment ' +
    'weight, kg), pipes (add_pipe_run, steel + contents) and cable trays resting on beams. ULS 1.35 G + 1.5 Q, ' +
    'SLS G + Q. Beams (role beam, horizontal) are simply supported between end nodes, with floor load shared by ' +
    'the 45° tributary rule and equipment by footprint area per bay; checked for bending (+ lateral-torsional ' +
    'buckling when nothing restrains the top flange), shear and deflection ≤ span/250. Columns are checked per ' +
    'storey segment between beam levels for Npl,Rd and flexural buckling Nb,Rd (Lcr = segment length). Braces ' +
    '(role brace, in an X or Y vertical plane) carry the EN 1993-1-1 §5.3.2 equivalent horizontal forces ' +
    '(notionalFactor × factored vertical load per level), tension-only in X-bracing, with slenderness ≤ 300; ' +
    'the horizontal members of a braced bay are checked as struts. Returns data.members: one row per steel ' +
    'member { id, mark, role, profile, check (governing check), utilisation (1.0 = at resistance), ok, ' +
    'governing (combination), detail, checks, forces } — members that cannot be analysed (profile not in the ' +
    'catalogue, class 4, roles rafter / purlin / rail / crane, inclined columns) appear with check "not ' +
    'analysed", ok false and the reason; data.ok is true only when every member is analysed and passes. ' +
    'data.warnings lists model gaps (equipment on grade, pipes resting on nothing, directions without bracing, ' +
    'beam ends bearing on nothing). Beam-column connections are assumed pinned; a preliminary check, not a ' +
    'substitute for the engineer of record. See data.loads.assumptions for every load-path rule.',
  params: z.object({
    floorDeadLoad: z
      .number()
      .optional()
      .describe(
        'Permanent load of floor gratings / finishes, kN/m², on every floor slab (add_slab role floor). Default 0.5.',
      ),
    imposedLoad: z
      .number()
      .optional()
      .describe(
        'Imposed load on floors, kN/m² (process-plant floors, EN 1991-1-1 category E-like), applied on the floor area not occupied by equipment. Default 5.0.',
      ),
    pipeContentDensity: z
      .number()
      .optional()
      .describe(
        'Density of the pipe contents, kg/m³: 1000 = water-filled (default, operating / hydrotest), 0 = empty pipes.',
      ),
    cableTrayWeight: z
      .number()
      .optional()
      .describe('Weight of a cable tray including its cables, kg per metre of run. Default 75.'),
    notionalFactor: z
      .number()
      .optional()
      .describe(
        'Equivalent horizontal force as a fraction of the factored vertical load at each floor level (EN 1993-1-1 §5.3.2 φ0 = 1/200 = 0.005, no αh / αm reduction). Default 0.005.',
      ),
    deflectionRatio: z
      .number()
      .optional()
      .describe('Beam deflection limit as span / n under G + Q. Default 250 (L/250).'),
    levelId: z
      .string()
      .optional()
      .describe(
        'Only report the members of this level id. The whole model is always analysed (column loads come from beams on other levels). Default: every level.',
      ),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const {
      floorDeadLoad = 0.5,
      imposedLoad = 5,
      pipeContentDensity = 1000,
      cableTrayWeight = 75,
      notionalFactor = 0.005,
      deflectionRatio = 250,
    } = params;
    const nonNegative = [floorDeadLoad, imposedLoad, pipeContentDensity, cableTrayWeight].every(
      (value) => isFiniteNumber(value) && value >= 0,
    );
    if (!nonNegative) {
      return noop(
        doc,
        'check_steel_members failed: floorDeadLoad, imposedLoad, pipeContentDensity and cableTrayWeight must be numbers >= 0.',
      );
    }
    if (!(isFiniteNumber(notionalFactor) && notionalFactor >= 0 && notionalFactor <= 0.1)) {
      return noop(doc, 'check_steel_members failed: notionalFactor must be a number in [0, 0.1].');
    }
    if (!(isFiniteNumber(deflectionRatio) && deflectionRatio > 0)) {
      return noop(doc, 'check_steel_members failed: deflectionRatio must be a number > 0.');
    }
    const building = getBuilding(doc);
    if (params.levelId !== undefined && !building.levels[params.levelId]) {
      return noop(doc, `check_steel_members failed: no level '${params.levelId}'.`);
    }
    const analysis = analyseSteelStructure(doc, {
      floorDeadLoad,
      imposedLoad,
      pipeContentDensity,
      cableTrayWeight,
      notionalFactor,
      deflectionRatio,
    });
    if (analysis.rows.length === 0) {
      return noop(
        doc,
        'check_steel_members failed: the model has no steel members (add_steel_member).',
      );
    }
    const members = analysis.rows.filter(
      (row) => params.levelId === undefined || row.levelId === params.levelId,
    );
    if (members.length === 0) {
      return noop(
        doc,
        `check_steel_members failed: level '${params.levelId ?? ''}' has no steel members.`,
      );
    }
    const analysed = members.filter((row) => row.analysed);
    const failing = analysed.filter((row) => !row.ok);
    const notAnalysed = members.filter((row) => !row.analysed);
    const worst = analysed.reduce<(typeof members)[number] | undefined>(
      (best, row) => (best === undefined || row.utilisation > best.utilisation ? row : best),
      undefined,
    );
    const steelMassKg = members.reduce((sum, row) => sum + (analysis.massKg.get(row.id) ?? 0), 0);
    const csv = toCsv(
      ['Mark', 'Role', 'Profile', 'Level', 'Check', 'Utilisation', 'Status', 'Governing', 'Detail'],
      members.map((row) => [
        row.mark,
        row.role,
        row.profile,
        row.levelId,
        row.check,
        row.utilisation,
        !row.analysed ? 'NOT ANALYSED' : row.ok ? 'OK' : 'FAIL',
        row.governing,
        row.detail,
      ]),
    );
    const list = (rows: typeof members): string =>
      `${rows
        .slice(0, 8)
        .map((row) => `${row.mark} ${row.profile}${row.analysed ? ` ${row.utilisation}` : ''}`)
        .join(', ')}${rows.length > 8 ? ', …' : ''}`;
    const summary =
      `Steel member check (G ${floorDeadLoad} + Q ${imposedLoad} kN/m² floors, φ ${notionalFactor}): ` +
      `${members.length} member(s), ${analysed.length} analysed, ${notAnalysed.length} not analysed; ` +
      `max utilisation ${worst?.utilisation ?? 0} (${worst?.mark ?? '—'} ${worst?.profile ?? ''}, ${worst?.check ?? '—'}); ` +
      (failing.length === 0
        ? 'all analysed members OK'
        : `${failing.length} failure(s): ${list(failing)}`) +
      (notAnalysed.length === 0 ? '' : `; not analysed: ${list(notAnalysed)}`) +
      (analysis.warnings.length === 0
        ? '.'
        : `; ${analysis.warnings.length} warning(s) in data.warnings.`);
    return {
      document: doc,
      summary,
      affected: [],
      data: {
        ok: failing.length === 0 && notAnalysed.length === 0,
        members,
        csv,
        totals: {
          members: members.length,
          analysed: analysed.length,
          notAnalysed: notAnalysed.length,
          failing: failing.length,
          maxUtilisation: worst?.utilisation ?? 0,
          maxUtilisationMark: worst?.mark ?? null,
          steelMassKg: round(steelMassKg, 1),
        },
        failures: failing.map((row) => row.id),
        notAnalysed: notAnalysed.map((row) => row.id),
        loads: {
          floorDeadLoad,
          imposedLoad,
          pipeContentDensity,
          cableTrayWeight,
          notionalFactor,
          deflectionRatio,
          floors: analysis.floors,
          equipment: analysis.equipment,
          lines: analysis.lines,
          assumptions: ASSUMPTIONS,
        },
        storeys: analysis.storeys,
        warnings: analysis.warnings,
      },
    };
  },
});
