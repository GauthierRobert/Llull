/** Proteus Equipment and Nozzle -> `PidEquipment` / `PidNozzle` (plant 04 PID §6.1). */

import { xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { KNOWN_EQUIPMENT_CLASSES } from './proteusClasses';
import {
  addItem,
  baseOf,
  classify,
  diameterOf,
  dropGraphics,
  portsOf,
  readAttributes,
  register,
  tagOf,
  type ImportContext,
} from './proteusContext';

function mapNozzle(ctx: ImportContext, el: XmlElement, equipmentId: string): void {
  const read = readAttributes(ctx, el);
  const nodes = xmlChildren(el, 'ConnectionPoints').flatMap((points) => xmlChildren(points, 'Node'));
  const dn = diameterOf(read) ?? nodes.map((node) => diameterOf(readAttributes(ctx, node))).find((value) => value !== undefined);
  const subTag = read.raw.get('SubTagNameAssignmentClass') || xmlAttr(el, 'ID') || 'N';
  const base = baseOf(ctx, el, xmlAttr(el, 'ComponentClass') || 'Nozzle', read);
  const port = portsOf(ctx, el).ports[0] ?? base.at;
  const access = (xmlAttr(el, 'ComponentName') ?? '').toUpperCase().includes('MANHOLE');
  addItem(ctx, {
    ...base,
    kind: 'nozzle',
    equipmentId,
    subTag,
    port,
    ...(dn === undefined ? {} : { dn }),
    ...(access ? { access: true } : {}),
  });
  register(ctx, el, { type: 'nozzle', id: base.id });
  dropGraphics(ctx, el);
}

/** An equipment, its nozzles and (recursively) its sub-equipment. */
export function mapEquipment(ctx: ImportContext, el: XmlElement, parentId?: string): void {
  const read = readAttributes(ctx, el);
  const known = classify(ctx, el, KNOWN_EQUIPMENT_CLASSES);
  const base = baseOf(ctx, el, known.dexpiClass, read, { tag: tagOf(read), passthrough: known.passthrough });
  addItem(ctx, { ...base, kind: 'equipment', ...(parentId === undefined ? {} : { parentId }) });
  register(ctx, el, { type: 'other' });
  for (const child of xmlChildren(el)) {
    if (child.local === 'Nozzle') mapNozzle(ctx, child, base.id);
    else if (child.local === 'Equipment') mapEquipment(ctx, child, base.id);
  }
  dropGraphics(ctx, el);
}
