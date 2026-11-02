/** `vessel_volume` for the equipment forms of exchangers (shell-side and tube-side volumes) and API 650 tanks (liquid volume at levels). */

import { report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT, toMetres } from '@core/model/units';
import type { EquipmentElement } from '@aec/building/types';
import { getBuilding } from '../../../building/model';
import { exchangerVolumes, resolveExchanger } from '../geometry/exchangerFrame';
import { tankLiquidVolume } from '../geometry/tankFrame';
import { refuse } from '../model';
import type { ExchangerTemplate, TankTemplate } from '../plantData';
import { findEquipment } from './equipmentRef';

export interface VolumeRequest {
  readonly equipment?: string | undefined;
  readonly orientation?: unknown;
  readonly insideDiameter?: unknown;
  readonly tangentLength?: unknown;
  readonly heads?: unknown;
  readonly levels?: readonly number[] | undefined;
  readonly side?: 'shell' | 'tube' | undefined;
}

const INLINE_FIELDS = ['orientation', 'insideDiameter', 'tangentLength', 'heads'] as const;

function exchangerVolume(doc: CadDocument, element: EquipmentElement, template: ExchangerTemplate, request: VolumeRequest): CommandResult {
  if (request.levels !== undefined)
    return refuse(
      doc,
      'vessel_volume',
      'EQP_PARAM_INVALID',
      'levels are not built for exchangers (the bundle displaces the shell side): omit levels, read the volume of each side',
      [element.id],
      ['levels'],
    );
  const geometry = resolveExchanger(template);
  const cubic = toMetres(doc, 1) ** 3;
  const volumes = exchangerVolumes(template, geometry);
  const mm = MM_PER_UNIT[doc.units];
  const fluidSides = {
    shellSide: {
      volumeM3: volumes.shellSide * cubic,
      method: 'pi/4 Ds^2 Ls - N pi/4 do^2 Ls (+ 2:1 shell cover volume for U / floating rears)',
    },
    tubeSide: { volumeM3: volumes.tubeSide * cubic, method: 'N pi/4 di^2 Lt + channels pi/4 Ds^2 Lc + 2:1 bonnet heads pi Ds^3 / 24' },
  };
  const selected = request.side === undefined ? undefined : request.side === 'shell' ? fluidSides.shellSide : fluidSides.tubeSide;
  const data = {
    kind: 'exchanger',
    temaType: template.temaType,
    ...fluidSides,
    ...(selected === undefined ? {} : { side: request.side, totalVolumeM3: selected.volumeM3 }),
    insideOverallLength: geometry.insideOverallLength,
    insideOverallLengthMm: geometry.insideOverallLength * mm,
    shellLength: geometry.shellLength,
    assumptions: [
      'inside dimensions, ideal geometry',
      'tubes occupy their full outside diameter over the shell length; tube sheets, baffles, tie rods and pass partitions are not subtracted',
      'floating head, floating tubesheet and U-bend volumes are not included in the tube side',
      'nozzle bores are not subtracted',
    ],
    unverified: template.tubes.wallUnverified,
    sources: [template.tubes.wallSource],
  };
  return report(
    doc,
    `vessel_volume: ${element.mark} TEMA ${template.temaType}: shell side ${fluidSides.shellSide.volumeM3.toPrecision(8)} m3, tube side ${fluidSides.tubeSide.volumeM3.toPrecision(8)} m3, inside overall length ${data.insideOverallLengthMm} mm.`,
    data,
  );
}

function tankVolume(doc: CadDocument, element: EquipmentElement, template: TankTemplate, request: VolumeRequest): CommandResult {
  if (request.side !== undefined)
    return refuse(doc, 'vessel_volume', 'EQP_PARAM_INVALID', 'side applies to exchangers only', [element.id], ['side']);
  const cubic = toMetres(doc, 1) ** 3;
  const total = tankLiquidVolume(template, template.shellHeight) * cubic;
  const rows: { level: number; liquidVolumeM3: number; percent: number }[] = [];
  for (const [index, level] of (request.levels ?? []).entries()) {
    if (level > template.shellHeight * (1 + 1e-12))
      return refuse(
        doc,
        'vessel_volume',
        'EQP_LEVEL_OUT_OF_RANGE',
        `levels[${index}] = ${level} is above the shell height ${template.shellHeight}`,
        [element.id],
        [`levels.${index}`],
      );
    const volume = tankLiquidVolume(template, level) * cubic;
    rows.push({ level, liquidVolumeM3: volume, percent: (100 * volume) / total });
  }
  const operatingVolume = tankLiquidVolume(template, template.design.designLiquidLevel) * cubic;
  const data = {
    kind: 'tank',
    orientation: 'vertical',
    totalVolumeM3: total,
    insideHeight: template.shellHeight,
    levels: rows,
    operating: {
      levelAboveBottomTangent: template.design.designLiquidLevel,
      liquidVolumeM3: operatingVolume,
      percent: (100 * operatingVolume) / total,
      specificGravity: template.design.specificGravity,
      liquidMassKg: operatingVolume * template.design.specificGravity * 1000,
    },
    method: 'pi/4 D^2 h (flat bottom, vertical cylinder)',
    assumptions: [
      'inside dimensions, ideal geometry',
      'levels measured from the top of the bottom plate; the roof space above the shell and nozzle bores are not part of the volume',
    ],
    unverified: false,
    sources: [],
  };
  return report(
    doc,
    `vessel_volume: ${element.mark} tank D ${template.diameter} x ${template.shellHeight}: shell volume ${total.toPrecision(8)} m3, ${rows.length} level(s), design level ${operatingVolume.toPrecision(8)} m3.`,
    data,
  );
}

/**
 * The answer for an `equipment` that is an exchanger or a tank, or null when the request is not about one (the vessel path then handles it).
 * @failure inline geometry given with equipment -> EQP_PARAM_INVALID; levels on an exchanger, side on a tank, level above the shell -> EQP_PARAM_INVALID /
 *   EQP_LEVEL_OUT_OF_RANGE
 */
export function otherEquipmentVolume(doc: CadDocument, request: VolumeRequest): CommandResult | null {
  if (request.equipment === undefined) return null;
  const element = findEquipment(getBuilding(doc), request.equipment);
  const template = element?.plant?.template;
  if (element === undefined || (template?.kind !== 'exchanger' && template?.kind !== 'tank')) return null;
  const inline = INLINE_FIELDS.find((name) => request[name] !== undefined);
  if (inline !== undefined)
    return refuse(doc, 'vessel_volume', 'EQP_PARAM_INVALID', 'give equipment OR the inline geometry, not both', [element.id], [inline]);
  return template.kind === 'exchanger' ? exchangerVolume(doc, element, template, request) : tankVolume(doc, element, template, request);
}
