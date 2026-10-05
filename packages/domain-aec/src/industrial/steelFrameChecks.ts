/**
 * Member verification of a moment frame from its solved load cases: beams (rigid ends → end moments,
 * hogging lateral-torsional buckling over the hogging length), columns (N + M interaction §6.3.3 on
 * the axis the frame plane bends), storey drift and sway stability. Moments are amplified by
 * 1/(1 − 1/αcr) when αcr < 10 (EN 1993-1-1 §5.2.2(5)); the buckling length is the storey piece.
 * @layer domain-aec
 * @pure
 */

import type { FrameResult } from '@lib/frame2d';
import { memberBuckling } from './steelDesign';
import type { MomentFrame } from './steelFrameDetect';
import type { BarLayout, FrameSystem } from './steelFrameModel';
import {
  columnBendingAxis,
  shearReducedMoment,
  weakAxisBuckling,
  weakAxisResistance,
} from './steelFrameSection';
import { driftOf, type FrameSolutions } from './steelFrameSolve';
import type { BeamResult } from './steelFraming';
import type { SteelBar } from './steelMemberBars';
import {
  analysedRow,
  beamSection,
  columnSection,
  metres,
  skippedRow,
  ULS_COMBINATION,
  type CheckLine,
  type MemberRow,
} from './steelMemberRows';

export interface FrameCheckInput {
  readonly frame: MomentFrame;
  readonly system: FrameSystem;
  readonly solutions: FrameSolutions;
  readonly deflectionRatio: number;
  readonly swayRatio: number;
  /** Text of φ for the combination names, e.g. "φ = 1/200". */
  readonly phiText: string;
}

const kilo = (value: number): number => value / 1000;
const mega = (value: number): number => value / 1e6;

const combinationOf = (input: FrameCheckInput): string =>
  `${ULS_COMBINATION} + notional horizontal force ${input.phiText} (frame)`;

/** Keeps the line of highest utilisation. */
const worstOf = (current: CheckLine | undefined, next: CheckLine): CheckLine =>
  current === undefined || next.utilisation > current.utilisation ? next : current;

interface Diagram {
  /** Bending moment at every station, N·mm, sagging +. */
  readonly stations: number[];
  /** Largest sagging moment including span peaks, N·mm. */
  readonly sagging: number;
  readonly hogging: number;
  readonly shear: number;
  readonly compression: number;
}

function beamDiagram(result: FrameResult, layout: BarLayout, amplification: number): Diagram {
  const forces = layout.members.map((index) => result.members[index]);
  const stations: number[] = [];
  let interior = 0;
  let shear = 0;
  let compression = 0;
  forces.forEach((member, index) => {
    if (!member) return;
    const [low, high] = layout.reversed
      ? [member.moment[1], member.moment[0]]
      : [member.moment[0], member.moment[1]];
    if (index === 0) stations.push(low * amplification);
    stations.push(high * amplification);
    const peak = member.maxMoment * amplification;
    if (peak > Math.max(Math.abs(low), Math.abs(high)) * amplification + 1) {
      interior = Math.max(interior, peak);
    }
    shear = Math.max(shear, ...member.shear.map(Math.abs));
    compression = Math.max(compression, ...member.axial.map((value) => -value));
  });
  return {
    stations,
    sagging: Math.max(0, interior, ...stations),
    hogging: Math.max(0, ...stations.map((value) => -value)),
    shear,
    compression,
  };
}

/** Length over which the hogging moment at either end persists before it changes sign, mm. */
function hoggingLength(diagram: Diagram, layout: BarLayout, length: number): number {
  const along = (from: 'start' | 'end'): number => {
    const order = from === 'start' ? diagram.stations : [...diagram.stations].reverse();
    const fractions =
      from === 'start' ? layout.fractions : layout.fractions.map((t) => 1 - t).reverse();
    if ((order[0] ?? 0) >= 0) return 0;
    for (let index = 1; index < order.length; index++) {
      const [before, after] = [order[index - 1] as number, order[index] as number];
      if (after >= 0) {
        const share = before / (before - after);
        const [t0, t1] = [fractions[index - 1] as number, fractions[index] as number];
        return (t0 + share * (t1 - t0)) * length;
      }
    }
    return length;
  };
  return Math.max(along('start'), along('end'));
}

function beamRow(
  bar: SteelBar,
  result: BeamResult,
  layout: BarLayout,
  input: FrameCheckInput,
): MemberRow {
  const gate = beamSection(bar);
  if ('skipped' in gate) return gate.skipped;
  const { profile, resistance } = gate;
  const { solutions } = input;
  const length = bar.length;
  const restrained = result.loads.floorSupport || result.loads.lineSupport;
  const combination = combinationOf(input);
  let interaction: CheckLine | undefined;
  let section: CheckLine | undefined;
  let shearLine: CheckLine | undefined;
  let maxMoment = 0;
  let maxShear = 0;
  let maxCompression = 0;
  const joints: [number, number] = [0, 0];
  for (const ulsResult of solutions.uls) {
    const diagram = beamDiagram(ulsResult, layout, solutions.amplification);
    const hogLength = hoggingLength(diagram, layout, length);
    const compression = diagram.compression;
    const sagging = memberBuckling(profile, bar.fy, compression, diagram.sagging, {
      major: length,
      minor: length,
      lateralTorsional: restrained ? 1 : length,
    });
    const hogging = memberBuckling(profile, bar.fy, compression, diagram.hogging, {
      major: length,
      minor: length,
      lateralTorsional: Math.max(hogLength, 1),
    });
    const worstBuckling = sagging.utilisation >= hogging.utilisation ? sagging : hogging;
    const governingMoment =
      sagging.utilisation >= hogging.utilisation ? diagram.sagging : diagram.hogging;
    interaction = worstOf(interaction, {
      name: 'frame N+M (§6.3.3)',
      utilisation: worstBuckling.utilisation,
      combination,
      detail: `${profile.name} L ${metres(length)} m${solutions.amplification > 1 ? `, sway ×${solutions.amplification.toFixed(2)}` : ''}: M ${mega(governingMoment).toFixed(1)} kNm (${sagging.utilisation >= hogging.utilisation ? 'sagging' : `hogging, LTB over ${metres(hogLength)} m`}) with N ${kilo(compression).toFixed(1)} kN compression, χ ${Math.min(worstBuckling.chiMajor, worstBuckling.chiMinor).toFixed(2)}, χLT ${worstBuckling.chiLateralTorsional.toFixed(2)}`,
    });
    const hogResistance = shearReducedMoment(profile, bar.fy, kilo(diagram.shear));
    const sectionUtilisation = Math.max(
      compression / resistance.axial + diagram.hogging / hogResistance.moment,
      compression / resistance.axial + diagram.sagging / resistance.moment,
    );
    section = worstOf(section, {
      name: 'cross-section N+M (§6.2.9)',
      utilisation: sectionUtilisation,
      combination,
      detail: `${profile.name} class ${resistance.sectionClass}: M ${mega(Math.max(diagram.hogging, diagram.sagging)).toFixed(1)} kNm ≤ Mc,Rd ${mega(hogResistance.moment).toFixed(1)} kNm${hogResistance.reduced ? ' (reduced for shear, §6.2.8)' : ''} with N ${kilo(compression).toFixed(1)} kN`,
    });
    shearLine = worstOf(shearLine, {
      name: 'shear (§6.2.6)',
      utilisation: diagram.shear / resistance.shear,
      combination,
      detail: `${profile.name}: V ${kilo(diagram.shear).toFixed(1)} kN ≤ Vpl,Rd ${kilo(resistance.shear).toFixed(0)} kN`,
    });
    maxMoment = Math.max(maxMoment, diagram.sagging, diagram.hogging);
    maxShear = Math.max(maxShear, diagram.shear);
    maxCompression = Math.max(maxCompression, compression);
    const ends: [number, number] = [
      diagram.stations[0] ?? 0,
      diagram.stations[diagram.stations.length - 1] ?? 0,
    ];
    ends.forEach((moment, index) => {
      if (Math.abs(moment) > Math.abs(joints[index] ?? 0)) joints[index] = moment;
    });
  }
  const deflection = deflectionLine(bar, layout, solutions.slsGravity, input.deflectionRatio);
  const jointForces: Record<string, number> = {};
  if (bar.startJoint === 'rigid') jointForces['jointMomentStart'] = mega(joints[0]);
  if (bar.endJoint === 'rigid') jointForces['jointMomentEnd'] = mega(joints[1]);
  return analysedRow(bar, [interaction, section, shearLine, deflection.line], {
    MEd: mega(maxMoment),
    VEd: kilo(maxShear),
    NEd: kilo(maxCompression),
    deflection: deflection.value,
    ...jointForces,
    amplification: solutions.amplification,
  });
}

function deflectionLine(
  bar: SteelBar,
  layout: BarLayout,
  result: FrameResult,
  ratio: number,
): { line: CheckLine; value: number } {
  const lift = layout.nodes.map((node) => result.displacements[node]?.[1] ?? 0);
  const first = lift[0] ?? 0;
  const last = lift[lift.length - 1] ?? 0;
  const [freeStart, freeEnd] = layout.freeEnds;
  const cantilever = freeStart !== freeEnd;
  const root = freeStart ? last : first;
  const sag = lift.map((value, index) => {
    const t = layout.fractions[index] ?? 0;
    return Math.abs(value - (cantilever ? root : first + (last - first) * t));
  });
  const value = Math.max(0, ...sag);
  const limit = (cantilever ? 2 * bar.length : bar.length) / ratio;
  const label = cantilever ? `cantilever 2L/${ratio}` : `L/${ratio}`;
  return {
    value,
    line: {
      name: `deflection (${label})`,
      utilisation: value / limit,
      combination: 'SLS G + Q',
      detail: `${bar.profileName} L ${metres(bar.length)} m: δ ${value.toFixed(1)} mm ≤ ${label} = ${limit.toFixed(1)} mm`,
    },
  };
}

function columnRow(bar: SteelBar, layout: BarLayout, input: FrameCheckInput): MemberRow {
  const gate = columnSection(bar);
  if ('skipped' in gate) return gate.skipped;
  const { profile, sectionClass, resistance } = gate;
  const axis = columnBendingAxis(profile, bar.roll, input.frame.direction);
  if (axis === null) {
    return skippedRow(
      bar,
      `${profile.name}: roll ${((bar.roll * 180) / Math.PI).toFixed(0)}° lies between the principal axes — set roll 0 or π/2 so the frame plane bends one principal axis`,
    );
  }
  const { solutions, system } = input;
  const bending =
    axis === 'strong' ? resistance : { ...resistance, ...weakAxisResistance(profile, bar.fy) };
  const combination = combinationOf(input);
  const axisText = axis === 'strong' ? 'strong axis' : 'weak axis';
  let interaction: CheckLine | undefined;
  let section: CheckLine | undefined;
  let shearLine: CheckLine | undefined;
  let maxMoment = 0;
  let maxCompression = 0;
  let maxShear = 0;
  let baseMoment = 0;
  for (const ulsResult of solutions.uls) {
    layout.members.forEach((memberIndex, index) => {
      const forces = ulsResult.members[memberIndex];
      const geometry = system.members[memberIndex]?.geometry;
      if (!forces || !geometry) return;
      const [bottom, top] = [system.nodes[geometry.a], system.nodes[geometry.b]];
      const length = Math.abs((top?.y ?? 0) - (bottom?.y ?? 0));
      const compression = Math.max(0, ...forces.axial.map((value) => -value));
      const moment = forces.maxMoment * solutions.amplification;
      const shear = Math.max(...forces.shear.map(Math.abs));
      const zText = `z ${metres(bottom?.y ?? 0)}–${metres(top?.y ?? 0)} m`;
      const buckling =
        axis === 'strong'
          ? memberBuckling(profile, bar.fy, compression, moment, {
              major: length,
              minor: length,
              lateralTorsional: length,
            })
          : undefined;
      const weak =
        axis === 'weak'
          ? weakAxisBuckling(profile, bar.fy, compression, moment, length)
          : undefined;
      const utilisation = buckling?.utilisation ?? weak?.utilisation ?? 0;
      const chi = buckling ? Math.min(buckling.chiMajor, buckling.chiMinor) : (weak?.chi ?? 1);
      interaction = worstOf(interaction, {
        name: 'frame N+M (§6.3.3)',
        utilisation,
        combination,
        detail: `${profile.name} (${axisText} in the frame plane), ${zText}, Lcr ${metres(length)} m${solutions.amplification > 1 ? `, sway ×${solutions.amplification.toFixed(2)}` : ''}: N ${kilo(compression).toFixed(0)} kN with M ${mega(moment).toFixed(1)} kNm, χ ${chi.toFixed(2)}`,
      });
      const maxAxial = Math.max(...forces.axial.map(Math.abs));
      section = worstOf(section, {
        name: 'cross-section N+M (§6.2.9)',
        utilisation: maxAxial / resistance.axial + moment / bending.moment,
        combination,
        detail: `${profile.name} class ${sectionClass} (${axisText}), ${zText}: N ${kilo(maxAxial).toFixed(0)} kN ≤ Npl,Rd ${kilo(resistance.axial).toFixed(0)} kN with M ${mega(moment).toFixed(1)} kNm ≤ M${axis === 'strong' ? '' : 'z'},Rd ${mega(bending.moment).toFixed(1)} kNm`,
      });
      shearLine = worstOf(shearLine, {
        name: 'shear (§6.2.6)',
        utilisation: shear / bending.shear,
        combination,
        detail: `${profile.name} (${axisText}) ${zText}: V ${kilo(shear).toFixed(1)} kN ≤ Vpl,Rd ${kilo(bending.shear).toFixed(0)} kN`,
      });
      maxMoment = Math.max(maxMoment, moment);
      maxCompression = Math.max(maxCompression, compression);
      maxShear = Math.max(maxShear, shear);
      if (index === 0)
        baseMoment = Math.max(baseMoment, Math.abs(forces.moment[0]) * solutions.amplification);
    });
  }
  let drift: CheckLine | undefined;
  for (const piece of system.storeyPieces.filter((candidate) => candidate.columnId === bar.id)) {
    for (const swayResult of solutions.slsSway) {
      const delta = driftOf(swayResult, piece);
      drift = worstOf(drift, {
        name: `sway h/${input.swayRatio}`,
        utilisation: (delta / piece.height) * input.swayRatio,
        combination: 'SLS G + Q + notional horizontal force (frame)',
        detail: `${profile.name} storey ${piece.storey + 1}: drift ${delta.toFixed(1)} mm ≤ h/${input.swayRatio} = ${(piece.height / input.swayRatio).toFixed(1)} mm (h ${metres(piece.height)} m)`,
      });
    }
  }
  const stability: CheckLine | undefined =
    Number.isFinite(solutions.alphaCritical) && solutions.criticalColumn === bar.id
      ? {
          name: 'sway stability αcr ≥ 3',
          utilisation: 3 / solutions.alphaCritical,
          combination: 'ULS vertical loads + V/200 (Horne)',
          detail: `${input.frame.label}: αcr ${solutions.alphaCritical.toFixed(1)} ≥ 3 (moments amplified by 1/(1 − 1/αcr) below 10)`,
        }
      : undefined;
  return analysedRow(bar, [interaction, section, shearLine, drift, stability], {
    NEd: kilo(maxCompression),
    MEd: mega(maxMoment),
    VEd: kilo(maxShear),
    ...(bar.baseFixity === 'fixed' ? { baseMoment: mega(baseMoment) } : {}),
    amplification: solutions.amplification,
    ...(Number.isFinite(solutions.alphaCritical) ? { alphaCr: solutions.alphaCritical } : {}),
  });
}

/** One verdict row per member of the frame, keyed by member id. */
export function frameRows(input: FrameCheckInput): Map<string, MemberRow> {
  const rows = new Map<string, MemberRow>();
  for (const column of input.frame.columns) {
    const layout = input.system.layouts.get(column.id);
    if (layout) rows.set(column.id, columnRow(column, layout, input));
  }
  for (const beam of input.frame.beams) {
    const layout = input.system.layouts.get(beam.loads.bar.id);
    if (layout) rows.set(beam.loads.bar.id, beamRow(beam.loads.bar, beam, layout, input));
  }
  return rows;
}
