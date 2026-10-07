/**
 * @layer ui/panels/building
 * Category labels and one-line descriptors of building elements (element list + inspector).
 */

import type { BuildingElement } from '@core/model/building';
import type { DocumentUnit } from '@core/model/types';
import { boltSize } from '@aec/industrial/evaluate';

export const CATEGORY_LABEL: Readonly<Record<BuildingElement['category'], string>> = {
  grid: 'Grid',
  wall: 'Wall',
  door: 'Door',
  window: 'Window',
  slab: 'Slab',
  column: 'Column',
  beam: 'Beam',
  stair: 'Stair',
  room: 'Room',
  member: 'Steel',
  footing: 'Footing',
  panel: 'Panel',
  equipment: 'Equipment',
  pipe: 'Pipe',
  tray: 'Tray',
  plate: 'Plate',
  curvedWall: 'Curved wall',
  connection: 'Connection',
  pipeSupport: 'Pipe support',
};

export function describe(element: BuildingElement, units: DocumentUnit): string {
  switch (element.category) {
    case 'wall':
      return `${element.material} · ${element.thickness}`;
    case 'door':
    case 'window':
      return `${element.width}×${element.height}`;
    case 'slab':
      return `${element.role} · ${element.thickness}`;
    case 'room':
      return element.name;
    case 'column':
      return `${element.shape === 'circular' ? 'Ø' : ''}${element.width}`;
    case 'beam':
      return `${element.width}×${element.depth}`;
    case 'stair':
      return `${element.riserCount} risers`;
    case 'grid':
      return 'axis';
    case 'member':
      return `${element.role} · ${element.profile}`;
    case 'footing':
      return `${element.width}×${element.length}×${element.thickness}`;
    case 'panel':
      return `${element.role} · ${element.material}`;
    case 'equipment':
      return element.name;
    case 'pipe':
      return `${element.line !== undefined ? `${element.line} · ` : ''}${element.dn !== undefined ? `DN${element.dn}` : `Ø${element.diameter}`} · ${element.service}`;
    case 'tray':
      return `${element.width}×${element.height} · ${element.system}`;
    case 'curvedWall':
      return `${element.material} · ${element.thickness}`;
    case 'connection':
      return `${element.kind} · ${2 * element.boltRows}×${boltSize({ units }, element.boltDiameter)}`;
    case 'plate':
      return `${element.length}×${element.width}×${element.thickness} · ${element.boltCount}×${boltSize({ units }, element.boltDiameter)}`;
    case 'pipeSupport':
      return `${element.type} · ${element.memberId === null ? 'unattached' : 'attached'}`;
  }
}
