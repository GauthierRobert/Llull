/**
 * Code stresses from element forces (07 PST §5.6): sustained S_L, displacement stress range S_E and the occasional state, at the end nodes of every
 * element and at the interior bending extremum of a loaded element, with the SIFs of the bends. B31.3 (2016+ form) and B31.1 as named by the rule set.
 * Forces are the frame3d local end forces `[N Vy Vz T My Mz] x 2` (applied to the element by its nodes); N, V and M at a station x follow from
 * equilibrium of the element part before the cut.
 */

import { localAxes } from '@lib/frame3d/element';
import type { FramePoint } from '@lib/frame3d/types';
import type { BuiltModel } from '../model/build';
import type { OperatingConditions } from '../model/schema';
import type { CaseState } from '../solve/run';
import { computeAllowables } from './allowables';

export interface StressRow {
  readonly case: string;
  readonly caseType: 'OPE' | 'SUS' | 'EXP' | 'OCC' | 'HYD';
  readonly element: string;
  readonly pipeId: string;
  /** Node id (`N3`) at an element end, null at an interior station. */
  readonly node: string | null;
  readonly xMm: number;
  readonly stressMPa: number;
  readonly allowableMPa: number;
  readonly ratio: number;
  readonly rule: string;
  readonly equation: string;
  readonly sif: { readonly ii: number; readonly io: number };
}

interface Station {
  readonly x: number;
  readonly end: 'a' | 'b' | null;
  readonly tension: number;
  readonly torsion: number;
  readonly my: number;
  readonly mz: number;
}

const BAR_TO_MPA = 0.1;
/** Intervals sampled along an element to find the interior maximum of the resultant moment. */
const SAMPLES = 32;
const nodeId = (index: number): string => `N${index + 1}`;

function stations(forces: ArrayLike<number>, base: number, length: number, load: readonly [number, number, number]): Station[] {
  const [N, Vy, Vz, T, My, Mz] = [0, 1, 2, 3, 4, 5].map((i) => forces[base + i] as number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [wx, wy, wz] = load;
  const at = (x: number, end: 'a' | 'b' | null): Station => ({
    x,
    end,
    tension: -N - wx * x,
    torsion: -T,
    my: -(My + x * Vz + (x * x * wz) / 2),
    mz: -(Mz - x * Vy - (x * x * wy) / 2),
  });
  const result = [at(0, 'a'), at(length, 'b')];
  for (const x of [wz === 0 ? NaN : -Vz / wz, wy === 0 ? NaN : -Vy / wy])
    if (x > 1e-6 * length && x < length * (1 - 1e-6)) result.push(at(x, null));
  // the resultant bending moment of a load that is not in one plane peaks where neither component does: sample it and keep a true interior maximum
  const resultant = (x: number): number => Math.hypot(at(x, null).my, at(x, null).mz);
  const ends = Math.max(resultant(0), resultant(length));
  let best = { x: NaN, m: ends };
  for (let i = 1; i < SAMPLES; i++) {
    const x = (length * i) / SAMPLES;
    const m = resultant(x);
    if (m > best.m * (1 + 1e-9)) best = { x, m };
  }
  if (Number.isFinite(best.x) && !result.some((known) => Math.abs(known.x - best.x) < length / (2 * SAMPLES)))
    result.push(at(best.x, null));
  return result;
}

export interface CodeStressInput {
  readonly built: BuiltModel;
  readonly conditions: OperatingConditions;
  readonly states: readonly CaseState[];
}

export interface CodeStressResult {
  readonly rows: readonly StressRow[];
  readonly occasionalMPa: number;
  readonly allowables: { readonly f: number; readonly SA1aMPa: number; readonly occasionalFactor: number };
}

/** Stress rows of every case (sustained and occasional first so the expansion allowable can use S_L per node). */
export function codeStresses({ built, conditions, states }: CodeStressInput): CodeStressResult {
  const { set } = built;
  const material = conditions.material;
  const base = computeAllowables(set, {
    ScMPa: material.ScMPa,
    ShMPa: material.ShMPa,
    cycles: conditions.cycles,
    ferrousLowStrength: material.ferrousLowStrength,
    occasionalClass: 'default',
  });
  const elementAxes = built.layout.elements.map((element) =>
    localAxes(built.layout.nodes[element.a] as FramePoint, built.layout.nodes[element.b] as FramePoint),
  );
  const b311 = set.code === 'B31.1';
  const millFactor = 1 - (conditions.millTolerancePct ?? 0) / 100;
  const rows: StressRow[] = [];
  const sustainedAtNode = new Map<string, number>();

  const evaluate = (state: CaseState, expansion: boolean): StressRow[] => {
    const out: StressRow[] = [];
    built.layout.elements.forEach((element, index) => {
      const axes = elementAxes[index];
      if (axes === null || axes === undefined || element.component?.rigid === true) return;
      const R = axes.rotation;
      const q = [state.uniform[index * 3] as number, state.uniform[index * 3 + 1] as number, state.uniform[index * 3 + 2] as number];
      const local = [0, 1, 2].map(
        (r) =>
          (R[r * 3] as number) * (q[0] as number) +
          (R[r * 3 + 1] as number) * (q[1] as number) +
          (R[r * 3 + 2] as number) * (q[2] as number),
      );
      const toLocal = (normal: readonly [number, number, number] | undefined): number[] | null =>
        normal === undefined
          ? null
          : [0, 1, 2].map(
              (r) => (R[r * 3] as number) * normal[0] + (R[r * 3 + 1] as number) * normal[1] + (R[r * 3 + 2] as number) * normal[2],
            );
      const bendNormal = toLocal(element.bend?.normal);
      // wall of the stress section: nominal for the displacement range; less the mill under-tolerance (when chosen) and the corrosion allowance for sustained and occasional; hydrotest: the new pipe, less the mill tolerance only
      const wallOf = (nominal: number): number =>
        expansion ? nominal : nominal * millFactor - (state.type === 'HYD' ? 0 : conditions.corrosionAllowanceMm);
      const wall = wallOf(element.wallMm);
      const od = element.odMm;
      const inner = od - 2 * wall;
      const area = (Math.PI / 4) * (od ** 2 - inner ** 2);
      const pipeZ = (Math.PI / 32) * ((od ** 4 - inner ** 4) / od);
      const pressure = state.pressureBar * BAR_TO_MPA;
      for (const s of stations(state.elementForces, index * 12, axes.length, local as [number, number, number])) {
        const node = s.end === null ? null : nodeId(s.end === 'a' ? element.a : element.b);
        const endSif =
          s.end === null ? undefined : element.endSifs?.find((entry) => entry.node === (s.end === 'a' ? element.a : element.b));
        const ii = endSif?.ii ?? element.bend?.ii ?? 1;
        const io = endSif?.io ?? element.bend?.io ?? 1;
        const nLocal = endSif === undefined ? bendNormal : toLocal(endSif.normal);
        // the branch end of a tee: effective section modulus Z_e = pi r2^2 T_e, T_e the lesser of the header wall and i_i x branch wall (B31.3 319.4.4)
        const Z =
          endSif?.headerWallMm === undefined ? pipeZ : Math.PI * ((od - wall) / 2) ** 2 * Math.min(wallOf(endSif.headerWallMm), ii * wall);
        const bending = Math.hypot(s.my, s.mz);
        const inPlane = nLocal === null ? bending : Math.abs(s.my * (nLocal[1] as number) + s.mz * (nLocal[2] as number));
        const outPlane = nLocal === null ? 0 : Math.sqrt(Math.max(0, bending ** 2 - inPlane ** 2));
        let stress: number;
        let limit: number;
        let equation: string;
        let rule: string;
        if (expansion) {
          if (b311) {
            stress = (ii * Math.hypot(bending, s.torsion)) / Z;
          } else {
            const Sb = Math.hypot(ii * inPlane, io * outPlane) / Z;
            stress = Math.sqrt(Sb ** 2 + 4 * (s.torsion / (2 * Z)) ** 2);
          }
          const sustained = Math.max(
            sustainedAtNode.get(node ?? '') ?? 0,
            ...[element.a, element.b].map((n) => sustainedAtNode.get(nodeId(n)) ?? 0),
          );
          const allowed = computeAllowables(set, {
            ScMPa: material.ScMPa,
            ShMPa: material.ShMPa,
            cycles: conditions.cycles,
            ferrousLowStrength: material.ferrousLowStrength,
            occasionalClass: 'default',
            ...(sustainedAtNode.size > 0 ? { sustainedStressMPa: sustained } : {}),
          });
          limit = allowed.SAMPa;
          equation = `S_E range vs S_A eq (${allowed.equation})`;
          rule = b311 ? 'B311-EXP' : 'B313-SA-1A';
        } else {
          const axial = s.tension / area + (pressure * inner ** 2) / (od ** 2 - inner ** 2);
          if (b311) {
            const iSif = Math.max(1, 0.75 * ii);
            stress = (pressure * od) / (4 * wall) + (iSif * Math.hypot(bending, s.torsion)) / Z;
            equation = 'P Do / 4t + 0.75 i M_A / Z';
          } else {
            const Sb = Math.hypot(Math.max(1, 0.75 * ii) * inPlane, Math.max(1, 0.75 * io) * outPlane) / Z;
            stress = Math.sqrt((Math.abs(axial) + Sb) ** 2 + (2 * (s.torsion / (2 * Z))) ** 2);
            equation = 'S_L = sqrt((|S_a| + S_b)^2 + (2 S_t)^2)';
          }
          limit =
            state.type === 'OCC'
              ? base.occasionalMPa
              : state.type === 'HYD'
                ? (conditions.hydro?.allowableMPa ?? Number.NaN)
                : material.ShMPa;
          rule =
            state.type === 'OCC'
              ? b311
                ? 'B311-OCC'
                : 'B313-OCC'
              : state.type === 'HYD'
                ? b311
                  ? 'B311-HYD'
                  : 'B313-HYD'
                : 'B313-SA-1A';
          if (state.type === 'SUS' && node !== null) sustainedAtNode.set(node, Math.max(sustainedAtNode.get(node) ?? 0, stress));
        }
        out.push({
          case: state.name,
          caseType: state.type,
          element: element.id,
          pipeId: element.pipeId,
          node,
          xMm: s.x,
          stressMPa: stress,
          allowableMPa: limit,
          ratio: stress / limit,
          rule,
          equation,
          sif: { ii, io },
        });
      }
    });
    return out;
  };

  // scalar / srss occasional combination: the code stresses of the terms at the element end stations are added (sum of |factor| x stress) or root-sum-squared
  const combined = (state: CaseState): StressRow[] => {
    const combination = state.combination as NonNullable<CaseState['combination']>;
    const perTerm = combination.terms.map((term) => ({
      factor: Math.abs(term.factor),
      rows: evaluate(term.state, false).filter((row) => row.node !== null),
    }));
    return (perTerm[0]?.rows ?? []).map((row, index) => {
      const parts = perTerm.map((term) => term.factor * (term.rows[index]?.stressMPa ?? 0));
      const stress = combination.method === 'scalar' ? parts.reduce((a, b) => a + b, 0) : Math.sqrt(parts.reduce((a, b) => a + b * b, 0));
      return {
        ...row,
        case: state.name,
        caseType: 'OCC',
        stressMPa: stress,
        allowableMPa: base.occasionalMPa,
        ratio: stress / base.occasionalMPa,
        rule: b311 ? 'B311-OCC' : 'B313-OCC',
        equation: combination.method === 'scalar' ? 'sum of |factor| x term stress' : 'sqrt(sum of (factor x term stress)^2)',
      };
    });
  };

  // OPE reports displacements and loads; the code limits apply to the sustained, occasional and expansion states
  for (const state of states)
    if (state.type === 'SUS' || state.type === 'OCC' || state.type === 'HYD')
      rows.push(...(state.combination === undefined ? evaluate(state, false) : combined(state)));
  for (const state of states) if (state.type === 'EXP') rows.push(...evaluate(state, true));
  return {
    rows,
    occasionalMPa: base.occasionalMPa,
    allowables: { f: base.f, SA1aMPa: base.SA1aMPa, occasionalFactor: base.occasionalFactor },
  };
}
