/**
 * Portal frame verification: 2D frame analysis of every frame + EN 1993 resistance checks of
 * its members (cross-section) and bolted moment connections (bolt tension / shear).
 * @layer core/commands/building/industrial
 */

import type {
  BuildingModel,
  MomentConnectionElement,
  SteelMemberElement,
} from '../../../model/building';
import type { CadDocument, Vec3 } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import {
  solveFrame,
  type FrameMember,
  type FrameNode,
  type MemberResult,
} from '../../../../lib/frame2d';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  noChange,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { refitPlates } from './plates';
import {
  findProfile,
  sectionProperties,
  STEEL_PROFILES,
  type SteelProfile,
} from '../steel/profiles';
import { toCsv } from '../quantities';
import { connectionSolids } from './evaluate';
import { sweepFrame } from '../mesh';

const E_STEEL = 210000; // N/mm²
const GAMMA_M2 = 1.25;
const BOLT_FUB = 800; // grade 8.8, N/mm²
/** Tensile stress areas of metric bolts, mm² (ISO 898-1). */
const STRESS_AREA: Readonly<Record<number, number>> = {
  12: 84.3,
  16: 157,
  20: 245,
  22: 303,
  24: 353,
  27: 459,
  30: 561,
  36: 817,
};

/** Yield strength from a grade name ("S355" → 355 N/mm²); 355 when unknown. */
export function yieldStrength(grade: string): number {
  const value = Number(/S\s*(\d{3})/i.exec(grade)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : 355;
}

/** Design resistances of one grade 8.8 bolt (EN 1993-1-8 Tab. 3.4), N. */
export function boltResistance(diameterMm: number): { tension: number; shear: number } {
  const nominal = Object.keys(STRESS_AREA)
    .map(Number)
    .reduce((best, size) =>
      Math.abs(size - diameterMm) < Math.abs(best - diameterMm) ? size : best,
    );
  const area = STRESS_AREA[nominal] as number;
  return {
    tension: (0.9 * BOLT_FUB * area) / GAMMA_M2,
    shear: (0.6 * BOLT_FUB * area) / GAMMA_M2,
  };
}

/**
 * Cross-section resistances (EN 1993-1-1 §6.2, γM0 = 1): Npl, Mpl (class 1–2) or Mel (class 3),
 * Vpl with Av ≈ h·tw; classification of I-sections in bending (Tab. 5.2), other shapes class 1.
 * Section properties from the outline (no root radii, ≈ 4–5 % conservative).
 */
export function sectionResistance(
  profile: SteelProfile,
  fy: number,
): { axial: number; moment: number; shear: number; sectionClass: 1 | 2 | 3 | 4 } {
  const section = sectionProperties(profile);
  const epsilon = Math.sqrt(235 / fy);
  let sectionClass: 1 | 2 | 3 | 4 = 1;
  if (profile.shape === 'I') {
    const flange = (profile.b - profile.tw) / 2 / profile.tf / epsilon;
    const web = (profile.h - 2 * profile.tf) / profile.tw / epsilon;
    const flangeClass = flange <= 9 ? 1 : flange <= 10 ? 2 : flange <= 14 ? 3 : 4;
    const webClass = web <= 72 ? 1 : web <= 83 ? 2 : web <= 124 ? 3 : 4;
    sectionClass = Math.max(flangeClass, webClass) as 1 | 2 | 3 | 4;
  }
  const shearArea = profile.shape === 'I' ? profile.h * profile.tw : section.area / 2;
  return {
    axial: section.area * fy,
    moment: (sectionClass <= 2 ? section.plasticModulus : section.elasticModulus) * fy,
    shear: (shearArea * fy) / Math.sqrt(3),
    sectionClass,
  };
}

export interface CheckRow {
  readonly frame: string;
  readonly elementId: string;
  readonly mark: string;
  readonly kind: 'column' | 'rafter' | 'connection';
  /** kN. */
  readonly axial: number;
  /** kNm. */
  readonly moment: number;
  /** kN. */
  readonly shear: number;
  readonly utilisation: number;
  readonly check: string;
  /** Connections only: signed design moment (N·mm, sagging +) and shear (N) at the joint. */
  readonly forces?: { readonly moment: number; readonly shear: number };
}

interface FrameModel {
  readonly label: string;
  readonly nodes: FrameNode[];
  readonly members: FrameMember[];
  readonly memberIds: string[];
  /** True when the analysis member runs end → start of the element (kept left → right). */
  readonly reversed: boolean[];
}

/**
 * Frames of a level: steel rafters in vertical planes y = const with the columns under their ends.
 * Planes are grouped per hall (overlapping rafter x-ranges) for tributary widths; a hall with a
 * single frame plane has no tributary width and is reported in `skipped`.
 */
function framesOf(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: { readonly line: (tributary: number) => number },
): { frames: FrameModel[]; skipped: string[] } {
  const mm = (value: number): number => value / fromMm(doc, 1);
  const tolerance = 10;
  const members = Object.values(building.elements).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.levelId === levelId,
  );
  const rafters = members.filter(
    (member) =>
      member.role === 'rafter' && Math.abs(mm(member.start[1] - member.end[1])) < tolerance,
  );
  const planeOf = (member: SteelMemberElement): number => Math.round(mm(member.start[1]));
  const xRange = (member: SteelMemberElement): [number, number] => [
    Math.min(mm(member.start[0]), mm(member.end[0])),
    Math.max(mm(member.start[0]), mm(member.end[0])),
  ];
  // Frame candidates: rafters of one plane chained by touching / overlapping x-ranges.
  interface Candidate {
    readonly y: number;
    range: [number, number];
    readonly rafters: SteelMemberElement[];
  }
  const candidates: Candidate[] = [];
  for (const y of [...new Set(rafters.map(planeOf))].sort((a, b) => a - b)) {
    const inPlane = rafters
      .filter((rafter) => planeOf(rafter) === y)
      .sort((a, b) => xRange(a)[0] - xRange(b)[0]);
    for (const rafter of inPlane) {
      const [low, high] = xRange(rafter);
      const last = candidates[candidates.length - 1];
      if (last && last.y === y && low <= last.range[1] + tolerance) {
        last.range = [last.range[0], Math.max(last.range[1], high)];
        last.rafters.push(rafter);
      } else {
        candidates.push({ y, range: [low, high], rafters: [rafter] });
      }
    }
  }
  // Halls: candidates (across planes) whose x-ranges overlap; tributary widths per hall.
  const hallOf = new Map<Candidate, Candidate[]>();
  for (const candidate of candidates) {
    const hall = [...new Set(hallOf.values())].find((members) =>
      members.some(
        (other) => candidate.range[0] < other.range[1] && candidate.range[1] > other.range[0],
      ),
    );
    if (hall) {
      hall.push(candidate);
      hallOf.set(candidate, hall);
    } else {
      hallOf.set(candidate, [candidate]);
    }
  }
  const tributaryOf = (candidate: Candidate): number => {
    const ys = [...new Set((hallOf.get(candidate) ?? [candidate]).map((other) => other.y))].sort(
      (a, b) => a - b,
    );
    const index = ys.indexOf(candidate.y);
    return ((ys[index + 1] ?? candidate.y) - (ys[index - 1] ?? candidate.y)) / 2;
  };
  const gridLabel = (y: number): string => {
    const grid = Object.values(building.elements).find(
      (element) =>
        element.category === 'grid' &&
        Math.abs(mm(element.start[1]) - y) < tolerance &&
        Math.abs(mm(element.end[1]) - y) < tolerance,
    );
    return grid ? `frame ${grid.mark}` : `frame y=${y}`;
  };
  const skipped: string[] = [];
  const frames = candidates.flatMap((candidate): FrameModel[] => {
    const { y } = candidate;
    const [low, high] = candidate.range;
    const tributary = tributaryOf(candidate);
    if (!(tributary > 0)) {
      skipped.push(`${gridLabel(y)} (single frame: no tributary width)`);
      return [];
    }
    const nodes: FrameNode[] = [];
    const nodeAt = (x: number, z: number, restraint: FrameNode['restraint']): number => {
      const found = nodes.findIndex(
        (node) => Math.abs(node.x - x) < tolerance && Math.abs(node.y - z) < tolerance,
      );
      if (found >= 0) return found;
      nodes.push({ x, y: z, restraint });
      return nodes.length - 1;
    };
    const frameMembers: FrameMember[] = [];
    const memberIds: string[] = [];
    const reversed: boolean[] = [];
    const free: FrameNode['restraint'] = [false, false, false];
    for (const rafter of candidate.rafters) {
      const profile = findProfile(rafter.profile);
      if (!profile) continue;
      const section = sectionProperties(profile);
      // Analyse left → right so the internal moment sign is global (sagging +) for every rafter.
      const flip = rafter.start[0] > rafter.end[0];
      const [first, second] = flip ? [rafter.end, rafter.start] : [rafter.start, rafter.end];
      const [x0, z0, x1, z1] = [mm(first[0]), mm(first[2]), mm(second[0]), mm(second[2])];
      const length = Math.hypot(x1 - x0, z1 - z0);
      // Roof load per horizontal length, spread along the rafter; plus self-weight.
      const roof = (loads.line(tributary) * Math.abs(x1 - x0)) / length;
      const selfWeight = ((profile.massPerMetre * 9.81) / 1000) * 1.35;
      frameMembers.push({
        a: nodeAt(x0, z0, free),
        b: nodeAt(x1, z1, free),
        E: E_STEEL,
        A: section.area,
        I: section.inertia,
        load: { qx: 0, qy: -(roof + selfWeight) },
      });
      memberIds.push(rafter.id);
      reversed.push(flip);
    }
    for (const column of members.filter(
      (member) =>
        member.role === 'column' &&
        Math.abs(mm(member.start[1]) - y) < tolerance &&
        Math.abs(mm(member.end[1]) - y) < tolerance &&
        mm(member.start[0]) > low - tolerance &&
        mm(member.start[0]) < high + tolerance,
    )) {
      const [bottom, top] =
        column.start[2] <= column.end[2] ? [column.start, column.end] : [column.end, column.start];
      const topNode = nodes.findIndex(
        (node) =>
          Math.abs(node.x - mm(top[0])) < tolerance && Math.abs(node.y - mm(top[2])) < tolerance,
      );
      const profile = findProfile(column.profile);
      if (topNode < 0 || !profile) continue; // gable posts under the rafter span are not analysed
      const section = sectionProperties(profile);
      frameMembers.push({
        a: nodeAt(mm(bottom[0]), mm(bottom[2]), [true, true, false]),
        b: topNode,
        E: E_STEEL,
        A: section.area,
        I: section.inertia,
        load: { qx: 0, qy: -((profile.massPerMetre * 9.81) / 1000) * 1.35 },
      });
      memberIds.push(column.id);
      reversed.push(column.start[2] > column.end[2]);
    }
    return frameMembers.length > 0
      ? [
          {
            label:
              candidates.filter((other) => other.y === y).length > 1
                ? `${gridLabel(y)} @x=${low}`
                : gridLabel(y),
            nodes,
            members: frameMembers,
            memberIds,
            reversed,
          },
        ]
      : [];
  });
  return { frames, skipped };
}

/** Elastic bolt-group check of an end-plate connection under (M, V); N, mm. */
export function connectionCheck(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
  moment: number,
  shear: number,
): { utilisation: number; check: string } | null {
  const level = building.levels[connection.levelId];
  const members: Record<string, SteelMemberElement | undefined> = {};
  for (const id of [connection.rafterId, connection.otherId]) {
    const element = building.elements[id];
    if (element?.category === 'member') members[id] = element;
  }
  const solids = level ? connectionSolids(doc, connection, members, level) : null;
  const plate = solids?.find((solid) => solid.part === 'plate');
  if (!solids || !plate) return null;
  const mm = (value: number): number => value / fromMm(doc, 1);
  const plateYs = plate.outline.map(([, y]) => mm(y));
  // Hogging (negative) moment: tension at the top, compression at the bottom edge.
  const compression = moment < 0 ? Math.min(...plateYs) : Math.max(...plateYs);
  const levers = solids
    .filter((solid) => solid.part.startsWith('bolt'))
    .map((bolt) => {
      const ys = bolt.outline.map(([, y]) => mm(y));
      return Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - compression);
    });
  if (levers.length === 0) return null;
  const sumSquares = levers.reduce((sum, lever) => sum + lever * lever, 0);
  const tension = (Math.abs(moment) * Math.max(...levers)) / sumSquares;
  const perBoltShear = Math.abs(shear) / levers.length;
  const resistance = boltResistance(mm(connection.boltDiameter));
  const tensionRatio = tension / resistance.tension;
  const combined = perBoltShear / resistance.shear + tension / (1.4 * resistance.tension);
  return {
    utilisation: Math.max(tensionRatio, combined),
    check: `bolt Ft ${(tension / 1000).toFixed(1)}/${(resistance.tension / 1000).toFixed(1)} kN, Fv+Ft ${combined.toFixed(2)}`,
  };
}

/**
 * Analyses and checks every portal frame of a level.
 * @pure
 */
export function checkFrames(
  doc: CadDocument,
  levelId: string,
  loads: { deadLoad: number; snowLoad: number },
): { rows: CheckRow[]; frames: number; skipped: string[] } {
  const building = getBuilding(doc);
  // ULS 1.35 G + 1.5 S, kN/m² → N/mm² (× tributary width in mm → N/mm).
  const area = (1.35 * loads.deadLoad + 1.5 * loads.snowLoad) * 1e-3;
  const { frames, skipped } = framesOf(doc, building, levelId, {
    line: (tributary) => area * tributary,
  });
  const rows: CheckRow[] = [];
  let unstable = 0;
  for (const frame of frames) {
    const result = solveFrame(frame.nodes, frame.members);
    if (!result) {
      skipped.push(`${frame.label} (unstable)`);
      unstable += 1;
      continue;
    }
    const byId = new Map<string, { forces: MemberResult; reversed: boolean }>();
    frame.memberIds.forEach((id, index) => {
      const member = building.elements[id];
      const forces = result.members[index];
      if (member?.category !== 'member' || !forces) return;
      byId.set(id, { forces, reversed: frame.reversed[index] === true });
      const profile = findProfile(member.profile);
      if (!profile) return;
      const resistance = sectionResistance(profile, yieldStrength(member.material));
      const shear = Math.max(...forces.shear.map(Math.abs));
      const bending = forces.maxAxial / resistance.axial + forces.maxMoment / resistance.moment;
      rows.push({
        frame: frame.label,
        elementId: id,
        mark: member.mark,
        kind: member.role === 'column' ? 'column' : 'rafter',
        axial: forces.maxAxial / 1000,
        moment: forces.maxMoment / 1e6,
        shear: shear / 1000,
        utilisation: Math.max(bending, shear / resistance.shear),
        check: `N/Npl + M/M${resistance.sectionClass <= 2 ? 'pl' : 'el'}, V/Vpl (${member.profile} class ${resistance.sectionClass}, ${member.material})`,
      });
    });
    for (const connection of Object.values(building.elements)) {
      if (connection.category !== 'connection') continue;
      const analysed = byId.get(connection.rafterId);
      if (!analysed) continue;
      const { forces } = analysed;
      // Map the rafter end to the analysis member end (members are analysed left → right).
      const end = (connection.end === 'start') !== analysed.reversed ? 0 : 1;
      const moment = forces.moment[end];
      const shear = forces.shear[end];
      const verdict = connectionCheck(doc, building, connection, moment, shear);
      if (!verdict) continue;
      rows.push({
        frame: frame.label,
        elementId: connection.id,
        mark: connection.mark,
        kind: 'connection',
        axial: Math.abs(forces.axial[end]) / 1000,
        moment: Math.abs(moment) / 1e6,
        shear: Math.abs(shear) / 1000,
        utilisation: verdict.utilisation,
        check: `${connection.kind}: ${verdict.check}`,
        forces: { moment, shear },
      });
    }
  }
  return { rows, frames: frames.length - unstable, skipped };
}

interface CheckPortalFramesParams {
  deadLoad?: number;
  snowLoad?: number;
  levelId?: string;
}

/**
 * @command check_portal_frames
 * @pure read-only
 * @affects none; data = { rows: CheckRow[], csv, maxUtilisation, failures }
 * @failure negative loads / unknown level / no frame -> no data
 */
export const checkPortalFrames: CommandDefinition<CheckPortalFramesParams> = {
  name: 'check_portal_frames',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Structural check of the steel portal frames of a level: each frame (rafters in a vertical ' +
    'plane + the columns under their ends, pinned bases) is solved as a 2D frame (direct stiffness ' +
    'method, section properties from the profile outline (no root radii)) under ULS 1.35 G + 1.5 S, with G = deadLoad (kN/m², roof ' +
    'build-up, purlins, services) + member self-weight and S = snowLoad (kN/m²) on the tributary ' +
    'width. Checks: member cross-section resistance N/Npl + M/Mpl (EN 1993-1-1 §6.2) and moment ' +
    'connection bolt tension / shear (EN 1993-1-8 Tab. 3.4, grade 8.8, elastic bolt group). ' +
    'Returns utilisations per element; values > 1 fail. Not covered: wind, crane loads, buckling, ' +
    'deflections — a preliminary design check, not a substitute for the engineer of record.',
  paramsSchema: {
    type: 'object',
    properties: {
      deadLoad: { type: 'number', description: 'Roof dead load, kN/m². Default 0.5.' },
      snowLoad: { type: 'number', description: 'Roof snow load, kN/m². Default 0.8.' },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
    },
    required: [],
  },
  run: (doc, { deadLoad = 0.5, snowLoad = 0.8, levelId }): CommandResult => {
    if (!(isFiniteNumber(deadLoad) && deadLoad >= 0 && isFiniteNumber(snowLoad) && snowLoad >= 0)) {
      return noChange(doc, 'check_portal_frames failed: deadLoad and snowLoad must be >= 0 kN/m².');
    }
    const building = getBuilding(doc);
    const resolved = levelId ?? building.activeLevelId ?? building.levelOrder[0];
    if (resolved === undefined || !building.levels[resolved]) {
      return noChange(doc, `check_portal_frames failed: no level '${levelId ?? ''}'.`);
    }
    const { rows, frames, skipped } = checkFrames(doc, resolved, { deadLoad, snowLoad });
    if (frames === 0) {
      return noChange(
        doc,
        `check_portal_frames failed: no analysable portal frame on the level${skipped.length > 0 ? ` (${skipped.join(', ')})` : ''}.`,
      );
    }
    const failures = rows.filter((row) => row.utilisation > 1);
    const worst = rows.reduce<CheckRow | null>(
      (best, row) => (best === null || row.utilisation > best.utilisation ? row : best),
      null,
    );
    const round = (value: number, digits = 2): number =>
      Math.round(value * 10 ** digits) / 10 ** digits;
    const columns = [
      'Frame',
      'Mark',
      'Type',
      'N (kN)',
      'M (kNm)',
      'V (kN)',
      'Utilisation',
      'Status',
      'Check',
    ];
    const csv = toCsv(
      columns,
      rows.map((row) => [
        row.frame,
        row.mark,
        row.kind,
        round(row.axial, 1),
        round(row.moment, 1),
        round(row.shear, 1),
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.check,
      ]),
    );
    return {
      document: doc,
      summary:
        `Checked ${frames} frame(s), ${rows.length} element(s) at ULS 1.35 G + 1.5 S (G = ${deadLoad} kN/m² + self-weight, S = ${snowLoad} kN/m²): ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'}, ${worst?.frame ?? '—'}); ` +
        (failures.length === 0
          ? 'all OK (cross-section and bolt checks only).'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.mark} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`) +
        `${skipped.length > 0 ? ` Not checked: ${skipped.join(', ')}.` : ''}`,
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: failures.map((row) => row.elementId),
      },
    };
  },
};

/**
 * Next heavier profile of the same family; at the top of the family, the lightest I-section
 * (IPE / HEA / HEB) with a larger plastic modulus. Null when nothing larger exists.
 */
export function nextProfile(name: string): string | null {
  const profile = findProfile(name);
  if (!profile) return null;
  const byMass = (a: { massPerMetre: number }, b: { massPerMetre: number }): number =>
    a.massPerMetre - b.massPerMetre;
  const sameFamily = STEEL_PROFILES.filter(
    (candidate) =>
      candidate.family === profile.family && candidate.massPerMetre > profile.massPerMetre,
  ).sort(byMass);
  if (sameFamily[0]) return sameFamily[0].name;
  if (profile.shape !== 'I') return null;
  const modulus = sectionProperties(profile).plasticModulus;
  const stronger = STEEL_PROFILES.filter(
    (candidate) =>
      candidate.shape === 'I' && sectionProperties(candidate).plasticModulus > modulus * 1.02,
  ).sort(byMass);
  return stronger[0]?.name ?? null;
}

const BOLT_SIZES_MM = [20, 24, 27, 30];

interface DesignPortalFramesParams {
  deadLoad?: number;
  snowLoad?: number;
  levelId?: string;
  targetUtilisation?: number;
}

/**
 * @command design_portal_frames
 * @pure
 * @affects up-sizes failing rafter / column profiles (all members of that role and section on the
 *          level, keeping frames uniform) and sizes the bolt groups of every moment connection
 * @failure bad loads / unknown level / no frame / no section large enough -> no-op or partial report
 */
export const designPortalFrames: CommandDefinition<DesignPortalFramesParams> = {
  name: 'design_portal_frames',
  description:
    'Preliminary design of the portal frames of a level under ULS 1.35 G + 1.5 S (same model as ' +
    'check_portal_frames): repeatedly analyses the frames and up-sizes the rafter / column sections ' +
    'that exceed targetUtilisation to the next heavier profile of the same family (uniformly for all ' +
    'frames), then sizes the bolt groups of the moment connections (bolt diameter M20–M30 and rows) ' +
    'per connection type. Reports every change and the final utilisations. Not covered: wind, crane ' +
    'loads, buckling, deflections.',
  paramsSchema: {
    type: 'object',
    properties: {
      deadLoad: { type: 'number', description: 'Roof dead load, kN/m². Default 0.5.' },
      snowLoad: { type: 'number', description: 'Roof snow load, kN/m². Default 0.8.' },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
      targetUtilisation: {
        type: 'number',
        description: 'Maximum accepted utilisation (0.5–1). Default 0.95.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const { deadLoad = 0.5, snowLoad = 0.8, targetUtilisation = 0.95 } = params;
    if (
      !(isFiniteNumber(deadLoad) && deadLoad >= 0 && isFiniteNumber(snowLoad) && snowLoad >= 0) ||
      !(isFiniteNumber(targetUtilisation) && targetUtilisation >= 0.5 && targetUtilisation <= 1)
    ) {
      return noChange(
        doc,
        'design_portal_frames failed: loads must be >= 0 kN/m² and targetUtilisation in [0.5, 1].',
      );
    }
    const building0 = getBuilding(doc);
    const levelId = params.levelId ?? building0.activeLevelId ?? building0.levelOrder[0];
    if (levelId === undefined || !building0.levels[levelId]) {
      return noChange(doc, `design_portal_frames failed: no level '${params.levelId ?? ''}'.`);
    }
    const loads = { deadLoad, snowLoad };
    let current = doc;
    const analysed = new Set<string>();
    const changes: string[] = [];
    const changed = new Set<string>();
    let limited = false;
    for (let iteration = 0; iteration < 15; iteration++) {
      const { rows, frames } = checkFrames(current, levelId, loads);
      if (frames === 0) {
        return noChange(
          doc,
          'design_portal_frames failed: no analysable portal frame on the level.',
        );
      }
      const building = getBuilding(current);
      for (const row of rows) if (row.kind !== 'connection') analysed.add(row.elementId);
      const groups = new Map<string, { role: string; profile: string }>();
      for (const row of rows) {
        if (row.kind === 'connection' || row.utilisation <= targetUtilisation) continue;
        const member = building.elements[row.elementId];
        if (member?.category !== 'member') continue;
        groups.set(`${member.role}:${member.profile}`, {
          role: member.role,
          profile: member.profile,
        });
      }
      if (groups.size === 0) break;
      let next = building;
      let progressed = false;
      for (const { role, profile } of groups.values()) {
        const larger = nextProfile(profile);
        if (!larger) {
          limited = true;
          continue;
        }
        progressed = true;
        changes.push(`${role}s ${profile} → ${larger}`);
        const resizedIds: string[] = [];
        for (const element of Object.values(next.elements)) {
          if (
            element.category !== 'member' ||
            !analysed.has(element.id) ||
            element.role !== role ||
            element.profile !== profile
          )
            continue;
          const resized: SteelMemberElement = { ...element, profile: larger };
          next = refitPlates(current, withElement(next, resized), resized, profile).building;
          changed.add(element.id);
          resizedIds.push(element.id);
        }
        const reseated = reseatDependents(current, next, resizedIds, profile, larger, analysed);
        next = reseated.building;
        for (const id of reseated.moved) changed.add(id);
      }
      current = { ...current, building: next };
      if (!progressed) break;
      if (iteration === 14) limited = true;
    }
    // Bolt groups: smallest bolt diameter / row count that passes for every connection of a kind.
    const { rows } = checkFrames(current, levelId, loads);
    let building = getBuilding(current);
    for (const kind of ['eaves', 'apex'] as const) {
      const targets = rows.filter((row) => {
        const element = building.elements[row.elementId];
        return element?.category === 'connection' && element.kind === kind && row.forces;
      });
      if (targets.length === 0) continue;
      let chosen: { rows: number; diameter: number } | null = null;
      // Fallback when nothing passes: the feasible group with the lowest worst utilisation.
      let best: { rows: number; diameter: number; worst: number } | null = null;
      search: for (const diameter of BOLT_SIZES_MM) {
        for (let boltRows = kind === 'eaves' ? 3 : 2; boltRows <= 6; boltRows++) {
          let worst = 0;
          let feasible = true;
          for (const row of targets) {
            const original = building.elements[row.elementId] as MomentConnectionElement;
            const trial: MomentConnectionElement = {
              ...original,
              boltRows,
              boltDiameter: fromMm(current, diameter),
            };
            const verdict = connectionCheck(
              current,
              withElement(building, trial),
              trial,
              row.forces?.moment ?? 0,
              row.forces?.shear ?? 0,
            );
            if (verdict === null || !rowSpacingOk(current, building, trial)) {
              feasible = false;
              break;
            }
            worst = Math.max(worst, verdict.utilisation);
          }
          if (!feasible) continue;
          if (best === null || worst < best.worst) best = { rows: boltRows, diameter, worst };
          if (worst <= targetUtilisation) {
            chosen = { rows: boltRows, diameter };
            break search;
          }
        }
      }
      if (!chosen && best) {
        limited = true;
        chosen = { rows: best.rows, diameter: best.diameter };
      }
      if (!chosen) continue;
      changes.push(`${kind} connections: ${chosen.rows * 2} × M${chosen.diameter}`);
      for (const row of targets) {
        const original = building.elements[row.elementId] as MomentConnectionElement;
        if (
          original.boltRows === chosen.rows &&
          original.boltDiameter === fromMm(current, chosen.diameter)
        ) {
          continue;
        }
        building = withElement(building, {
          ...original,
          boltRows: chosen.rows,
          boltDiameter: fromMm(current, chosen.diameter),
        });
        changed.add(original.id);
      }
    }
    if (changed.size === 0) {
      const final = checkFrames(doc, levelId, loads);
      const worst = Math.max(0, ...final.rows.map((row) => row.utilisation));
      return {
        document: doc,
        summary: `Designed ${final.frames} frame(s): no change needed (max utilisation ${worst.toFixed(2)}${limited ? '; largest available size reached for some elements' : ''}).`,
        affected: [],
        data: {
          changes: [],
          maxUtilisation: worst,
          failures: final.rows.filter((row) => row.utilisation > 1).length,
        },
      };
    }
    const document = regenerateBuilding(doc, building);
    const final = checkFrames(document, levelId, loads);
    const unanalysedPosts = Object.values(building.elements).some(
      (element) =>
        element.category === 'member' &&
        element.levelId === levelId &&
        element.role === 'column' &&
        !analysed.has(element.id),
    );
    const worst = Math.max(0, ...final.rows.map((row) => row.utilisation));
    const failures = final.rows.filter((row) => row.utilisation > 1).length;
    return {
      document,
      summary:
        `Designed ${final.frames} frame(s) for ULS 1.35 G + 1.5 S (G = ${deadLoad}, S = ${snowLoad} kN/m²): ` +
        `${changes.length > 0 ? changes.join('; ') : 'no change needed'}. ` +
        `Max utilisation now ${worst.toFixed(2)}${failures > 0 ? `, ${failures} element(s) still failing` : ''}` +
        `${limited ? ' (largest available size reached for some elements)' : ''}. ` +
        `Cross-section and bolt checks only (no buckling, wind, crane loads or deflections)` +
        `${unanalysedPosts ? '; gable posts are not analysed' : ''}.`,
      affected: elementAffected(document, [...changed]),
      data: { changes, maxUtilisation: worst, failures },
    };
  },
};

/**
 * Members placed from a resized member's depth follow it: purlins on a rafter move along the
 * rafter normal, gable-post tops drop under a deeper rafter, side rails move out with a deeper
 * column (by half the depth change).
 */
function reseatDependents(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  resizedIds: ReadonlyArray<string>,
  before: string,
  after: string,
  analysed: ReadonlySet<string>,
): { building: BuildingModel; moved: string[] } {
  const [old, larger] = [findProfile(before), findProfile(after)];
  if (!old || !larger || resizedIds.length === 0) return { building, moved: [] };
  const half = fromMm(doc, larger.h - old.h) / 2;
  const tolerance = fromMm(doc, 10);
  const resized = resizedIds
    .map((id) => building.elements[id])
    .filter((element): element is SteelMemberElement => element?.category === 'member');
  const onPlane = (member: SteelMemberElement, y: number): boolean =>
    Math.abs(member.start[1] - y) < tolerance && Math.abs(member.end[1] - y) < tolerance;
  const shift = (point: Vec3, by: Vec3): Vec3 => [
    point[0] + by[0],
    point[1] + by[1],
    point[2] + by[2],
  ];
  let next = building;
  const moved: string[] = [];
  for (const element of Object.values(building.elements)) {
    if (element.category !== 'member' || analysed.has(element.id)) continue;
    let offset: Vec3 | null = null;
    let topOnly = false;
    if (element.role === 'purlin' || element.role === 'column') {
      // Purlins span between frame planes; gable posts stand in one.
      const rafter = resized.find((candidate) => {
        if (candidate.role !== 'rafter') return false;
        const y = candidate.start[1];
        const inPlane =
          element.role === 'purlin'
            ? Math.abs(element.start[1] - y) < tolerance || Math.abs(element.end[1] - y) < tolerance
            : onPlane(element, y);
        const [low, high] = [
          Math.min(candidate.start[0], candidate.end[0]),
          Math.max(candidate.start[0], candidate.end[0]),
        ];
        // Gable posts stand strictly inside the rafter span (frame columns sit at its ends).
        const margin = element.role === 'purlin' ? -fromMm(doc, larger.h) : tolerance;
        return inPlane && element.start[0] > low + margin && element.start[0] < high - margin;
      });
      const frame = rafter ? sweepFrame(rafter.start, rafter.end, rafter.roll) : null;
      if (frame && element.role === 'purlin')
        offset = [frame.v[0] * half, frame.v[1] * half, frame.v[2] * half];
      if (frame && element.role === 'column' && Math.abs(frame.v[2]) > 1e-6) {
        offset = [0, 0, -half / frame.v[2]];
        topOnly = true;
      }
    }
    if (element.role === 'rail') {
      const column = resized.find(
        (candidate) =>
          candidate.role === 'column' &&
          (Math.abs(candidate.start[1] - element.start[1]) < tolerance ||
            Math.abs(candidate.start[1] - element.end[1]) < tolerance) &&
          Math.abs(candidate.start[0] - element.start[0]) < fromMm(doc, larger.h + 500),
      );
      if (column) offset = [Math.sign(element.start[0] - column.start[0]) * half, 0, 0];
    }
    if (!offset) continue;
    const by = offset;
    const updated: SteelMemberElement = topOnly
      ? element.start[2] >= element.end[2]
        ? { ...element, start: shift(element.start, by) }
        : { ...element, end: shift(element.end, by) }
      : { ...element, start: shift(element.start, by), end: shift(element.end, by) };
    next = withElement(next, updated);
    moved.push(element.id);
  }
  return { building: next, moved };
}

/** Bolt rows at least 2.2 d0 apart (EN 1993-1-8 Tab. 3.3; d0 = d + 2 mm up to M24, + 3 mm above). */
function rowSpacingOk(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): boolean {
  if (connection.boltRows < 2) return true;
  const level = building.levels[connection.levelId];
  const members: Record<string, SteelMemberElement | undefined> = {};
  for (const id of [connection.rafterId, connection.otherId]) {
    const element = building.elements[id];
    if (element?.category === 'member') members[id] = element;
  }
  const solids = level ? connectionSolids(doc, connection, members, level) : null;
  if (!solids) return false;
  const diameter = connection.boltDiameter / fromMm(doc, 1);
  const hole = fromMm(doc, diameter + (diameter <= 24 ? 2 : 3));
  const ys = [
    ...new Set(
      solids
        .filter((solid) => solid.part.startsWith('bolt') && solid.part.endsWith('-l'))
        .map((solid) => {
          const values = solid.outline.map(([, y]) => y);
          return (Math.min(...values) + Math.max(...values)) / 2;
        }),
    ),
  ].sort((a, b) => a - b);
  return ys.every((y, index) => index === 0 || y - (ys[index - 1] as number) >= 2.2 * hole);
}
