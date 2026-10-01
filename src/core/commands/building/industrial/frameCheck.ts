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
import type { CadDocument } from '../../../model/types';
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
import { findProfile, sectionProperties, STEEL_PROFILES } from '../steel/profiles';
import { toCsv } from '../quantities';
import { connectionSolids } from './evaluate';

const E_STEEL = 210000; // N/mm²
const GAMMA_M0 = 1.0;
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
}

/** Frames of a level: steel rafters in vertical planes y = const with the columns under their ends. */
function framesOf(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: { readonly line: (tributary: number) => number },
): FrameModel[] {
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
  const planes = [...new Set(rafters.map((rafter) => Math.round(mm(rafter.start[1]))))].sort(
    (a, b) => a - b,
  );
  const gridLabel = (y: number): string => {
    const grid = Object.values(building.elements).find(
      (element) =>
        element.category === 'grid' &&
        Math.abs(mm(element.start[1]) - y) < tolerance &&
        Math.abs(mm(element.end[1]) - y) < tolerance,
    );
    return grid ? `frame ${grid.mark}` : `frame y=${y}`;
  };
  return planes.flatMap((y, index): FrameModel[] => {
    const previous = planes[index - 1];
    const next = planes[index + 1];
    const tributary = ((next ?? y) - (previous ?? y)) / 2 || 0;
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
    const free: FrameNode['restraint'] = [false, false, false];
    for (const rafter of rafters.filter((candidate) => Math.round(mm(candidate.start[1])) === y)) {
      const profile = findProfile(rafter.profile);
      if (!profile) continue;
      const section = sectionProperties(profile);
      const [x0, z0, x1, z1] = [
        mm(rafter.start[0]),
        mm(rafter.start[2]),
        mm(rafter.end[0]),
        mm(rafter.end[2]),
      ];
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
    }
    for (const column of members.filter(
      (candidate) =>
        candidate.role === 'column' &&
        Math.abs(mm(candidate.start[1]) - y) < tolerance &&
        Math.abs(mm(candidate.end[1]) - y) < tolerance,
    )) {
      const [bottom, top] =
        column.start[2] <= column.end[2] ? [column.start, column.end] : [column.end, column.start];
      const topNode = nodes.findIndex(
        (node) =>
          Math.abs(node.x - mm(top[0])) < tolerance && Math.abs(node.y - mm(top[2])) < tolerance,
      );
      const profile = findProfile(column.profile);
      if (topNode < 0 || !profile) continue; // gable posts under the rafter span are ignored
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
    }
    return frameMembers.length > 0
      ? [{ label: gridLabel(y), nodes, members: frameMembers, memberIds }]
      : [];
  });
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
  const frames = framesOf(doc, building, levelId, { line: (tributary) => area * tributary });
  const rows: CheckRow[] = [];
  const skipped: string[] = [];
  for (const frame of frames) {
    const result = solveFrame(frame.nodes, frame.members);
    if (!result) {
      skipped.push(frame.label);
      continue;
    }
    const byId = new Map<string, MemberResult>();
    frame.memberIds.forEach((id, index) => {
      const member = building.elements[id];
      const forces = result.members[index];
      if (member?.category !== 'member' || !forces) return;
      byId.set(id, forces);
      const profile = findProfile(member.profile);
      if (!profile) return;
      const section = sectionProperties(profile);
      const fy = yieldStrength(member.material);
      const npl = (section.area * fy) / GAMMA_M0;
      const mpl = (section.plasticModulus * fy) / GAMMA_M0;
      rows.push({
        frame: frame.label,
        elementId: id,
        mark: member.mark,
        kind: member.role === 'column' ? 'column' : 'rafter',
        axial: forces.maxAxial / 1000,
        moment: forces.maxMoment / 1e6,
        shear: Math.max(...forces.shear.map(Math.abs)) / 1000,
        utilisation: forces.maxAxial / npl + forces.maxMoment / mpl,
        check: `N/Npl + M/Mpl (${member.profile}, ${member.material})`,
      });
    });
    for (const connection of Object.values(building.elements)) {
      if (connection.category !== 'connection') continue;
      const forces = byId.get(connection.rafterId);
      if (!forces) continue;
      const end = connection.end === 'start' ? 0 : 1;
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
  return { rows, frames: frames.length - skipped.length, skipped };
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
    'method, exact section properties) under ULS 1.35 G + 1.5 S, with G = deadLoad (kN/m², roof ' +
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
        `check_portal_frames failed: no analysable portal frame on the level${skipped.length > 0 ? ` (unstable: ${skipped.join(', ')})` : ''}.`,
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
          ? 'all OK.'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.mark} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`) +
        `${skipped.length > 0 ? ` Unstable (not checked): ${skipped.join(', ')}.` : ''}`,
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
        for (const element of Object.values(next.elements)) {
          if (
            element.category !== 'member' ||
            element.levelId !== levelId ||
            element.role !== role ||
            element.profile !== profile
          )
            continue;
          const resized: SteelMemberElement = { ...element, profile: larger };
          next = refitPlates(current, withElement(next, resized), resized, profile).building;
          changed.add(element.id);
        }
      }
      current = { ...current, building: next };
      if (!progressed) break;
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
        building = withElement(building, {
          ...original,
          boltRows: chosen.rows,
          boltDiameter: fromMm(current, chosen.diameter),
        });
        changed.add(original.id);
      }
    }
    const document = regenerateBuilding(doc, building);
    const final = checkFrames(document, levelId, loads);
    const worst = Math.max(0, ...final.rows.map((row) => row.utilisation));
    const failures = final.rows.filter((row) => row.utilisation > 1).length;
    return {
      document,
      summary:
        `Designed ${final.frames} frame(s) for ULS 1.35 G + 1.5 S (G = ${deadLoad}, S = ${snowLoad} kN/m²): ` +
        `${changes.length > 0 ? changes.join('; ') : 'no change needed'}. ` +
        `Max utilisation now ${worst.toFixed(2)}${failures > 0 ? `, ${failures} element(s) still failing` : ''}` +
        `${limited ? ' (largest available size reached for some elements)' : ''}.`,
      affected: elementAffected(document, [...changed]),
      data: { changes, maxUtilisation: worst, failures },
    };
  },
};

/** Bolt rows at least 2.2 d apart (EN 1993-1-8 Tab. 3.3, p1 ≥ 2.2 d0). */
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
  const ys = [
    ...new Set(
      (solids ?? [])
        .filter((solid) => solid.part.startsWith('bolt') && solid.part.endsWith('-l'))
        .map((solid) => {
          const values = solid.outline.map(([, y]) => y);
          return (Math.min(...values) + Math.max(...values)) / 2;
        }),
    ),
  ].sort((a, b) => a - b);
  return ys.every(
    (y, index) => index === 0 || y - (ys[index - 1] as number) >= 2.2 * connection.boltDiameter,
  );
}
