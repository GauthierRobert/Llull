import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../model';
import { equipmentPorts } from '../geometry/ports';
import { buildPumpTemplate, pumpShape } from './pumpParams';
import { isVesselIssue } from './vesselParams';
import { commitNewEquipment, levelContext, locationParam, newEquipmentElement, placementShape } from './newEquipment';

/**
 * @affects creates 1 equipment element (plant template 'pump') plus derived boxes (envelope body, driver, baseplate) and two nozzle revolutions on layer Q-EQPM
 *   tagged element:<id>; the nozzles are records SUC and DIS with free locations, so ports are `<tag>:SUC` and `<tag>:DIS`
 * @invariant shaft along the equipment X, discharge vertical, suction axial toward -X, floor at z = 0, frame origin = middle of the plan bounding box; only table
 *   rows are used silently at grade A (grade B rows make the pump unverified in check_equipment); the standards give no weight
 * @failure duplicate tag, size not in the shipped table / row incomplete / neither size nor envelope (EQP_PUMP_SIZE_UNKNOWN), unknown rating or DN
 *   (EQP_RATING_UNKNOWN), custom pump without envelope or rating -> coded refusal with the param path
 */
export const addPump = defineCommand({
  name: 'add_pump',
  description:
    'Create a parametric centrifugal pump (equipment element with a tag) with its suction and discharge nozzles ready for routing. Either a shipped table row ' +
    '(standard iso_2858 + size "65-40-250", rows 50-32-160, 50-32-200, 65-40-250, 80-50-200; standard asme_b73_1 + size "AA", "AB", "A05", "A60" - the B73.1 rows ' +
    'are grade B, so the pump is unverified) or your own vendor dimensions envelope { a, f, h1, h2, suctionDn, dischargeDn, source } (ISO 2858 meaning: suction ' +
    'face a before the discharge nozzle centre, bearing frame end f after it, shaft h1 above the baseplate top, discharge face h2 above the shaft). A size that ' +
    'is not in the table and has no envelope is EQP_PUMP_SIZE_UNKNOWN. Geometry is an ENVELOPE (body box, optional driver box, baseplate), not a casing model: ' +
    'driver { length, width, height, couplingGap } and baseplate { length, width, height } are vendor data (defaults reported in defaulted). The shaft runs along the ' +
    'equipment X, the discharge nozzle is vertical, the suction nozzle axial toward -X; location is the middle of the plan bounding box. Ports: "<tag>:SUC" and ' +
    '"<tag>:DIS" (rating default PN16 for ISO, CL150 for B73.1). weightKg is the vendor weight (the standards give none). Returns elementId, tag, standard, designation (the table row), envelope ' +
    '{ a, f, h1, h2, suctionDn, dischargeDn, rating, source, grade }, unverified, ports (suctionPortId, dischargePortId), defaulted[], weightKg, angleConvention.',
  params: z.object({ ...placementShape, location: locationParam('the middle of the pump bounding box'), ...pumpShape }),
  run: (doc, params): CommandResult => {
    const context = levelContext(doc, 'add_pump', params.levelId);
    if (!context.ok) return context.result;
    const built = buildPumpTemplate(doc, params);
    if (isVesselIssue(built)) return refuse(doc, 'add_pump', built.code, built.message, [], [built.path]);
    const created = newEquipmentElement(doc, 'add_pump', context, params, built.template, built.nozzles);
    if (!created.ok) return created.result;
    const { template } = built;
    const { element } = created;
    const ports = equipmentPorts(context.building, element);
    const unverified = template.envelope.grade !== 'A' || built.nozzles.some((nozzle) => nozzle.flange.unverified);
    return commitNewEquipment(
      doc,
      context.building,
      element,
      `add_pump: ${element.mark} "${element.name}" (${element.id}) ${template.standard}${template.size === undefined ? '' : ` ${template.size}`}, suction DN${template.envelope.suctionDn} / discharge DN${template.envelope.dischargeDn} ${template.envelope.rating}, ` +
        `envelope grade ${template.envelope.grade}${unverified ? ' (unverified)' : ''}${template.weightKg === undefined ? ', no weight' : `, ${template.weightKg} kg`}` +
        `${built.defaulted.length > 0 ? `; defaults: ${built.defaulted.join(', ')}` : ''}.`,
      {
        standard: template.standard,
        designation: template.size ?? null,
        envelope: template.envelope,
        unverified,
        suctionPortId: ports.find((port) => port.mark === 'SUC')?.id ?? null,
        dischargePortId: ports.find((port) => port.mark === 'DIS')?.id ?? null,
        defaulted: built.defaulted,
        notes: created.notes,
      },
      params.angleConvention ?? 'north_cw',
    );
  },
});
