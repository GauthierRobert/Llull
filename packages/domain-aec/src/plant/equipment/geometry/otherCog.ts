/**
 * Centre of gravity of an exchanger, a tank or a pump (plant 03 EQP-FU2), equipment frame (origin = plan location at the level elevation, +Z up). The
 * same lumped-mass method as `vesselCog` over the mass parts of `exchangerMass` / `tankMass`; each part is a lump at the centroid of its solid.
 * Exchangers lie along X on the tube axis (elevation = datum); a tank is on the axis x = y = 0.
 */

import type { Vec3 } from '@core/model/vectors';
import type { ExchangerTemplate, PumpTemplate, TankTemplate } from '../plantData';
import { resolveExchanger, type ExchangerEnd } from './exchangerFrame';
import { exchangerMass } from './exchangerMass';
import { headFillCentroid, headMetalCentroid } from './headCentroid';
import { pumpLayout } from './pumpLayout';
import { courseBottoms, roofRise, tankBase, tankLiquidVolume } from './tankFrame';
import { tankMass } from './tankMass';
import { TEST_WATER_KG_PER_M3 } from './vesselMass';
import { centreOf, type CogPart, type VesselCog } from './vesselCog';

const NOZZLE_APPROXIMATION = 'each nozzle (neck + flange) is one lump at the middle between the wall point and the flange face';

type EndPart = 'Tubesheet' | 'Channel' | 'Cover' | 'Bonnet' | 'ShellCover';

/** x of the centroid of one end part of an exchanger on the tube axis. */
function endPartX(end: ExchangerEnd, radius: number, kind: EndPart): number {
  if (kind === 'Tubesheet') return (end.tubesheetFrom + end.tubesheetTo) / 2;
  if (kind === 'Channel') return (end.channelFrom + end.channelTo) / 2;
  if (kind === 'Cover') return end.tangent + (end.sign * end.channelThickness) / 2;
  return end.tangent + end.sign * headMetalCentroid(end.head, radius, end.channelThickness);
}

/** Liquid lumps of one end (channel bore + closure cavity). */
function endLiquid(end: ExchangerEnd, radius: number, kgPerUnit3: number, name: string, z: number): CogPart[] {
  const lumps: CogPart[] = [];
  if (end.hasTubesheet)
    lumps.push({
      part: `liquid ${name} channel`,
      kg: Math.PI * radius * radius * end.channelLength * kgPerUnit3,
      at: [(end.channelFrom + end.channelTo) / 2, 0, z],
    });
  if (end.closure !== 'flat') {
    const cavity = headFillCentroid(end.head, radius, end.head.depth);
    lumps.push({ part: `liquid ${name} closure`, kg: cavity.volume * kgPerUnit3, at: [end.tangent + end.sign * cavity.centroid, 0, z] });
  }
  return lumps;
}

/**
 * Centre of gravity of the empty, operating and test states of a horizontal exchanger. Operating = each side that has a specificGravity, full of that fluid.
 * @param scale metres per document unit
 * @invariant empty.kg = exchangerMass.emptyKg (+ nozzles); the liquid lumps of a side sum to exchangerVolumes for that side
 */
export function exchangerCog(scale: number, template: ExchangerTemplate, nozzleLumps: readonly CogPart[]): VesselCog {
  const geometry = resolveExchanger(template);
  const mass = exchangerMass(scale, template, geometry);
  const { radius, datum, shellFrom, shellTo } = geometry;
  const { tubes } = template;
  const shellMid = (shellFrom + shellTo) / 2;
  const bundleMid = geometry.front.tubesheetFrom + tubes.length / 2;
  const xOf = (part: string): number => {
    if (part === 'shell') return shellMid;
    if (part === 'tubes') return bundleMid;
    return endPartX(part.startsWith('front') ? geometry.front : geometry.rear, radius, part.replace(/^(front|rear)/, '') as EndPart);
  };
  const metal = mass.parts.map((part): CogPart => ({ part: part.part, kg: part.kg, at: [xOf(part.part), 0, datum] }));
  const empty = [...metal, ...nozzleLumps];
  const cubic = scale ** 3;
  const bore = tubes.outsideDiameter - 2 * tubes.wallThickness;
  const tubesOutside = (tubes.count * Math.PI * tubes.outsideDiameter ** 2) / 4;
  const closedByCover = geometry.rear.closure === 'shell_cover';
  const shellSide = (kgPerUnit3: number): CogPart[] => [
    {
      part: 'liquid shell side',
      kg: (Math.PI * radius * radius - tubesOutside) * geometry.shellLength * kgPerUnit3,
      at: [shellMid, 0, datum] as Vec3,
    },
    ...(closedByCover ? endLiquid(geometry.rear, radius, kgPerUnit3, 'rear', datum) : []),
  ];
  const tubeSide = (kgPerUnit3: number): CogPart[] => [
    {
      part: 'liquid tubes',
      kg: ((tubes.count * Math.PI * bore * bore) / 4) * tubes.length * kgPerUnit3,
      at: [bundleMid, 0, datum] as Vec3,
    },
    ...endLiquid(geometry.front, radius, kgPerUnit3, 'front', datum),
    ...(closedByCover ? [] : endLiquid(geometry.rear, radius, kgPerUnit3, 'rear', datum)),
  ];
  const water = TEST_WATER_KG_PER_M3 * cubic;
  const operating: CogPart[] = [
    ...(mass.shellSide.specificGravity === null ? [] : shellSide(mass.shellSide.specificGravity * 1000 * cubic)),
    ...(mass.tubeSide.specificGravity === null ? [] : tubeSide(mass.tubeSide.specificGravity * 1000 * cubic)),
  ];
  return {
    parts: empty,
    liquidParts: operating,
    empty: centreOf(empty),
    operating: centreOf([...empty, ...operating]),
    test: centreOf([...empty, ...shellSide(water), ...tubeSide(water)]),
    defaulted: [],
    approximations: [
      NOZZLE_APPROXIMATION,
      'tubes: one lump at the middle of the tube length; the U-bends and floating head of U / P / S / T / W rears are not modelled',
      'baffles, tie rods, pass partitions, saddle plates and the weld metal are not modelled',
    ],
  };
}

/** Height of the centroid of the roof plate above the shell top: cone lateral surface rise / 3, spherical cap rise / 2, flat plate t / 2. */
function roofCentroidHeight(template: TankTemplate): number {
  const rise = roofRise(template);
  if (template.roof.type === 'cone') return rise / 3;
  if (template.roof.type === 'dome') return rise / 2;
  return template.roof.thickness / 2;
}

/**
 * Centre of gravity of a tank: courses at mid-height, bottom plate at mid-thickness, roof plate at the centroid of its surface, liquid at mid-level.
 * @param scale metres per document unit
 */
export function tankCog(scale: number, template: TankTemplate, nozzleLumps: readonly CogPart[]): VesselCog {
  const mass = tankMass(scale, template);
  const base = tankBase(template);
  const bottoms = courseBottoms(template);
  const metal = mass.parts.map((part): CogPart => {
    if (part.part === 'bottom') return { part: part.part, kg: part.kg, at: [0, 0, base / 2] };
    if (part.part === 'roof')
      return { part: part.part, kg: part.kg, at: [0, 0, base + template.shellHeight + roofCentroidHeight(template)] };
    const index = Number(part.part.replace('course ', '')) - 1;
    return { part: part.part, kg: part.kg, at: [0, 0, base + (bottoms[index] as number) + (template.courses[index] as number) / 2] };
  });
  const empty = [...metal, ...nozzleLumps];
  const liquid = (part: string, level: number, kgPerM3: number): CogPart => ({
    part,
    kg: tankLiquidVolume(template, level) * scale ** 3 * kgPerM3,
    at: [0, 0, base + level / 2],
  });
  const operating = [liquid('liquid design level', template.design.designLiquidLevel, template.design.specificGravity * 1000)];
  return {
    parts: empty,
    liquidParts: operating,
    empty: centreOf(empty),
    operating: centreOf([...empty, ...operating]),
    test: centreOf([...empty, liquid('liquid test water', template.shellHeight, TEST_WATER_KG_PER_M3)]),
    defaulted: [],
    approximations: [
      NOZZLE_APPROXIMATION,
      'the roof is a thin plate: a cone at one third of the rise above the eave, a dome at half the rise (Archimedes), a flat roof at mid-thickness',
      'rim angle, stiffeners, roof framing and appurtenances are not modelled',
    ],
  };
}

/**
 * Centre of gravity of a pump set from the vendor weight: one lump at the centre of the bounding box of the pump body and driver envelope boxes.
 * @invariant an approximation, not a computation: the standards give no weight distribution, so the vendor datasheet value replaces it
 */
export function pumpCog(template: PumpTemplate, weightKg: number, nozzleLumps: readonly CogPart[]): VesselCog {
  const machine = pumpLayout(template).boxes.filter((box) => box.part !== 'baseplate');
  const middle = (axis: 0 | 1 | 2): number => {
    const lows = machine.map((box) => box.center[axis] - box.size[axis] / 2);
    const highs = machine.map((box) => box.center[axis] + box.size[axis] / 2);
    return (Math.min(...lows) + Math.max(...highs)) / 2;
  };
  const set: CogPart = { part: 'pump set', kg: weightKg, at: [middle(0), middle(1), middle(2)] };
  const state = centreOf([set, ...nozzleLumps]);
  return {
    parts: [set, ...nozzleLumps],
    liquidParts: [],
    empty: state,
    operating: state,
    test: state,
    defaulted: [
      'pump centre of gravity = centre of the bounding box of the pump body and driver envelopes (no weight distribution is known)',
    ],
    approximations: [
      NOZZLE_APPROXIMATION,
      'the vendor weight is one lump; the liquid in the casing is not added to the operating or test states',
    ],
  };
}
