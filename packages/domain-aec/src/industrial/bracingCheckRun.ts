/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fromMm, getBuilding, isFiniteNumber, noChange } from '../model';
import { toCsv } from '../scheduleBuild';
import { findProfile } from '../steel/profiles';
import { sectionResistance, yieldStrength } from './steelDesign';
import { craneCapacityOf } from './frameModelTypes';
import { DEFAULT_BUFFER_STIFFNESS, DEFAULT_TRAVEL_SPEED } from './runwayCheckModel';
import {
  type BracingRow,
  CP_GABLE,
  CP_POST,
  DEFAULT_CRANE_SPAN,
  EAVES_X_TOLERANCE,
  EAVES_Z_TOLERANCE,
  GAMMA_G,
  GAMMA_Q,
  type Located,
  NO_MEMBER_UTILISATION,
  type Panel,
  type Point,
  STABILITY_RATIO,
  TOLERANCE,
  bucklingResistance,
  craneWallForce,
  near,
} from './bracingModel';
import { round } from '../numeric';
import { failureSummary } from './checkReport';

/**
 * @command check_bracing
 * @pure read-only
 * @affects none; data = { rows: BracingRow[], csv, maxUtilisation, failures, windForce, ... }
 * @invariant ULS wind = 1.5 · qp · 1.3 · gable area; tension-only diagonals; Npl,Rd = A·fy
 * @failure negative loads / unknown level / no bracing / no rafters -> no data
 */
export const checkBracing = defineCommand({
  name: 'check_bracing',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary wind-bracing check of the steel hall on a level (members with role brace, e.g. from ' +
    'add_portal_frame_building). Longitudinal wind on the gable: ULS force = 1.5 · qp · (0.8 + 0.5) · ' +
    'gable area (span × eaves + roof triangle, from the end-frame rafters/columns). Half goes to the ' +
    'roof level and, with the EN 1993-1-1 §5.3.3 equivalent stabilising force (1/200 of the roof ULS ' +
    'vertical load 1.35 deadLoad + 1.5 snowLoad), is carried by the roof X-bracing as a horizontal ' +
    'truss, shared equally by the braced end bays; the roof reactions go to the wall X-bracing. ' +
    'Diagonals are tension-only: one per X carries the panel shear / cos θ, checked against ' +
    'Npl,Rd = A·fy (γM0 = 1, net = gross for welded ends). The transverse component is carried in ' +
    'compression by the rafter (roof) or column (wall), checked for minor-axis buckling χ·Npl,Rd ' +
    'with Lcr = bay length. Gable posts: net pressure cpe + cpi = 0.8 + 0.2 = 1.0 on one wall, simply supported bending ' +
    'q·tributary·h²/8 vs Mpl and shear. The roof truss spans the full hall width on the two outer ' +
    'walls: panel shear V = w·(W/2 − d) (w = bay force / W, d = distance of the panel edge from the ' +
    'nearest wall), so wall-side panels carry about half the bay force. Struts: wall = column, Lcr = ' +
    'column height; roof = rafter, Lcr = purlin gap along the rafter; plus the eaves purlin carrying ' +
    'the truss reaction (bay force / 2) with Lcr = bay length (row flagged utilisation 99 if absent). ' +
    'On multi-span halls the internal column lines carry no wall bracing, so the roof truss still spans ' +
    'the full hall width and the reaction (bay force / 2) acts at the two OUTER wall lines only: the ' +
    'eaves-strut force equals that of a single-span hall of the same gable area (it grows with the gable, ' +
    'e.g. a monopitch gable is larger than a duopitch one), and a light eaves purlin such as the default ' +
    'C200x75x2.5 over a 6 m bay (about 36 kN) can fail at qp above about 0.7 kN/m²: fit a heavier eaves ' +
    'purlin (update_steel_member) rather than treating the force as an error.' +
    ' Crane longitudinal path (runway beams, role crane, on a long wall): per runway line the force at rail level is max(1.35 HL,i = ' +
    '1.35 φ5 K/nr of groups 1/5, HB,1/nr of group 7 with accidental γ = 1.0, HB,1 = 1.25 · 0.7 travelSpeed · √(mc SB), crane mass only) ' +
    'and is added to the shear of the wall X-bracing panels on that side (shared equally by the braced bays of that wall; ' +
    'assumes the existing wall X-bracing takes it, no separate crane bracing below the rail). Rows "crane longitudinal (group 1 / group 7)" ' +
    'report the crane-only part; data.crane gives the horizontal force (along y) at the foundations of the braced-bay columns. ' +
    'Rows are grouped (roof bracing, wall bracing per side, gable posts); utilisation > 1 ' +
    'fails. Not covered: frame action, uplift, self-weight, connections - a preliminary check.',
  params: z.object({
    windPressure: z
      .number()
      .optional()
      .describe(
        'Peak velocity pressure qp, kN/m² (EN 1991-1-4). Default 0.6. Frame gable coefficient 0.8 + 0.5; gable posts use net cpe + cpi = 0.8 + 0.2.',
      ),
    deadLoad: z
      .number()
      .optional()
      .describe('Roof dead load, kN/m², for the stabilising force only. Default 0.5.'),
    snowLoad: z
      .number()
      .optional()
      .describe('Roof snow load, kN/m², for the stabilising force only. Default 0.8.'),
    craneCapacity: z
      .number()
      .optional()
      .describe(
        'Crane capacity in tonnes (> 0) for the crane longitudinal force. Default: read from the runway beam notes (add_crane_runway); no runway and no value = no crane force.',
      ),
    craneSelfWeight: z
      .number()
      .optional()
      .describe('Crane self-weight Gc in kN (> 0). Default 0.5 Q + 20 kN.'),
    travelSpeed: z
      .number()
      .optional()
      .describe(
        'Crane long travel speed in m/s (> 0) for the buffer force (v1 = 0.7 × travelSpeed). Default 0.63 (about 38 m/min).',
      ),
    bufferStiffness: z
      .number()
      .optional()
      .describe('Buffer spring constant SB in kN/m (> 0). Default 1000.'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const { windPressure = 0.6, deadLoad = 0.5, snowLoad = 0.8 } = params;
    const nonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
    if (!nonNegative(windPressure) || !nonNegative(deadLoad) || !nonNegative(snowLoad)) {
      return noChange(doc, 'check_bracing failed: windPressure, deadLoad, snowLoad must be >= 0.');
    }
    const { travelSpeed = DEFAULT_TRAVEL_SPEED, bufferStiffness = DEFAULT_BUFFER_STIFFNESS } =
      params;
    for (const [name, value] of [
      ['craneCapacity', params.craneCapacity],
      ['craneSelfWeight', params.craneSelfWeight],
      ['travelSpeed', travelSpeed],
      ['bufferStiffness', bufferStiffness],
    ] as const) {
      if (value !== undefined && !(isFiniteNumber(value) && value > 0)) {
        return noChange(doc, `check_bracing failed: ${name} must be a number > 0.`);
      }
    }
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
    if (levelId === undefined || !building.levels[levelId]) {
      return noChange(doc, `check_bracing failed: no level '${params.levelId ?? ''}'.`);
    }
    const unit = fromMm(doc, 1);
    const members: Located[] = [];
    for (const id of building.elementOrder) {
      const element = building.elements[id];
      if (element?.category !== 'member' || element.levelId !== levelId) continue;
      const profile = findProfile(element.profile);
      if (!profile) continue;
      const toMm = (point: readonly number[]): Point => [
        (point[0] ?? 0) / unit,
        (point[1] ?? 0) / unit,
        (point[2] ?? 0) / unit,
      ];
      members.push({
        member: element,
        profile,
        start: toMm(element.start),
        end: toMm(element.end),
      });
    }
    const braces = members.filter(({ member }) => member.role === 'brace');
    const rafters = members.filter(({ member }) => member.role === 'rafter');
    if (braces.length === 0) {
      return noChange(doc, `check_bracing: no bracing (role brace) on level '${levelId}'.`);
    }
    if (rafters.length === 0) {
      return noChange(doc, `check_bracing failed: no rafters on level '${levelId}' (no gable).`);
    }

    // Hall envelope from the end frame (rafter plane y0) and the frame columns.
    const rafterEnds = rafters.flatMap(({ start, end }) => [start, end]);
    const ys = rafterEnds.map((point) => point[1]);
    const y0 = Math.min(...ys);
    const yEnd = Math.max(...ys);
    const xs = rafterEnds.map((point) => point[0]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const centre = (x0 + x1) / 2;
    const gableAreaMm2 = rafters
      .filter(({ start, end }) => near(start[1], y0) && near(end[1], y0))
      .reduce(
        (sum, { start, end }) => sum + Math.abs(end[0] - start[0]) * ((start[2] + end[2]) / 2),
        0,
      );
    const gableArea = gableAreaMm2 / 1e6;
    const planArea = ((x1 - x0) * (yEnd - y0)) / 1e6;
    const windUltimate = GAMMA_Q * windPressure * CP_GABLE * gableArea;
    const roofWind = windUltimate / 2;
    const stability = (GAMMA_G * deadLoad + GAMMA_Q * snowLoad) * planArea * STABILITY_RATIO;
    const roofForce = roofWind + stability;

    // Braced panels: roof (diagonal plan x-extent > 0) and walls (vertical plane), per bay.
    const panels = new Map<string, Panel>();
    for (const located of braces) {
      const { start, end } = located;
      const roof = !near(start[0], end[0]);
      const bay = `${round(Math.min(start[1], end[1]), 0)}-${round(Math.max(start[1], end[1]), 0)}`;
      const xLow = round(Math.min(start[0], end[0]), 0);
      const xHigh = round(Math.max(start[0], end[0]), 0);
      const side = start[0] <= centre ? 'west' : 'east';
      const key = roof ? `roof|${bay}|${xLow}|${xHigh}` : `wall|${bay}|${xLow}`;
      const panel = panels.get(key) ?? {
        group: roof ? 'roof bracing' : `wall bracing ${side}`,
        roof,
        bay,
        braces: [],
      };
      panel.braces.push(located);
      panels.set(key, panel);
    }
    const bays = new Set([...panels.values()].map((panel) => panel.bay));
    const bayWallPanels = (bay: string): number =>
      [...panels.values()].filter((panel) => panel.bay === bay && !panel.roof).length;
    const bayForce = roofForce / bays.size;

    // Crane longitudinal path: one runway line per carrying wall, force at rail level.
    const runways = members.filter(({ member }) => member.role === 'crane');
    const craneCapacity =
      params.craneCapacity ??
      runways.map(({ member }) => craneCapacityOf(member)).find((value) => value !== null) ??
      null;
    const runwayXs = runways.map(({ start }) => start[0]);
    const craneSpan =
      runwayXs.length > 0 && Math.max(...runwayXs) - Math.min(...runwayXs) > 1000
        ? Math.max(...runwayXs) - Math.min(...runwayXs)
        : DEFAULT_CRANE_SPAN;
    const craneForce =
      craneCapacity !== null && runways.length > 0
        ? craneWallForce(
            craneCapacity,
            craneSpan,
            params.craneSelfWeight,
            travelSpeed,
            bufferStiffness,
          )
        : null;
    const craneSides = new Set(runways.map(({ start }) => (start[0] <= centre ? 'west' : 'east')));
    const wallPanelsOnSide = (side: string): number =>
      [...panels.values()].filter((panel) => panel.group === `wall bracing ${side}`).length;
    const craneShareOf = (panel: Panel): number => {
      const side = panel.group.endsWith('west') ? 'west' : 'east';
      return craneForce !== null && !panel.roof && craneSides.has(side)
        ? craneForce.design / wallPanelsOnSide(side)
        : 0;
    };
    const craneFoundation: { side: string; braced: number; total: number; perColumn: number }[] =
      [];

    // Roof strut = rafter braced laterally by purlins: largest purlin gap along the slope.
    const purlins = members.filter(({ member }) => member.role === 'purlin');
    const purlinGapAlong = (rafter: Located, bayStart: number, bayEnd: number): number => {
      const [from, to] = [
        Math.min(rafter.start[0], rafter.end[0]),
        Math.max(rafter.start[0], rafter.end[0]),
      ];
      const slope = Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[2] - rafter.start[2]);
      const cosine = Math.abs(rafter.end[0] - rafter.start[0]) / slope;
      const positions = purlins
        .filter(
          ({ start: s, end: e }) =>
            near(Math.min(s[1], e[1]), bayStart) &&
            near(Math.max(s[1], e[1]), bayEnd) &&
            s[0] >= from - EAVES_X_TOLERANCE &&
            s[0] <= to + EAVES_X_TOLERANCE,
        )
        .map(({ start: s }) => s[0])
        .sort((a, b) => a - b);
      const gaps = positions.slice(1).map((position, index) => position - (positions[index] ?? 0));
      return gaps.length === 0 ? slope : Math.max(...gaps) / cosine;
    };

    const rows: BracingRow[] = [];
    const sorted = [...panels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, panel] of sorted) {
      const diagonal = panel.braces.reduce((best, candidate) =>
        Math.hypot(...candidate.start.map((v, i) => v - (candidate.end[i] ?? 0))) >
        Math.hypot(...best.start.map((v, i) => v - (best.end[i] ?? 0)))
          ? candidate
          : best,
      );
      const { start, end, profile, member } = diagonal;
      const [dx, dy, dz] = [
        Math.abs(end[0] - start[0]),
        Math.abs(end[1] - start[1]),
        Math.abs(end[2] - start[2]),
      ];
      if (dy < TOLERANCE) continue;
      const length = Math.hypot(dx, dy, dz);
      const xLow = Math.min(start[0], end[0]);
      const xHigh = Math.max(start[0], end[0]);
      const hallWidth = x1 - x0;
      const craneShare = craneShareOf(panel);
      const shear = panel.roof
        ? (bayForce * (hallWidth / 2 - Math.max(0, Math.min(xLow - x0, x1 - xHigh)))) / hallWidth
        : bayForce / bayWallPanels(panel.bay) + craneShare;
      const tension = (shear * length) / dy;
      const fy = yieldStrength(member.material);
      const npl = sectionResistance(profile, fy).axial / 1000;
      const ids = panel.braces.map(({ member: brace }) => brace.id);
      rows.push({
        group: panel.group,
        elementId: member.id,
        elementIds: ids,
        mark: member.mark,
        kind: 'diagonal',
        force: tension,
        resistance: npl,
        moment: 0,
        momentResistance: 0,
        utilisation: tension / npl,
        check: `tension-only ${member.profile}: V ${shear.toFixed(1)} kN / cos θ ${(dy / length).toFixed(2)} = ${tension.toFixed(1)} kN ≤ Npl,Rd ${npl.toFixed(1)} kN (bay ${panel.bay} mm)`,
      });
      if (craneForce !== null && craneShare > 0) {
        const craneTension = (craneShare * length) / dy;
        const side = panel.group.endsWith('west') ? 'west' : 'east';
        rows.push({
          group: panel.group,
          elementId: member.id,
          elementIds: ids,
          mark: member.mark,
          kind: 'diagonal',
          force: craneTension,
          resistance: npl,
          moment: 0,
          momentResistance: 0,
          utilisation: craneTension / npl,
          check: `crane longitudinal (group 1 / group 7): ${craneForce.governing} governs, 1.35 HL ${craneForce.driveGroup1.toFixed(1)} kN vs HB (γ 1.0) ${craneForce.bufferGroup7.toFixed(1)} kN per runway, share ${craneShare.toFixed(1)} kN on bay ${panel.bay} mm, tension ${craneTension.toFixed(1)} kN ≤ Npl,Rd ${npl.toFixed(1)} kN (included in the wall bracing row above)`,
        });
        craneFoundation.push({
          side,
          braced: wallPanelsOnSide(side),
          total: craneShare,
          perColumn: craneShare / 2,
        });
      }
      // Compression strut: rafter (roof) / column (wall) at either end of the bay.
      const [bayStart, bayEnd] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])];
      const strut = panel.roof
        ? rafters.find(
            ({ start: s, end: e }) =>
              (near(s[1], bayStart) || near(s[1], bayEnd)) &&
              near(s[1], e[1]) &&
              near(Math.min(s[0], e[0]), xLow) &&
              near(Math.max(s[0], e[0]), xHigh),
          )
        : members.find(
            ({ member: candidate, start: s }) =>
              candidate.role === 'column' &&
              near(s[0], start[0]) &&
              (near(s[1], bayStart) || near(s[1], bayEnd)),
          );
      if (strut) {
        const compression = panel.roof ? (shear * dx) / dy : (shear * dz) / dy;
        const strutFy = yieldStrength(strut.member.material);
        const purlinGap = purlinGapAlong(strut, bayStart, bayEnd);
        const strutLength = panel.roof ? purlinGap : dz;
        const strutResistance = bucklingResistance(strut.profile, strutFy, strutLength) / 1000;
        rows.push({
          group: panel.group,
          elementId: strut.member.id,
          elementIds: [strut.member.id],
          mark: strut.member.mark,
          kind: 'strut',
          force: compression,
          resistance: strutResistance,
          moment: 0,
          momentResistance: 0,
          utilisation: compression / strutResistance,
          check: `${panel.roof ? 'rafter' : 'column'} ${strut.member.profile} compression ${compression.toFixed(1)} kN ≤ χ·Npl,Rd ${strutResistance.toFixed(1)} kN (minor axis, Lcr ${strutLength.toFixed(0)} mm${panel.roof ? ', purlin gap' : ', column height'})`,
        });
      }

      // Eaves purlin at the wall end of the roof truss: carries the truss reaction in compression.
      const atWall = panel.roof && (near(xLow, x0) || near(xHigh, x1));
      if (atWall) {
        const wallX = near(xLow, x0) ? x0 : x1;
        // Eaves level of this wall (monopitch: the low and the high eaves differ).
        const eavesZ = Math.min(
          ...rafterEnds.filter((point) => near(point[0], wallX)).map((point) => point[2]),
        );
        const eavesStrut = members.find(
          ({ member: candidate, start: s, end: e }) =>
            candidate.role === 'purlin' &&
            Math.abs(s[0] - wallX) < EAVES_X_TOLERANCE &&
            near(Math.min(s[1], e[1]), bayStart) &&
            near(Math.max(s[1], e[1]), bayEnd) &&
            Math.abs(s[2] - eavesZ) < EAVES_Z_TOLERANCE,
        );
        const reaction = bayForce / 2;
        const fyEaves = eavesStrut ? yieldStrength(eavesStrut.member.material) : 0;
        const eavesResistance = eavesStrut
          ? bucklingResistance(eavesStrut.profile, fyEaves, dy) / 1000
          : 0;
        rows.push({
          group: panel.group,
          elementId: eavesStrut?.member.id ?? member.id,
          elementIds: [eavesStrut?.member.id ?? member.id],
          mark: eavesStrut?.member.mark ?? member.mark,
          kind: 'strut',
          force: reaction,
          resistance: eavesResistance,
          moment: 0,
          momentResistance: 0,
          utilisation: eavesStrut ? reaction / eavesResistance : NO_MEMBER_UTILISATION,
          check: eavesStrut
            ? `eaves strut ${eavesStrut.member.profile} compression ${reaction.toFixed(1)} kN (truss reaction at the outer wall line, independent of the number of spans) ≤ χ·Npl,Rd ${eavesResistance.toFixed(1)} kN (minor axis, Lcr ${dy.toFixed(0)} mm bay)`
            : `no eaves strut found at x ${round(wallX, 0)} mm in bay ${panel.bay} mm: truss reaction ${reaction.toFixed(1)} kN has no compression member`,
        });
      }
    }

    // Gable wind posts: columns in a gable plane that do not meet a rafter end (frame columns do).
    const meetsRafter = ({ start, end }: Located): boolean =>
      rafterEnds.some(
        (point) => near(point[0], end[0]) && near(point[1], end[1]) && near(point[2], end[2]),
      ) ||
      rafterEnds.some(
        (point) => near(point[0], start[0]) && near(point[1], start[1]) && near(point[2], start[2]),
      );
    const columns = members.filter(({ member }) => member.role === 'column');
    for (const planeY of [y0, yEnd]) {
      const inPlane = columns
        .filter(({ start }) => near(start[1], planeY))
        .sort((a, b) => a.start[0] - b.start[0]);
      inPlane.forEach((post, index) => {
        if (meetsRafter(post)) return;
        const left = inPlane[index - 1]?.start[0] ?? post.start[0];
        const right = inPlane[index + 1]?.start[0] ?? post.start[0];
        const tributary = (right - left) / 2 / 1000;
        const height = Math.abs(post.end[2] - post.start[2]) / 1000;
        const load = GAMMA_Q * windPressure * CP_POST * tributary;
        const fy = yieldStrength(post.member.material);
        const resistance = sectionResistance(post.profile, fy);
        const moment = (load * height * height) / 8;
        const reaction = (load * height) / 2;
        const momentResistance = resistance.moment / 1e6;
        const shearResistance = resistance.shear / 1000;
        rows.push({
          group: 'gable posts',
          elementId: post.member.id,
          elementIds: [post.member.id],
          mark: post.member.mark,
          kind: 'gable-post',
          force: reaction,
          resistance: shearResistance,
          moment,
          momentResistance,
          utilisation: Math.max(moment / momentResistance, reaction / shearResistance),
          check: `${post.member.profile} (y ${round(planeY, 0)} mm): q ${load.toFixed(2)} kN/m, h ${height.toFixed(2)} m, M ${moment.toFixed(1)} ≤ Mpl,Rd ${momentResistance.toFixed(1)} kNm, V ${reaction.toFixed(1)} ≤ Vpl,Rd ${shearResistance.toFixed(1)} kN`,
        });
      });
    }

    const worst = rows.reduce<BracingRow | null>(
      (best, row) => (best === null || row.utilisation > best.utilisation ? row : best),
      null,
    );
    const failures = rows.filter((row) => row.utilisation > 1);
    const csv = toCsv(
      [
        'Group',
        'Mark',
        'Type',
        'Force (kN)',
        'Resistance (kN)',
        'M (kNm)',
        'Utilisation',
        'Status',
        'Check',
      ],
      rows.map((row) => [
        row.group,
        row.mark,
        row.kind,
        round(row.force, 1),
        round(row.resistance, 1),
        round(row.moment, 1),
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.check,
      ]),
    );
    return {
      document: doc,
      summary:
        `Bracing check (qp ${windPressure} kN/m², G ${deadLoad}, S ${snowLoad}): gable ${round(gableArea, 1)} m², ` +
        `ULS wind ${round(windUltimate, 1)} kN, roof level ${round(roofWind, 1)} kN + stability ${round(stability, 1)} kN ` +
        `over ${bays.size} braced bay(s) = ${round(bayForce, 1)} kN each; ${rows.length} check(s), ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'} ${worst?.kind ?? ''}, ${worst?.group ?? '—'}); ` +
        failureSummary(
          failures,
          (row) => `${row.mark} ${row.kind}`,
          'all OK (preliminary, tension-only diagonals).',
        ),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: [...new Set(failures.flatMap((row) => row.elementIds))],
        gableArea,
        windForce: windUltimate,
        roofForce,
        stabilityForce: stability,
        bracedBays: bays.size,
        crane:
          craneForce === null
            ? null
            : {
                ...craneForce,
                capacityTonnes: craneCapacity,
                spanMm: craneSpan,
                runwaySides: [...craneSides],
                foundationHorizontalY: craneFoundation,
              },
      },
    };
  },
});
