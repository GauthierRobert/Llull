import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** A 2x2x2 box wrapped in component `comp-part` and instanced once at `position`. */
export function boxInstance(position: [number, number, number]): {
  doc: CadDocument;
  instanceId: string;
} {
  const part = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const component = execute(part.document, 'create_component', {
    name: 'Part',
    entityIds: [part.affected[0]!],
    componentId: 'comp-part',
  });
  const inserted = execute(component.document, 'insert_instance', {
    componentId: 'comp-part',
    position,
  });
  return { doc: inserted.document, instanceId: inserted.affected[0]! };
}
