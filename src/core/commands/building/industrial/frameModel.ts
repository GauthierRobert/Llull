/**
 * Portal frame analysis models: the 2D frames of a level (rafters in vertical planes y = const +
 * the columns under them) with their characteristic load cases.
 * @layer core/commands/building/industrial
 * @pure
 */

import type { BuildingModel, SteelMemberElement } from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import {
  solveFrame,
  type FrameMember,
  type FrameNode,
  type FrameResult,
} from '../../../../lib/frame2d';
import { fromMm } from '../model';
import { findProfile, sectionProperties } from '../steel/profiles';
import { E_STEEL } from './steelDesign';

/**
 * G dead, S snow, WL / WR wind from the left (+x) / right with internal pressure cpi = +0.2,
 * WLs / WRs the same with internal suction cpi = −0.3, CL / CR crane load group 1 (EN 1991-3 Tab. 2.2:
 * φ1 Gc + φ2 Q + drive forces) with the maximum wheel load at the left / right rail, CL5 / CR5 load
 * group 5 (φ4 + skewing HS) likewise, CLk / CRk the serviceability version of group 1 (static wheel
 * loads, φ = 1, drive force HT / φ5; EN 1993-6 §7.3).
 */
export type LoadCase =
  | 'G'
  | 'S'
  | 'WL'
  | 'WR'
  | 'WLs'
  | 'WRs'
  | 'CL'
  | 'CR'
  | 'CL5'
  | 'CR5'
  | 'CLk'
  | 'CRk';

export interface WindCase {
  readonly loadCase: 'WL' | 'WR' | 'WLs' | 'WRs';
  readonly from: 'left' | 'right';
  readonly internalPressure: number;
  /** Combination label, e.g. "W→" or "W←(cpi−0.3)". */
  readonly label: string;
}

/** The four wind cases (EN 1991-1-4 §7.2.9: cpi +0.2 / −0.3 when openings are not dominant). */
export const WIND_CASES: ReadonlyArray<WindCase> = [
  { loadCase: 'WL', from: 'left', internalPressure: 0.2, label: 'W→' },
  { loadCase: 'WR', from: 'right', internalPressure: 0.2, label: 'W←' },
  { loadCase: 'WLs', from: 'left', internalPressure: -0.3, label: 'W→(cpi−0.3)' },
  { loadCase: 'WRs', from: 'right', internalPressure: -0.3, label: 'W←(cpi−0.3)' },
];

/** Uniform member load per unit length, global components (N/mm). */
export type CaseLoads = Partial<Record<LoadCase, { readonly qx: number; readonly qy: number }>>;

export interface AnalysisMember {
  readonly geometry: Omit<FrameMember, 'load'>;
  readonly elementId: string;
  readonly role: 'column' | 'rafter';
  /** True when the analysis member runs end → start of the element (kept left → right / up). */
  readonly reversed: boolean;
  /** True for the first / last analysis piece of the element (connection ends). */
  readonly ends: readonly [boolean, boolean];
  readonly loads: CaseLoads;
  /**
   * Buckling lengths (mm): in-plane system length, out-of-plane flexural length and the spacing
   * of lateral-torsional restraints (purlins / side rails with fly braces to the inner flange).
   */
  readonly lengths: {
    readonly major: number;
    readonly minor: number;
    readonly lateralTorsional: number;
  };
}

export interface NodeCaseLoad {
  readonly node: number;
  readonly loadCase: LoadCase;
  readonly fx: number;
  readonly fy: number;
  readonly mz: number;
}

export interface FrameModel {
  readonly label: string;
  readonly nodes: FrameNode[];
  readonly members: AnalysisMember[];
  readonly nodeLoads: NodeCaseLoad[];
  /** Column tops (mm above the base) — sway / imperfection / Horne loads act here. */
  readonly columnTops: ReadonlyArray<{ node: number; height: number; elementId: string }>;
  /** Crane bracket nodes (mm above the base) — lateral deflection at rail level. */
  readonly craneNodes: ReadonlyArray<{ node: number; height: number; elementId: string }>;
  /** Spans between adjacent column tops, [x0, x1] mm. */
  readonly spans: ReadonlyArray<readonly [number, number]>;
}

export interface FrameLoads {
  /** kN/m². */
  readonly deadLoad: number;
  readonly snowLoad: number;
  /** Peak velocity pressure qp, kN/m² (0 = no wind). */
  readonly windPressure: number;
  /** Crane capacity override, t (undefined = from the runway, 0 = ignore cranes). */
  readonly craneCapacity?: number;
  /** Crane model overrides (EN 1991-3); undefined fields take the defaults of `craneActions`. */
  readonly craneModel?: CraneModel;
}

/** Simplified external pressure coefficients (EN 1991-1-4: walls D / E, duopitch roof average). */
export const WIND_COEFFICIENTS = { windward: 0.8, leeward: 0.5, roofSuction: 0.6 } as const;

/** Crane capacity (t) from the runway note written by add_crane_runway ("Crane 10 t, …"). */
export function craneCapacityOf(member: SteelMemberElement): number | null {
  const value = Number(/^Crane\s+(\d+(?:\.\d+)?)\s*t\b/.exec(member.note ?? '')?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type HoistingClass = 'HC1' | 'HC2' | 'HC3' | 'HC4';

/** EN 1991-3 Tab. 2.5: φ2 = φ2,min + β2 vh. */
export const HOISTING_CLASSES: Readonly<
  Record<HoistingClass, { readonly beta2: number; readonly phi2Min: number }>
> = {
  HC1: { beta2: 0.17, phi2Min: 1.05 },
  HC2: { beta2: 0.34, phi2Min: 1.1 },
  HC3: { beta2: 0.51, phi2Min: 1.15 },
  HC4: { beta2: 0.68, phi2Min: 1.2 },
};

/**
 * EN 1991-3 dynamic and drive factors: φ1 on the self-weight, φ4 = 1.0 (rails within tolerance),
 * φ5 = 1.5 (smooth change of the drive force), friction μ = 0.2, nr = 2 rails, skew angle
 * α = 0.015 rad (simplified, §2.7.4).
 */
export const CRANE_FACTORS = {
  phi1: 1.1,
  phi4: 1,
  phi5: 1.5,
  friction: 0.2,
  rails: 2,
  skewAngle: 0.015,
} as const;

export interface CraneModel {
  readonly hoistingClass?: HoistingClass;
  /** Hoisting speed vh, m/s. Default 0.1. */
  readonly hoistingSpeed?: number;
  /** Crane self-weight Gc, kN (bridge + trolley). Default 0.5 Q + 20 kN. */
  readonly craneSelfWeight?: number;
  /** Minimum hook approach to the rail, m. Default 1.0. */
  readonly minHookApproach?: number;
  /** Wheel base a of a rail wheel group, mm. Default 3000. */
  readonly wheelBase?: number;
}

export interface CraneActions {
  /** Dynamic factor φ2 = φ2,min + β2 vh. */
  readonly phi2: number;
  /** Crane self-weight Gc, N. */
  readonly selfWeight: number;
  /** Static (characteristic, no dynamic factor) rail reactions, N per rail. */
  readonly staticMax: number;
  readonly staticMin: number;
  /** Load group 1: φ1 Gc + φ2 Q with HL, HT. N per rail. */
  readonly group1: {
    readonly max: number;
    readonly min: number;
    /** Longitudinal drive force HL,i = φ5 K / nr per rail. */
    readonly longitudinal: number;
    /** Transverse drive force on the heavily / lightly loaded rail (HT,1 / HT,2). */
    readonly transverseMax: number;
    readonly transverseMin: number;
  };
  /** Load group 5: φ4 (Gc + Q) with skewing forces HS. N per rail. */
  readonly group5: {
    readonly max: number;
    readonly min: number;
    readonly skewMax: number;
    readonly skewMin: number;
  };
}

/**
 * Characteristic crane actions per rail (N) of one bridge crane, EN 1991-3 §2.
 * Statics: bridge 0.8 Gc at midspan, trolley 0.2 Gc + hoist load Q at the minimum hook approach e;
 * Rmax = 0.4 Gc + (0.2 Gc + Q)(l − e)/l, Rmin = 0.4 Gc + (0.2 Gc + Q) e/l (wheel load = rail / 2).
 * Group 1: φ1 on Gc, φ2 on Q; K = μ Σ driven wheel loads (one driven wheel per rail at the minimum static wheel load, Σ = Rmin),
 * HL,i = φ5 K / nr, M = K ls with ls = (ξ1 − 0.5) l, HT,1 = φ5 ξ2 M / a, HT,2 = φ5 ξ1 M / a (same
 * direction on both rails, conservative). Group 5: φ4 = 1 and HS,i = f λS,i ΣQr, f = 0.3(1 − e^(−250 α))
 * with α = 0.015 rad, λS = ξ2 / nr on the loaded rail guide and ξ1 / nr on the other (IFF, simplified).
 * @param span bridge span between the rails, mm
 */
export function craneActions(
  capacityTonnes: number,
  span: number,
  model: CraneModel = {},
): CraneActions {
  const { phi1, phi4, phi5, friction, rails, skewAngle } = CRANE_FACTORS;
  const { beta2, phi2Min } = HOISTING_CLASSES[model.hoistingClass ?? 'HC2'];
  const phi2 = phi2Min + beta2 * (model.hoistingSpeed ?? 0.1);
  const hoist = capacityTonnes * 9810;
  const self =
    model.craneSelfWeight !== undefined ? model.craneSelfWeight * 1000 : 0.5 * hoist + 20000;
  const approach = Math.min(Math.max(0, (model.minHookApproach ?? 1) * 1000), span);
  const wheelBase = model.wheelBase ?? 3000;
  const nearShare = (span - approach) / span;
  const farShare = approach / span;
  const trolleyAndHoist = 0.2 * self + hoist;
  const staticMax = 0.4 * self + trolleyAndHoist * nearShare;
  const staticMin = 0.4 * self + trolleyAndHoist * farShare;
  const dynamic = (share: number): number =>
    phi1 * (0.4 * self + 0.2 * self * share) + phi2 * hoist * share;
  const total = staticMax + staticMin;
  const xi1 = staticMax / total;
  const xi2 = 1 - xi1;
  const drive = friction * staticMin;
  const moment = drive * (xi1 - 0.5) * span;
  const skewFactor = 0.3 * (1 - Math.exp(-250 * skewAngle));
  return {
    phi2,
    selfWeight: self,
    staticMax,
    staticMin,
    group1: {
      max: dynamic(nearShare),
      min: dynamic(farShare),
      longitudinal: (phi5 * drive) / rails,
      transverseMax: (phi5 * xi2 * moment) / wheelBase,
      transverseMin: (phi5 * xi1 * moment) / wheelBase,
    },
    group5: {
      max: phi4 * staticMax,
      min: phi4 * staticMin,
      skewMax: skewFactor * (xi2 / rails) * total,
      skewMin: skewFactor * (xi1 / rails) * total,
    },
  };
}

/** x of the internal valleys (rafter pairs of one plane meeting at their low ends), mm. */
export function valleyLines(
  rafters: ReadonlyArray<{ readonly start: readonly number[]; readonly end: readonly number[] }>,
  tolerance = 10,
): number[] {
  const lowEnds = rafters.map(({ start, end }) => ((start[2] ?? 0) <= (end[2] ?? 0) ? start : end));
  const shared = (end: readonly number[]): boolean =>
    lowEnds.filter(
      (other) =>
        Math.abs((other[0] ?? 0) - (end[0] ?? 0)) <= tolerance &&
        Math.abs((other[1] ?? 0) - (end[1] ?? 0)) <= tolerance,
    ).length >= 2;
  const xs = lowEnds.filter(shared).map((end) => Math.round((end[0] ?? 0) / tolerance) * tolerance);
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Factor on the roof suction of a span downwind of the windward one (EN 1991-1-4 Fig. 7.10, simplified). */
export const DOWNWIND_ROOF_FACTOR = 0.6;

/**
 * Frames of a level. Planes are grouped per hall (overlapping rafter x-ranges) for tributary
 * widths; a hall with a single frame plane has no tributary width and is reported in `skipped`.
 */
export function framesOf(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: FrameLoads,
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
  const near = (a: number, b: number): boolean => Math.abs(a - b) < tolerance;
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
    const hall = [...new Set(hallOf.values())].find((hallMembers) =>
      hallMembers.some(
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
        element.category === 'grid' && near(mm(element.start[1]), y) && near(mm(element.end[1]), y),
    );
    return grid ? `frame ${grid.mark}` : `frame y=${y}`;
  };
  const purlinXs = (y: number): number[] =>
    members
      .filter(
        (member) =>
          member.role === 'purlin' &&
          Math.min(mm(member.start[1]), mm(member.end[1])) <= y + tolerance &&
          Math.max(mm(member.start[1]), mm(member.end[1])) >= y - tolerance,
      )
      .map((member) => mm(member.start[0]));
  const selfWeight = (profileName: string): number =>
    ((findProfile(profileName)?.massPerMetre ?? 0) * 9.81) / 1000;
  const area = (kNPerSquareMetre: number): number => kNPerSquareMetre * 1e-3;
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
      const found = nodes.findIndex((node) => near(node.x, x) && near(node.y, z));
      if (found >= 0) return found;
      nodes.push({ x, y: z, restraint });
      return nodes.length - 1;
    };
    const analysis: AnalysisMember[] = [];
    const nodeLoads: NodeCaseLoad[] = [];
    const free: FrameNode['restraint'] = [false, false, false];
    const purlins = purlinXs(y);
    const valleys = valleyLines(
      candidate.rafters.map((rafter) => ({
        start: rafter.start.map(mm),
        end: rafter.end.map(mm),
      })),
    );
    for (const rafter of candidate.rafters) {
      const profile = findProfile(rafter.profile);
      if (!profile) continue;
      const section = sectionProperties(profile);
      const flip = rafter.start[0] > rafter.end[0];
      const [first, second] = flip ? [rafter.end, rafter.start] : [rafter.start, rafter.end];
      const [x0, z0, x1, z1] = [mm(first[0]), mm(first[2]), mm(second[0]), mm(second[2])];
      const length = Math.hypot(x1 - x0, z1 - z0);
      // Roof loads per horizontal length, spread along the rafter.
      const perLength = (kN: number): number => (area(kN) * tributary * Math.abs(x1 - x0)) / length;
      const spanIndex = valleys.filter((valley) => valley < (x0 + x1) / 2).length;
      const roofSuction = (windCase: WindCase): number =>
        spanIndex === (windCase.from === 'left' ? 0 : valleys.length)
          ? WIND_COEFFICIENTS.roofSuction
          : DOWNWIND_ROOF_FACTOR * WIND_COEFFICIENTS.roofSuction;
      const stations = [x0, x1, ...purlins.filter((x) => x > x0 && x < x1)].sort((a, b) => a - b);
      const purlinGap = Math.max(
        ...stations.slice(1).map((x, index) => x - (stations[index] as number)),
      );
      analysis.push({
        geometry: {
          a: nodeAt(x0, z0, free),
          b: nodeAt(x1, z1, free),
          E: E_STEEL,
          A: section.area,
          I: section.inertia,
        },
        elementId: rafter.id,
        role: 'rafter',
        reversed: flip,
        ends: [true, true],
        loads: {
          G: { qx: 0, qy: -(perLength(loads.deadLoad) + selfWeight(rafter.profile)) },
          S: { qx: 0, qy: -perLength(loads.snowLoad) },
          ...Object.fromEntries(
            WIND_CASES.map((windCase) => [
              windCase.loadCase,
              {
                qx: 0,
                qy: perLength(
                  (roofSuction(windCase) + windCase.internalPressure) * loads.windPressure,
                ),
              },
            ]),
          ),
        },
        lengths: {
          major: length,
          minor: (purlinGap * length) / Math.max(Math.abs(x1 - x0), 1),
          lateralTorsional: (purlinGap * length) / Math.max(Math.abs(x1 - x0), 1),
        },
      });
    }
    const columnTops: { node: number; height: number; elementId: string }[] = [];
    const craneNodes: { node: number; height: number; elementId: string }[] = [];
    const columns = members.filter(
      (member) =>
        member.role === 'column' &&
        near(mm(member.start[1]), y) &&
        near(mm(member.end[1]), y) &&
        mm(member.start[0]) > low - tolerance &&
        mm(member.start[0]) < high + tolerance,
    );
    const brackets = members.filter(
      (member) =>
        member.role === 'beam' &&
        member.note === 'crane bracket' &&
        near(mm(member.start[1]), y) &&
        near(mm(member.end[1]), y),
    );
    const craneBeams = members.filter((member) => member.role === 'crane');
    // Crane rails of the frame: [column node, bracket height, eccentricity, capacity, runway G].
    const rails: {
      node: number;
      x: number;
      eccentricity: number;
      capacity: number;
      self: number;
    }[] = [];
    for (const column of columns) {
      const profile = findProfile(column.profile);
      if (!profile) continue;
      const [bottom, top] =
        column.start[2] <= column.end[2] ? [column.start, column.end] : [column.end, column.start];
      const [x, zBottom, zTop] = [mm(top[0]), mm(bottom[2]), mm(top[2])];
      const topNode = nodes.findIndex((node) => near(node.x, x) && near(node.y, zTop));
      if (topNode < 0) continue; // gable posts under the rafter span are not analysed
      const section = sectionProperties(profile);
      const height = zTop - zBottom;
      const railLevels = [
        zBottom,
        zTop,
        ...members
          .filter(
            (member) =>
              member.role === 'rail' &&
              Math.abs(mm(member.start[0]) - x) < 1000 &&
              Math.min(mm(member.start[1]), mm(member.end[1])) <= y + tolerance &&
              Math.max(mm(member.start[1]), mm(member.end[1])) >= y - tolerance,
          )
          .map((member) => mm(member.start[2]))
          .filter((z) => z > zBottom && z < zTop),
      ].sort((a, b) => a - b);
      const railGap = Math.max(
        ...railLevels.slice(1).map((z, index) => z - (railLevels[index] as number)),
      );
      const splits: number[] = [];
      for (const bracket of brackets) {
        const z = mm(bracket.start[2]);
        if (!near(mm(bracket.start[0]), x) || !(z > zBottom + tolerance && z < zTop - tolerance))
          continue;
        const [endX, endY] = [mm(bracket.end[0]), mm(bracket.end[1])];
        const runway = craneBeams.filter((beam) =>
          [beam.start, beam.end].some(
            (point) => near(mm(point[0]), endX) && near(mm(point[1]), endY),
          ),
        );
        const capacity =
          loads.craneCapacity ?? Math.max(0, ...runway.map((beam) => craneCapacityOf(beam) ?? 0));
        if (!(capacity > 0)) continue;
        splits.push(z);
        const runwayWeight = runway.reduce(
          (sum, beam) =>
            sum +
            (selfWeight(beam.profile) *
              Math.hypot(mm(beam.end[0] - beam.start[0]), mm(beam.end[1] - beam.start[1]))) /
              2,
          0,
        );
        rails.push({
          node: nodeAt(x, z, free),
          x: endX,
          eccentricity: endX - x,
          capacity,
          self: runwayWeight,
        });
        craneNodes.push({ node: nodeAt(x, z, free), height: z - zBottom, elementId: column.id });
      }
      const chain = [
        nodeAt(x, zBottom, [true, true, false]),
        ...[...new Set(splits)].sort((a, b) => a - b).map((z) => nodeAt(x, z, free)),
        topNode,
      ];
      const outer = near(x, low) ? 'left' : near(x, high) ? 'right' : null;
      // Net wall pressure in the wind direction: windward cpe − cpi, leeward |cpe| + cpi (outward).
      const windLoads: CaseLoads =
        outer === null
          ? {}
          : Object.fromEntries(
              WIND_CASES.map((windCase) => {
                const coefficient =
                  outer === windCase.from
                    ? WIND_COEFFICIENTS.windward - windCase.internalPressure
                    : WIND_COEFFICIENTS.leeward + windCase.internalPressure;
                const direction = windCase.from === 'left' ? 1 : -1;
                return [
                  windCase.loadCase,
                  {
                    qx: direction * area(coefficient * loads.windPressure) * tributary,
                    qy: 0,
                  },
                ];
              }),
            );
      chain.slice(1).forEach((node, index) => {
        analysis.push({
          geometry: {
            a: chain[index] as number,
            b: node,
            E: E_STEEL,
            A: section.area,
            I: section.inertia,
          },
          elementId: column.id,
          role: 'column',
          reversed: column.start[2] > column.end[2],
          ends: [index === 0, index === chain.length - 2],
          loads: {
            G: { qx: 0, qy: -selfWeight(column.profile) },
            ...windLoads,
          },
          lengths: { major: height, minor: height, lateralTorsional: railGap },
        });
      });
      columnTops.push({ node: topNode, height, elementId: column.id });
    }
    // Crane: rails paired left → right per crane bay; CL = maximum reaction on the left rail.
    const ordered = [...rails].sort((a, b) => a.x - b.x);
    ordered.forEach((rail, index) => {
      const isLeft = index % 2 === 0;
      const partner = ordered[isLeft ? index + 1 : index - 1];
      const actions = craneActions(
        rail.capacity,
        partner ? Math.abs(partner.x - rail.x) : high - low,
        loads.craneModel,
      );
      nodeLoads.push({
        node: rail.node,
        loadCase: 'G',
        fx: 0,
        fy: -rail.self,
        mz: -rail.self * rail.eccentricity,
      });
      // Drive HT acts in the same direction on both rails (CL / CR = +x / −x); skewing HS is a
      // guide reaction balanced by the other rail, hence opposite directions.
      const groups = [
        {
          max: actions.group1.max,
          min: actions.group1.min,
          h: [actions.group1.transverseMax, actions.group1.transverseMin],
          cases: ['CL', 'CR'],
          opposite: false,
        },
        {
          max: actions.group5.max,
          min: actions.group5.min,
          h: [actions.group5.skewMax, actions.group5.skewMin],
          cases: ['CL5', 'CR5'],
          opposite: true,
        },
        {
          max: actions.staticMax,
          min: actions.staticMin,
          h: [
            actions.group1.transverseMax / CRANE_FACTORS.phi5,
            actions.group1.transverseMin / CRANE_FACTORS.phi5,
          ],
          cases: ['CLk', 'CRk'],
          opposite: false,
        },
      ] as const;
      for (const group of groups) {
        for (const loadCase of group.cases) {
          const maximum = !partner || (loadCase === group.cases[0]) === isLeft;
          const reaction = maximum ? group.max : group.min;
          const transverse = maximum ? group.h[0] : group.h[1];
          nodeLoads.push({
            node: rail.node,
            loadCase,
            fx:
              (loadCase === group.cases[0] ? transverse : -transverse) *
              (group.opposite && !maximum ? -1 : 1),
            fy: -reaction,
            mz: -reaction * rail.eccentricity,
          });
        }
      }
    });
    if (analysis.length === 0) return [];
    const topXs = [...new Set(columnTops.map((top) => Math.round(nodes[top.node]?.x ?? 0)))].sort(
      (a, b) => a - b,
    );
    return [
      {
        label:
          candidates.filter((other) => other.y === y).length > 1
            ? `${gridLabel(y)} @x=${low}`
            : gridLabel(y),
        nodes,
        members: analysis,
        nodeLoads,
        columnTops,
        craneNodes,
        spans: topXs.slice(1).map((x, index): [number, number] => [topXs[index] as number, x]),
      },
    ];
  });
  return { frames, skipped };
}

export type NodeForce = { readonly node: number; readonly fx: number };

/** Linear analysis of a frame under factored load cases (+ extra horizontal node forces). */
export function solveCombination(
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

export interface BaseReaction {
  readonly frame: string;
  readonly columnId: string;
  /** Characteristic support reaction per load case, N: horizontal (+x) and vertical (+ up). */
  readonly cases: Partial<
    Record<LoadCase, { readonly horizontal: number; readonly vertical: number }>
  >;
}

const LOAD_CASES: ReadonlyArray<LoadCase> = [
  'G',
  'S',
  'WL',
  'WR',
  'WLs',
  'WRs',
  'CL',
  'CR',
  'CL5',
  'CR5',
];

/**
 * Characteristic base reactions of every analysed frame column, per load case (first-order).
 * @pure
 */
export function baseReactions(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: FrameLoads,
): BaseReaction[] {
  const { frames } = framesOf(doc, building, levelId, loads);
  return frames.flatMap((frame) => {
    const results = LOAD_CASES.map((loadCase) => ({
      loadCase,
      result: solveCombination(frame, { [loadCase]: 1 }),
    }));
    return frame.members.flatMap((member, index): BaseReaction[] => {
      const [a, b] = [frame.nodes[member.geometry.a], frame.nodes[member.geometry.b]];
      if (member.role !== 'column' || !member.ends[0] || !a || !b) return [];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const [c, s] = [(b.x - a.x) / length, (b.y - a.y) / length];
      const cases: Partial<Record<LoadCase, { horizontal: number; vertical: number }>> = {};
      for (const { loadCase, result } of results) {
        const forces = result?.members[index];
        if (!forces) continue;
        const [axial, shear] = [-forces.axial[0], forces.shear[0]];
        cases[loadCase] = { horizontal: c * axial - s * shear, vertical: s * axial + c * shear };
      }
      return [{ frame: frame.label, columnId: member.elementId, cases }];
    });
  });
}
