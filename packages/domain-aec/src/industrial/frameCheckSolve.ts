/**
 * frameCheck: frameCheckSolve.
 * @layer domain-aec
 */

import type { BuildingModel, MomentConnectionElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { solveFrame, type FrameResult } from '@lib/frame2d';
import { fromMm } from '../model';
import { buildingConnectionSolids } from './evaluate';
import { type FrameModel, type WindCase, type LoadCase } from './frameModelTypes';
import { solveCombination } from './frameModelSolve';
import { boltResistance } from './steelDesign';

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
export function ultimateCombinations(
  wind: boolean,
  crane: boolean,
  windCases: ReadonlyArray<WindCase>,
): Combination[] {
  const combinations: Combination[] = [
    { name: '1.35G+1.5S (→)', factors: { G: 1.35, S: 1.5 }, sway: 1 },
    { name: '1.35G+1.5S (←)', factors: { G: 1.35, S: 1.5 }, sway: -1 },
  ];
  const winds = windCases.map((windCase) => ({
    load: windCase.loadCase,
    label: windCase.label,
    sway: windCase.from === 'left' ? (1 as const) : (-1 as const),
  }));
  if (wind) {
    for (const direction of winds) {
      combinations.push(
        {
          name: `1.35G+1.5${direction.label}+0.75S`,
          factors: { G: 1.35, [direction.load]: 1.5, S: 0.75 },
          sway: direction.sway,
        },
        {
          name: `1.0G+1.5${direction.label}`,
          factors: { G: 1, [direction.load]: 1.5 },
          sway: direction.sway,
        },
      );
    }
  }
  if (crane) {
    // Crane load groups 1 (C) and 5 (C5) of EN 1991-3 Tab. 2.2 leading (with and without snow, alone
    // or with either wind), then wind leading with the crane accompanying (ψ0 = 1.0, Tab. A.2).
    const sides = [
      { load: 'CL', label: 'C(left)', sway: 1 },
      { load: 'CR', label: 'C(right)', sway: -1 },
      { load: 'CL5', label: 'C5(left)', sway: 1 },
      { load: 'CR5', label: 'C5(right)', sway: -1 },
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
export function solveUltimate(frame: FrameModel, combination: Combination): UltimateResult | null {
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
  const solids = buildingConnectionSolids(doc, building, connection);
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

export const SLS_VERTICAL = 200;

export const SLS_SWAY = 150;

export const SLS_CRANE = 400;
