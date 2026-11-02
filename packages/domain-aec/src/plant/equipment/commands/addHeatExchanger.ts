import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { toMetres } from '@core/model/units';
import { exchangerVolumes, resolveExchanger } from '../geometry/exchangerFrame';
import { refuse } from '../model';
import { bundlePullLength, buildExchangerTemplate, exchangerShape } from './exchangerParams';
import { isVesselIssue } from './vesselParams';
import { commitNewEquipment, levelContext, locationParam, newEquipmentElement, placementShape } from './newEquipment';

/**
 * @affects creates 1 equipment element (plant template 'exchanger') plus derived revolutions / boxes on layer Q-EQPM tagged element:<id>
 * @invariant size / shape / weight of the element are re-derived from `plant` in the same command; ids are step-scoped (L8); the frame origin is the middle of
 *   the outside overall length on the tube axis; shell stations count from the front end of the shell; a tube wall from the BWG table is unverified
 * @failure duplicate tag, invalid TEMA type (EQP_TEMA_INVALID, path temaType.<i>), K / X / D (EQP_TEMA_UNSUPPORTED), tubes that do not fit the shell, thickness
 *   <= allowance, support not suiting a horizontal exchanger -> coded refusal with the param path
 */
export const addHeatExchanger = defineCommand({
  name: 'add_heat_exchanger',
  description:
    'Create a parametric shell-and-tube heat exchanger (equipment element with a tag) from a TEMA designation: temaType is exactly three letters, front head ' +
    '(A, B, C, N) + shell (E, F, G, H, J) + rear head (L, M, N fixed tubesheet; P, S, T, U, W removable bundle), e.g. BEM, AES, AEU. D, K and X are ' +
    'valid TEMA letters that are not modelled (EQP_TEMA_UNSUPPORTED). Horizontal only. Dimensions are INSIDE diameters in document units: shellInsideDiameter ' +
    '(channels and bonnets share it), shellThickness (nominal, corrosion allowance included), tubes { outsideDiameter, wallThickness OR bwg, count, length ' +
    '(between the outer tubesheet faces), passes, pitch (default 1.25 x OD), layoutAngleDeg (30, 45, 60, 90) }, tubesheetThickness, frontChannel { length, ' +
    'thickness } and, for L / M / N rears, rearChannel. A bonnet (front B, rear M) is a channel + 2:1 head, A / C / N / L / N are a channel + flat cover; a ' +
    'U or floating rear closes the shell with a 2:1 shell cover (floating head, U-bend, baffles, tie rods and pass partitions are not modelled). ' +
    'support: saddles { stations from the front end of the shell, width, axisElevation } or none. design { shellSide, tubeSide } carry pressure, temperature, ' +
    'material, allowable stress and joint efficiency (never defaulted) and the fluid specific gravity. The frame origin is the middle of the outside overall ' +
    'length on the tube axis; the legacy size / shape / weight are re-derived so clash checks and floor loads keep working. Next: add_nozzle with ' +
    'location { on: "shell", station, orientationDeg } or { on: "channel", channel, station, orientationDeg } (ports "<tag>:<mark>"), vessel_volume for the ' +
    'shell-side and tube-side volumes, equipment_weights, check_equipment. Returns elementId, tag, tema { front, shell, rear, fixedTubesheet, removableBundle }, ' +
    'bundlePullLength (removable bundles: tube length + 1 m, named default), shellLength, insideOverallLength, volumes, defaulted[], weightKg, angleConvention.',
  params: z.object({
    ...placementShape,
    location: locationParam('the middle of the exchanger (outside overall length), on the tube axis'),
    ...exchangerShape,
  }),
  run: (doc, params): CommandResult => {
    const context = levelContext(doc, 'add_heat_exchanger', params.levelId);
    if (!context.ok) return context.result;
    const built = buildExchangerTemplate(params, doc.units);
    if (isVesselIssue(built)) return refuse(doc, 'add_heat_exchanger', built.code, built.message, [], [built.path]);
    const created = newEquipmentElement(doc, 'add_heat_exchanger', context, params, built.template, []);
    if (!created.ok) return created.result;
    const { template } = built;
    const geometry = resolveExchanger(template);
    const volumes = exchangerVolumes(template, geometry);
    const scale = toMetres(doc, 1) ** 3;
    const pull = bundlePullLength(template, doc.units);
    const { element } = created;
    return commitNewEquipment(
      doc,
      context.building,
      element,
      `add_heat_exchanger: ${element.mark} "${element.name}" (${element.id}) TEMA ${template.temaType} (${template.tema.fixedTubesheet ? 'fixed tubesheet' : 'removable bundle'}), shell ID ${template.shellInsideDiameter} x ${geometry.shellLength}, ` +
        `${template.tubes.count} tubes, shell side ${(volumes.shellSide * scale).toFixed(4)} m3, tube side ${(volumes.tubeSide * scale).toFixed(4)} m3, ${element.weight.toFixed(1)} kg operating` +
        `${built.defaulted.length > 0 ? `; defaults: ${built.defaulted.join(', ')}` : ''}.`,
      {
        temaType: template.temaType,
        tema: template.tema,
        bundlePullLength: pull,
        shellLength: geometry.shellLength,
        insideOverallLength: geometry.insideOverallLength,
        volumes: { shellSideM3: volumes.shellSide * scale, tubeSideM3: volumes.tubeSide * scale },
        tubeWall: { value: template.tubes.wallThickness, source: template.tubes.wallSource, unverified: template.tubes.wallUnverified },
        defaulted: built.defaulted,
        notes: created.notes,
      },
      params.angleConvention ?? 'north_cw',
    );
  },
});
