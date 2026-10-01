/**
 * Portal frame verification: 2D frame analysis of every frame under the EN 1990 combinations of
 * dead, snow, wind and crane actions (global imperfections, Horne αcr and amplified moments),
 * EN 1993 member checks (cross-section, flexural buckling), moment connection bolt checks and
 * SLS deflections.
 * @layer core/commands/building/industrial
 */

import type {
  BuildingModel,
  MomentConnectionElement,
  SteelMemberElement,
} from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import { solveFrame, type FrameResult } from '../../../../lib/frame2d';
import { fromMm, getBuilding, isFiniteNumber, noChange } from '../model';
import { findProfile } from '../steel/profiles';
import { toCsv } from '../quantities';
import { connectionSolids } from './evaluate';
import { framesOf, type FrameLoads, type FrameModel, type LoadCase } from './frameModel';
import { boltResistance, memberBuckling, sectionResistance, yieldStrength } from './steelDesign';

export interface CheckRow {
  readonly frame: string;
  readonly elementId: string;
  readonly mark: string;
  readonly kind: 'column' | 'rafter' | 'connection' | 'deflection' | 'stability';
  /** Governing load combination. */
  readonly combination: string;
  /** kN. */
  readonly axial: number;
  /** kNm. */
  readonly moment: number;
  /** kN. */
  readonly shear: number;
  readonly utilisation: number;
  readonly check: string;
  /** Connections only: signed design moment (N·mm, sagging +) and shear (N) per ULS combination. */
  readonly forces?: ReadonlyArray<{ readonly moment: number; readonly shear: number }>;
}

interface Combination {
  readonly name: string;
  readonly factors: Partial<Record<LoadCase, number>>;
  /** Direction of the sway imperfection (+x / −x). */
  readonly sway: 1 | -1;
}

/** EN 1990 6.10 combinations (ψ0: snow 0.5, wind 0.6; crane γ = 1.35). */
function ultimateCombinations(wind: boolean, crane: boolean): Combination[] {
  const combinations: Combination[] = [
    { name: '1.35G+1.5S (→)', factors: { G: 1.35, S: 1.5 }, sway: 1 },
    { name: '1.35G+1.5S (←)', factors: { G: 1.35, S: 1.5 }, sway: -1 },
  ];
  if (wind) {
    combinations.push(
      { name: '1.35G+1.5W→+0.75S', factors: { G: 1.35, WL: 1.5, S: 0.75 }, sway: 1 },
      { name: '1.35G+1.5W←+0.75S', factors: { G: 1.35, WR: 1.5, S: 0.75 }, sway: -1 },
      { name: '1.0G+1.5W→', factors: { G: 1, WL: 1.5 }, sway: 1 },
      { name: '1.0G+1.5W←', factors: { G: 1, WR: 1.5 }, sway: -1 },
    );
  }
  if (crane) {
    // Crane leading (with and without snow, alone or with either wind), then wind leading with the
    // crane accompanying (ψ0 = 1.0, EN 1991-3 Tab. A.2).
    const sides = [
      { load: 'CL', label: 'C(left)', sway: 1 },
      { load: 'CR', label: 'C(right)', sway: -1 },
    ] as const;
    const winds = [
      { load: 'WL', label: 'W→', sway: 1 },
      { load: 'WR', label: 'W←', sway: -1 },
    ] as const;
    for (const side of sides) {
      for (const snow of [0.75, 0]) {
        const snowLabel = snow > 0 ? '+0.75S' : '';
        combinations.push({
          name: `1.35G+1.35${side.label}${snowLabel}`,
          factors: { G: 1.35, [side.load]: 1.35, S: snow },
          sway: side.sway,
        });
        if (!wind) continue;
        for (const direction of winds) {
          combinations.push({
            name: `1.35G+1.35${side.label}${snowLabel}+0.9${direction.label}`,
            factors: { G: 1.35, [side.load]: 1.35, S: snow, [direction.load]: 0.9 },
            sway: direction.sway,
          });
        }
      }
      if (!wind) continue;
      for (const direction of winds) {
        combinations.push({
          name: `1.35G+1.5${direction.label}+0.75S+1.35${side.label}`,
          factors: { G: 1.35, [direction.load]: 1.5, S: 0.75, [side.load]: 1.35 },
          sway: direction.sway,
        });
      }
    }
  }
  return combinations;
}

type NodeForce = { readonly node: number; readonly fx: number };

function solveCombination(
  frame: FrameModel,
  factors: Partial<Record<LoadCase, number>>,
  extra: ReadonlyArray<NodeForce> = [],
): FrameResult | null {
  const nodeLoads = frame.nodes.map(() => ({ fx: 0, fy: 0, mz: 0 }));
  for (const load of frame.nodeLoads) {
    const factor = factors[load.loadCase] ?? 0;
    const target = nodeLoads[load.node];
    if (!target || factor === 0) continue;
    target.fx += factor * load.fx;
    target.fy += factor * load.fy;
    target.mz += factor * load.mz;
  }
  for (const force of extra) {
    const target = nodeLoads[force.node];
    if (target) target.fx += force.fx;
  }
  return solveFrame(
    frame.nodes.map((node, index) => ({
      ...node,
      load: nodeLoads[index] ?? { fx: 0, fy: 0, mz: 0 },
    })),
    frame.members.map((member) => {
      let [qx, qy] = [0, 0];
      for (const [loadCase, load] of Object.entries(member.loads) as [
        LoadCase,
        { qx: number; qy: number },
      ][]) {
        const factor = factors[loadCase] ?? 0;
        qx += factor * load.qx;
        qy += factor * load.qy;
      }
      return { ...member.geometry, load: { qx, qy } };
    }),
  );
}

interface UltimateResult {
  readonly result: FrameResult;
  /** Elastic critical load factor; Infinity without compression. */
  readonly alphaCritical: number;
  /** Column (or rafter, when Horne is not applicable) governing αcr. */
  readonly criticalMember: string | null;
  /** How αcr was found, e.g. "Horne" / "rafter axial (Horne not applicable)". */
  readonly method: string;
  /** Moment amplification 1 / (1 − 1/αcr) applied to all moments when αcr < 10 (5.2.2(5)). */
  readonly amplification: number;
}

const HORNE_MAX_SLOPE = Math.tan((26 * Math.PI) / 180);

/**
 * One ULS combination with sway imperfections (5.3.2) and amplified moments (5.2.2(5)).
 * Each column piece between nodes (base, crane bracket, top) is a storey: imperfection and Horne
 * forces act where the compression enters (φ ΔN, ΔN/200) and αcr = min h_i / (200 Δδ_i).
 */
function solveUltimate(frame: FrameModel, combination: Combination): UltimateResult | null {
  const first = solveCombination(frame, combination.factors);
  if (!first) return null;
  const pieces = frame.members.flatMap((member, index) => {
    const forces = first.members[index];
    if (member.role !== 'column' || !forces) return [];
    const [a, b] = [frame.nodes[member.geometry.a], frame.nodes[member.geometry.b]];
    if (!a || !b) return [];
    return [
      {
        member,
        height: Math.hypot(b.x - a.x, b.y - a.y),
        compression: Math.max(0, -forces.axial[1]),
      },
    ];
  });
  // Compression entering at each node: the piece below minus the piece above.
  const entering = new Map<number, number>();
  for (const piece of pieces) {
    const above = pieces.find((other) => other.member.geometry.a === piece.member.geometry.b);
    const increment = Math.max(0, piece.compression - (above?.compression ?? 0));
    if (increment > 0) entering.set(piece.member.geometry.b, increment);
  }
  const tallest = Math.max(...frame.columnTops.map((top) => top.height), 1) / 1000;
  const alphaH = Math.min(1, Math.max(2 / 3, 2 / Math.sqrt(tallest)));
  const loaded = frame.columnTops.filter((top) =>
    pieces.some((piece) => piece.member.elementId === top.elementId && piece.compression > 0),
  ).length;
  const phi = loaded > 0 ? (alphaH * Math.sqrt(0.5 * (1 + 1 / loaded))) / 200 : 0;
  const result = solveCombination(
    frame,
    combination.factors,
    [...entering].map(([node, increment]) => ({ node, fx: combination.sway * phi * increment })),
  );
  if (!result) return null;
  const horne = solveFrame(
    frame.nodes.map((node, index) => ({
      ...node,
      load: { fx: (entering.get(index) ?? 0) / 200, fy: 0, mz: 0 },
    })),
    frame.members.map((member) => member.geometry),
  );
  let alphaCritical = Infinity;
  let criticalMember: string | null = null;
  let method = 'Horne';
  for (const piece of pieces) {
    const drift = Math.abs(
      (horne?.displacements[piece.member.geometry.b]?.[0] ?? 0) -
        (horne?.displacements[piece.member.geometry.a]?.[0] ?? 0),
    );
    if (piece.compression <= 0 || !(drift > 0)) continue;
    const alpha = piece.height / (200 * drift);
    if (alpha < alphaCritical) {
      alphaCritical = alpha;
      criticalMember = piece.member.elementId;
    }
  }
  // Horne scope (5.2.1(4)B Note 2B): slopes ≤ 26° and rafter N ≤ 0.09 Ncr (Ncr over the span).
  // Otherwise the modified estimate αcr = 0.8 αH (1 − N/Ncr)max (SCI P397, Lim & King) is used.
  let rafterRatio = 0;
  let steep = false;
  frame.members.forEach((member, index) => {
    const forces = first.members[index];
    const [a, b] = [frame.nodes[member.geometry.a], frame.nodes[member.geometry.b]];
    if (member.role !== 'rafter' || !forces || !a || !b) return;
    steep ||= Math.abs(b.y - a.y) > HORNE_MAX_SLOPE * Math.abs(b.x - a.x);
    const middle = (a.x + b.x) / 2;
    const span = frame.spans.find(([x0, x1]) => middle >= x0 && middle <= x1);
    const length = span ? span[1] - span[0] : Math.hypot(b.x - a.x, b.y - a.y);
    const critical = (Math.PI ** 2 * member.geometry.E * member.geometry.I) / length ** 2;
    const compression = Math.max(0, ...forces.axial.map((value) => -value));
    if (compression / critical > rafterRatio) {
      rafterRatio = compression / critical;
      if (rafterRatio > 0.09) criticalMember ??= member.elementId;
    }
  });
  if ((steep || rafterRatio > 0.09) && Number.isFinite(alphaCritical)) {
    alphaCritical = 0.8 * alphaCritical * Math.max(0, 1 - rafterRatio);
    method = `modified Horne 0.8 αH (1 − N/Ncr), ${steep ? 'roof slope > 26°' : 'rafter N > 0.09 Ncr'}`;
  }
  const amplification =
    alphaCritical >= 10 ? 1 : alphaCritical > 1.05 ? 1 / (1 - 1 / alphaCritical) : 20;
  return { result, alphaCritical, criticalMember, method, amplification };
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

const SLS_VERTICAL = 200;
const SLS_SWAY = 150;
const SLS_CRANE = 400;

/**
 * Analyses and checks every portal frame of a level: worst row per element over all combinations.
 * @pure
 */
export function checkFrames(
  doc: CadDocument,
  levelId: string,
  loads: FrameLoads,
): {
  rows: CheckRow[];
  frames: number;
  skipped: string[];
  combinations: string[];
  minAlphaCritical: number;
} {
  const building = getBuilding(doc);
  const { frames, skipped } = framesOf(doc, building, levelId, loads);
  const wind = loads.windPressure > 0;
  const crane = frames.some((frame) => frame.craneNodes.length > 0);
  const combinations = ultimateCombinations(wind, crane);
  const worst = new Map<string, CheckRow>();
  const keep = (row: CheckRow, key = row.elementId): void => {
    const current = worst.get(key);
    if (!current || row.utilisation > current.utilisation) worst.set(key, row);
  };
  const connectionForces = new Map<string, { moment: number; shear: number }[]>();
  let unstable = 0;
  let minAlphaCritical = Infinity;
  for (const frame of frames) {
    const ultimate = combinations.map((combination) => ({
      combination,
      outcome: solveUltimate(frame, combination),
    }));
    if (ultimate.some(({ outcome }) => outcome === null)) {
      skipped.push(`${frame.label} (unstable)`);
      unstable += 1;
      continue;
    }
    let stability: { alpha: number; column: string; combination: string; method: string } | null =
      null;
    for (const { combination, outcome } of ultimate) {
      if (!outcome) continue;
      const { result, amplification } = outcome;
      if (
        outcome.criticalMember !== null &&
        (stability === null || outcome.alphaCritical < stability.alpha)
      ) {
        stability = {
          alpha: outcome.alphaCritical,
          column: outcome.criticalMember,
          combination: combination.name,
          method: outcome.method,
        };
      }
      frame.members.forEach((analysis, index) => {
        const member = building.elements[analysis.elementId];
        const forces = result.members[index];
        if (member?.category !== 'member' || !forces) return;
        const profile = findProfile(member.profile);
        if (!profile) return;
        const fy = yieldStrength(member.material);
        const resistance = sectionResistance(profile, fy);
        const moment = forces.maxMoment * amplification;
        const shear = Math.max(...forces.shear.map(Math.abs));
        const compression = Math.max(0, ...forces.axial.map((value) => -value));
        const section = forces.maxAxial / resistance.axial + moment / resistance.moment;
        const buckling = memberBuckling(profile, fy, compression, moment, analysis.lengths);
        const shearRatio = shear / resistance.shear;
        const governing =
          buckling.utilisation >= section && buckling.utilisation >= shearRatio
            ? `buckling χy ${buckling.chiMajor.toFixed(2)} χz ${buckling.chiMinor.toFixed(2)}`
            : shearRatio > section
              ? 'shear V/Vpl'
              : `N/Npl + M/M${resistance.sectionClass <= 2 ? 'pl' : 'el'}`;
        keep({
          frame: frame.label,
          elementId: member.id,
          mark: member.mark,
          kind: member.role === 'column' ? 'column' : 'rafter',
          combination: combination.name,
          axial: forces.maxAxial / 1000,
          moment: moment / 1e6,
          shear: shear / 1000,
          utilisation: Math.max(section, buckling.utilisation, shearRatio),
          check: `${governing} (${member.profile} class ${resistance.sectionClass}, ${member.material}${amplification > 1 ? `, sway ×${amplification.toFixed(2)}` : ''})`,
        });
      });
      for (const connection of Object.values(building.elements)) {
        if (connection.category !== 'connection') continue;
        const index = frame.members.findIndex(
          (analysis) => analysis.elementId === connection.rafterId,
        );
        const analysis = frame.members[index];
        const forces = result.members[index];
        if (!analysis || !forces) continue;
        // Map the rafter end to the analysis member end (members are analysed left → right).
        const end = (connection.end === 'start') !== analysis.reversed ? 0 : 1;
        const moment = forces.moment[end] * amplification;
        const shear = forces.shear[end];
        const list = connectionForces.get(connection.id) ?? [];
        list.push({ moment, shear });
        connectionForces.set(connection.id, list);
        const verdict = connectionCheck(doc, building, connection, moment, shear);
        if (!verdict) continue;
        keep({
          frame: frame.label,
          elementId: connection.id,
          mark: connection.mark,
          kind: 'connection',
          combination: combination.name,
          axial: Math.abs(forces.axial[end]) / 1000,
          moment: Math.abs(moment) / 1e6,
          shear: Math.abs(shear) / 1000,
          utilisation: verdict.utilisation,
          check: `${connection.kind}: ${verdict.check}`,
        });
      }
    }
    if (stability) {
      minAlphaCritical = Math.min(minAlphaCritical, stability.alpha);
      const column = building.elements[stability.column];
      keep(
        {
          frame: frame.label,
          elementId: stability.column,
          mark: column?.mark ?? stability.column,
          kind: 'stability',
          combination: stability.combination,
          axial: 0,
          moment: 0,
          shear: 0,
          utilisation: 3 / stability.alpha,
          check: `sway stability αcr ${stability.alpha.toFixed(1)} ≥ 3 (${stability.method}; moments amplified when < 10)`,
        },
        `${frame.label}:stability`,
      );
    }
    // SLS (EN 1990 A1.4): rafter deflection under snow, sway under wind / crane alone.
    const vertical = solveCombination(frame, { S: 1 });
    frame.members.forEach((analysis, index) => {
      const deflection = vertical?.members[index]?.maxDisplacement.y;
      if (analysis.role !== 'rafter' || deflection === undefined) return;
      const [a, b] = [frame.nodes[analysis.geometry.a], frame.nodes[analysis.geometry.b]];
      const middle = ((a?.x ?? 0) + (b?.x ?? 0)) / 2;
      const span = frame.spans.find(([x0, x1]) => middle >= x0 && middle <= x1);
      if (!span) return;
      const limit = (span[1] - span[0]) / SLS_VERTICAL;
      const member = building.elements[analysis.elementId];
      keep(
        {
          frame: frame.label,
          elementId: analysis.elementId,
          mark: member?.mark ?? analysis.elementId,
          kind: 'deflection',
          combination: 'SLS S',
          axial: 0,
          moment: 0,
          shear: 0,
          utilisation: deflection / limit,
          check: `vertical ${deflection.toFixed(0)} mm ≤ span/${SLS_VERTICAL} = ${limit.toFixed(0)} mm`,
        },
        `${frame.label}:vertical`,
      );
    });
    const swayCases: {
      name: string;
      factors: Partial<Record<LoadCase, number>>;
      crane: boolean;
    }[] = [];
    if (wind) {
      swayCases.push(
        { name: 'SLS W→', factors: { WL: 1 }, crane: false },
        { name: 'SLS W←', factors: { WR: 1 }, crane: false },
      );
    }
    if (frame.craneNodes.length > 0) {
      swayCases.push(
        { name: 'SLS C(left)', factors: { CL: 1 }, crane: true },
        { name: 'SLS C(right)', factors: { CR: 1 }, crane: true },
      );
    }
    for (const swayCase of swayCases) {
      const result = solveCombination(frame, swayCase.factors);
      const points = swayCase.crane ? frame.craneNodes : frame.columnTops;
      const ratio = swayCase.crane ? SLS_CRANE : SLS_SWAY;
      for (const point of points) {
        const sway = Math.abs(result?.displacements[point.node]?.[0] ?? 0);
        const limit = point.height / ratio;
        const member = building.elements[point.elementId];
        keep(
          {
            frame: frame.label,
            elementId: point.elementId,
            mark: member?.mark ?? point.elementId,
            kind: 'deflection',
            combination: swayCase.name,
            axial: 0,
            moment: 0,
            shear: 0,
            utilisation: sway / limit,
            check: `${swayCase.crane ? 'rail-level' : 'eaves'} sway ${sway.toFixed(0)} mm ≤ h/${ratio} = ${limit.toFixed(0)} mm`,
          },
          `${frame.label}:sway`,
        );
      }
    }
  }
  const rows = [...worst.values()].map((row) => {
    const forces = connectionForces.get(row.elementId);
    return forces ? { ...row, forces } : row;
  });
  return {
    rows,
    frames: frames.length - unstable,
    skipped,
    combinations: combinations.map((combination) => combination.name),
    minAlphaCritical,
  };
}

/** Load parameters shared by check_portal_frames and design_portal_frames. */
export interface FrameLoadParams {
  deadLoad?: number;
  snowLoad?: number;
  windPressure?: number;
  craneCapacity?: number;
  levelId?: string;
}

export const FRAME_LOAD_PROPERTIES = {
  deadLoad: {
    type: 'number',
    description: 'Roof dead load (build-up, purlins, services), kN/m². Default 0.5.',
  },
  snowLoad: { type: 'number', description: 'Roof snow load, kN/m². Default 0.8.' },
  windPressure: {
    type: 'number',
    description:
      'Peak velocity pressure qp, kN/m² (EN 1991-1-4; e.g. 0.6–1.0). Default 0 = wind not applied. ' +
      'Coefficients: windward wall +0.8, leeward −0.5, roof uplift −0.8 (incl. cpi).',
  },
  craneCapacity: {
    type: 'number',
    description:
      'Crane capacity in tonnes for every runway on the level. Default: read from the runways ' +
      '(add_crane_runway capacity); 0 = ignore cranes.',
  },
  levelId: { type: 'string', description: 'Level id. Default: the active level.' },
} as const;

/** Validated loads + level, or the failure reason. */
export function resolveFrameLoads(
  doc: CadDocument,
  params: FrameLoadParams,
): { loads: FrameLoads; levelId: string } | { reason: string } {
  const { deadLoad = 0.5, snowLoad = 0.8, windPressure = 0, craneCapacity } = params;
  const nonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
  if (
    !nonNegative(deadLoad) ||
    !nonNegative(snowLoad) ||
    !nonNegative(windPressure) ||
    (craneCapacity !== undefined && !nonNegative(craneCapacity))
  ) {
    return { reason: 'deadLoad, snowLoad, windPressure and craneCapacity must be >= 0' };
  }
  const building = getBuilding(doc);
  const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0];
  if (levelId === undefined || !building.levels[levelId]) {
    return { reason: `no level '${params.levelId ?? ''}'` };
  }
  return {
    loads: {
      deadLoad,
      snowLoad,
      windPressure,
      ...(craneCapacity !== undefined ? { craneCapacity } : {}),
    },
    levelId,
  };
}

/** "G = 0.5 kN/m² + self-weight, S = 0.8, W = 0.7 (qp), cranes from runways". */
export function describeLoads(loads: FrameLoads): string {
  return (
    `G = ${loads.deadLoad} kN/m² + self-weight, S = ${loads.snowLoad} kN/m², ` +
    `${loads.windPressure > 0 ? `qp = ${loads.windPressure} kN/m²` : 'no wind (windPressure = 0)'}, ` +
    `${loads.craneCapacity === undefined ? 'cranes from runways' : loads.craneCapacity === 0 ? 'cranes ignored' : `cranes ${loads.craneCapacity} t`}`
  );
}

/**
 * @command check_portal_frames
 * @pure read-only
 * @affects none; data = { rows: CheckRow[], csv, maxUtilisation, failures, combinations, alphaCritical }
 * @failure negative loads / unknown level / no frame -> no data
 */
export const checkPortalFrames: CommandDefinition<FrameLoadParams> = {
  name: 'check_portal_frames',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Structural check of the steel portal frames of a level. Each frame (rafters in a vertical ' +
    'plane + the columns under them, pinned bases) is solved as a 2D frame (direct stiffness, ' +
    'section properties from the profile outline, no root radii) for every EN 1990 combination of ' +
    'dead G (deadLoad + self-weight), snow S, wind W (windPressure, both directions, incl. uplift) ' +
    'and crane C (from add_crane_runway capacity: vertical wheel reactions with dynamic factors + ' +
    'lateral surge at the brackets), with sway imperfections and Horne αcr per storey (all moments amplified ' +
    'by 1/(1−1/αcr) when αcr < 10). Checks: member cross-section (EN 1993-1-1 §6.2), flexural buckling with N–M ' +
    'interaction (§6.3, columns full height, rafters between purlins), frame sway stability ' +
    '(αcr ≥ 3), end-plate bolt groups (EN 1993-1-8, grade 8.8) and SLS deflections (rafters ' +
    'span/200 under snow, eaves h/150 under wind, rail level h/400 under crane). Returns the worst ' +
    'utilisation per element; values > 1 fail. Not covered: lateral-torsional buckling, fatigue, ' +
    'gable / bracing systems, base / footing design — a preliminary design check, not a ' +
    'substitute for the engineer of record.',
  paramsSchema: {
    type: 'object',
    properties: FRAME_LOAD_PROPERTIES,
    required: [],
  },
  run: (doc, params): CommandResult => {
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved)
      return noChange(doc, `check_portal_frames failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const { rows, frames, skipped, combinations, minAlphaCritical } = checkFrames(
      doc,
      levelId,
      loads,
    );
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
      'Combination',
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
        row.combination,
        row.check,
      ]),
    );
    return {
      document: doc,
      summary:
        `Checked ${frames} frame(s), ${rows.length} check(s) over ${combinations.length} ULS combination(s) + SLS (${describeLoads(loads)}): ` +
        `max utilisation ${round(worst?.utilisation ?? 0)} (${worst?.mark ?? '—'} ${worst?.kind ?? ''}, ${worst?.frame ?? '—'}, ${worst?.combination ?? '—'}); ` +
        `min αcr ${Number.isFinite(minAlphaCritical) ? round(minAlphaCritical, 1) : '—'}; ` +
        (failures.length === 0
          ? 'all OK (no lateral-torsional buckling, fatigue or bracing checks).'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.mark} ${row.kind} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`) +
        `${skipped.length > 0 ? ` Not checked: ${skipped.join(', ')}.` : ''}`,
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worst?.utilisation ?? 0,
        failures: [...new Set(failures.map((row) => row.elementId))],
        combinations,
        alphaCritical: Number.isFinite(minAlphaCritical) ? minAlphaCritical : null,
      },
    };
  },
};
